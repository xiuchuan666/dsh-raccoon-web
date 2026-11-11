/**
 * 积分：余额 + 流水 + 每日领取。
 *
 * **读为主，只有一个写操作：`grantDaily()`。**
 *
 * ## 关于"签到"这条判断的更正（2026-11-11）
 *
 * 这个文件头原先写着「浣熊没有独立的签到接口，每日积分是当天首次带登录态访问
 * 网页时由服务端发放的」，并据此决定"只读、不实现任何领取"。**那条判断是错的。**
 *
 * 逆向官方桌面端 `app.asar`（latin1 全量扫描，枚举出 57 个 `/api/web/...` 端点）
 * 后找到了真实的写接口：
 *
 * ```
 * POST /api/web/desktop/v1/login/points/grant      ← 无 body
 * → 200 { code: 0, data: { granted: true | false, popup: ... } }
 * ```
 *
 * E-036 实测：连续两次调用都返回 `granted:false`（当天已由官方客户端领过），
 * 说明它**幂等**，且 `granted` 本身就是"今日是否新领到"的判据。
 *
 * ## 为什么仍然先查后写
 *
 * `granted:false` 的幂等是**上游行为**，不是契约。批量签到 5 个号时，
 * 对已经领过的号再打一次写请求没有收益，只有风险。所以 `host` 层会先
 * `fetchBills()` 看今天有没有 `daily_grant` 流水，有就跳过写请求。
 * 这个判断在本文件里由 `todayGranted()` 提供。
 *
 * @module protocol/points
 */

import { GRANT_PATH, POINTS_BASE, POINTS_TIMEOUT_MS } from "./consts.js";
import { RaccoonError, isDeadSessionCode, isRateLimited } from "./errors.js";
import { webHeaders } from "./headers.js";

/** 余额。三项都可能缺 —— 上游字段名不稳定。 */
export interface RaccoonBalance {
  /** 可用总额。UI 上的大字。 */
  available: number | undefined;
  /** 永久积分。 */
  permanent: number | undefined;
  /** 每日积分。 */
  daily: number | undefined;
  /** 原始响应，调试用。 */
  raw: Record<string, unknown>;
}

/** 一条流水。只取我们关心的字段。 */
export interface RaccoonBill {
  bizType: string;
  amount: number | undefined;
  at: string | undefined;
  raw: Record<string, unknown>;
}

type FetchImpl = typeof fetch;

function num(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** 统一打点：错误分类。 */
async function authorizedGet(
  path: string,
  token: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${POINTS_BASE}${path}`, {
      method: "GET",
      headers: webHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new RaccoonError("TIMEOUT", "查询小浣熊积分超时", { cause: err });
    }
    throw new RaccoonError("TRANSPORT", `连不上小浣熊：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RaccoonError("SERVER", `小浣熊积分接口返回了无法解析的内容（HTTP ${res.status}）`, {
      status: res.status,
      upstream: text,
    });
  }

  const code = (payload as { code?: unknown } | undefined)?.code;
  if (res.status === 401 || res.status === 403 || isDeadSessionCode(code)) {
    throw new RaccoonError("AUTH", "小浣熊登录已失效", { status: res.status, upstream: text });
  }
  if (isRateLimited(res.status, text)) {
    throw new RaccoonError("RATE_LIMIT", "小浣熊限流", { status: res.status, upstream: text });
  }
  if (!res.ok) {
    throw new RaccoonError("SERVER", `小浣熊积分接口返回 HTTP ${res.status}`, { status: res.status, upstream: text });
  }
  return payload;
}

/**
 * 余额。
 *
 * 取值顺序来自实测 + sensenova 的实现：
 * `available_points` → `total_chargeable_points` → `total` → `balance` → `points`
 */
export async function fetchBalance(token: string, fetchImpl: FetchImpl = fetch): Promise<RaccoonBalance> {
  const payload = (await authorizedGet("/v1/balance", token, fetchImpl, POINTS_TIMEOUT_MS)) as {
    code?: unknown;
    data?: Record<string, unknown>;
  };
  const code = payload.code;
  if (typeof code === "number" && code !== 0) {
    throw new RaccoonError("SERVER", `小浣熊积分接口返回 code=${code}`, { upstream: JSON.stringify(payload) });
  }
  const data = payload.data ?? {};
  return {
    available: num(data, ["available_points", "availablePoints", "total_chargeable_points", "total", "balance", "points"]),
    permanent: num(data, ["reward_points", "rewardPoints", "permanent_points"]),
    daily: num(data, ["daily_points", "dailyPoints"]),
    raw: data,
  };
}

/** 流水。默认取 50 条。 */
export async function fetchBills(token: string, fetchImpl: FetchImpl = fetch, limit = 50): Promise<RaccoonBill[]> {
  const payload = (await authorizedGet(
    `/v2/bills?paging.limit=${limit}&type=all`,
    token,
    fetchImpl,
    POINTS_TIMEOUT_MS,
  )) as { code?: unknown; data?: Record<string, unknown> };
  const code = payload.code;
  if (typeof code === "number" && code !== 0) {
    throw new RaccoonError("SERVER", `小浣熊流水接口返回 code=${code}`, { upstream: JSON.stringify(payload) });
  }
  const items = payload.data?.["items"] ?? payload.data?.["list"];
  if (!Array.isArray(items)) return [];
  const out: RaccoonBill[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const bizType = typeof rec["biz_type"] === "string" ? rec["biz_type"] : "";
    const at = typeof rec["grant_at"] === "string" ? rec["grant_at"] : typeof rec["created_at"] === "string" ? rec["created_at"] : undefined;
    const amount = num(rec, ["points", "amount", "change", "value"]);
    out.push({ bizType, amount, at, raw: rec });
  }
  return out;
}

/**
 * 北京时区的 `YYYY-MM-DD`。
 *
 * 每日积分的边界是北京时间零点，不是 UTC，也不是本地时区。
 * 用 `en-CA` 是因为它的日期格式恰好是 `YYYY-MM-DD`。
 */
export function raccoonDay(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 今日有没有到账（`biz_type === "daily_grant"` 且北京时区当天）。 */
export function todayGranted(bills: readonly RaccoonBill[], now: Date = new Date()): RaccoonBill | undefined {
  const today = raccoonDay(now);
  return bills.find((b) => b.bizType === "daily_grant" && b.at !== undefined && raccoonDay(b.at) === today);
}

/** `grantDaily()` 的结果。 */
export interface GrantResult {
  /**
   * 上游说这次真的发放了。
   *
   * `false` **不是错误** —— 它表示"今天已经领过"。E-036 实测：当天已领时
   * 连续两次调用都返回 `granted:false` 且 HTTP 200。
   */
  granted: boolean;
  /** 上游原始 `data`。诊断用，也用于把 `popup` 文案透给 UI。 */
  raw: Record<string, unknown>;
}

/**
 * 领取今日积分。
 *
 * ```
 * POST /api/web/desktop/v1/login/points/grant     ← 无 body
 * → { code: 0, data: { granted: boolean, popup: ... } }
 * ```
 *
 * ## 三个必须记住的点
 *
 * 1. **路径前缀是 `desktop/v1`，不是 `points/v1`。** 它挂在桌面端登录域下，
 *    不在积分域下。按"积分都在 POINTS_BASE 下"去猜会 404。
 * 2. **不带 body。** 官方客户端就是空 POST（E-036 的 asar 原文）。
 * 3. **它是写操作。** 调用方应当先用 `fetchBills()` + `todayGranted()` 判断，
 *    已领过就不要再发 —— 幂等是上游行为，不是契约。
 */
export async function grantDaily(token: string, fetchImpl: FetchImpl = fetch): Promise<GrantResult> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(GRANT_PATH, {
      method: "POST",
      headers: webHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(POINTS_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new RaccoonError("TIMEOUT", "领取小浣熊每日积分超时", { cause: err });
    }
    throw new RaccoonError("TRANSPORT", `连不上小浣熊：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RaccoonError("SERVER", `小浣熊领取接口返回了无法解析的内容（HTTP ${res.status}）`, {
      status: res.status,
      upstream: text,
    });
  }

  const body = (payload ?? {}) as { code?: unknown; message?: unknown; data?: Record<string, unknown> };
  const code = body.code;
  if (res.status === 401 || res.status === 403 || isDeadSessionCode(code)) {
    throw new RaccoonError("AUTH", "小浣熊登录已失效", { status: res.status, upstream: text });
  }
  if (isRateLimited(res.status, text)) {
    throw new RaccoonError("RATE_LIMIT", "小浣熊限流", { status: res.status, upstream: text });
  }
  if (!res.ok) {
    throw new RaccoonError("SERVER", `小浣熊领取接口返回 HTTP ${res.status}`, { status: res.status, upstream: text });
  }
  // `code !== 0` 才算失败。**`granted: false` 不是失败**，见上方注释。
  if (typeof code === "number" && code !== 0) {
    const message = typeof body.message === "string" ? body.message : `code=${code}`;
    throw new RaccoonError("SERVER", `小浣熊领取接口返回 ${message}`, { upstream: text });
  }

  const data = body.data ?? {};
  return { granted: data["granted"] === true, raw: data };
}
