/**
 * 号池：多账号存储、选号、测量。
 *
 * 决策见 [ADR-0010](../02-design/adr/0010-account-pool.md)，实现契约见
 * [07-account-pool](../02-design/07-account-pool.md)。这个文件只负责**数据与算法**，
 * 不碰 HTTP、不碰 pi-ai、不碰登录流程 —— 那三件事在 `host/index.ts` 与
 * `provider/adapter.ts` 里。
 *
 * ## 四个必须记住的约束
 *
 * 1. **`accounts.json` 里是明文 token。** 与 `token.json` 同级（`0600`），
 *    但账号越多这个文件越值钱。**任何情况下不进 status 快照、不进日志。**
 * 2. **新加入的账号 `enabled === false`。** 加入 ≠ 入池。用户勾上它才参与
 *    自动换号与批量签到 —— 号池会花掉账号的积分，这必须是显式动作。
 * 3. **`measure` 落盘、`quota` 不落盘。** 冷却时间跨进程仍然成立（重启后
 *    一个被限流的号不该立刻又被选中）；余额读数 10 分钟就过期，落盘只会
 *    在下次启动时提供一个假的新鲜度。
 * 4. **排序的五条规则顺序即优先级。** 特别是"日更积分先花"必须在
 *    "余额高者优先"之前 —— 见 `sortForUse()` 的注释。
 *
 * @module host/pool
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { POOL_COOL_FLAKY_MS, POOL_COOL_LIMITED_MS, POOL_DEVICE_PREFIX, POOL_FILE, POOL_QUOTA_FRESH_MS } from "../protocol/consts.js";
import { raccoonDay } from "../protocol/points.js";
import { dataDir, readJson, writeJson } from "./store.js";

/**
 * 一次测量的结果。
 *
 * `ok` 是"成功过"，不是"一直可用"—— 它只用于清掉上一次的冷却。
 */
export type PoolState = "ok" | "limited" | "empty" | "dead" | "flaky";

/** 一次失败/成功的观测。**落盘**。 */
export interface PoolMeasure {
  state: PoolState;
  /** epoch ms。 */
  at: number;
  /**
   * 冷却解除时刻。`undefined` 或 `0` = 不在冷却。
   *
   * `dead` 用 `Number.MAX_SAFE_INTEGER` —— 凭据被拒不可能是暂时现象，
   * 自动重试只会反复失败，必须手动"测试"或重新扫码才能回池。
   */
  until?: number;
  /** 给人看的一句话。UI 直接显示，不翻译。 */
  note?: string;
  /** 上游给的重置时间原文。有就照它算 `until`，没有才用兜底常量。 */
  resetHint?: string;
}

/** 一个池内账号。**含明文 token，永远不进 status 快照。** */
export interface PoolAccount {
  /** 稳定 id = `sha256(principal).slice(0,16)`。同一账号重复加入不会产生第二条。 */
  id: string;
  /** 用户可改的显示名。空则 UI 用 `principal` 前 8 位。 */
  label?: string;
  /** 明文 access token。 */
  token: string;
  kind: "access_token" | "xhx_token";
  /** JWT 的 `sub`。用于算 session id 与显示。 */
  principal: string;
  /** JWT 的 `exp × 1000`。 */
  expiresAt?: number;
  /** epoch ms。 */
  addedAt: number;
  /** **是否参与自动换号与批量签到。** 新加入的一律 `false`。 */
  enabled: boolean;
  /**
   * 这个账号的设备身份（`raccoon-` + 32 hex）。
   *
   * 加入时生成，此后终身不变 —— 上游要的是"同一账号每次带同一个 install ID"
   * （E-038）。每次请求随机化正好破坏这个契约，比共用还糟。
   */
  deviceId: string;
  /** 从哪来的。 */
  source: "qr" | "desktop";
  /** 最近一次测量。观测，不是草稿。 */
  measure?: PoolMeasure;
}

/** 余额读数缓存。**不落盘**，进程内存里 10 分钟有效。 */
export interface PoolQuota {
  available?: number;
  daily?: number;
  permanent?: number;
  /** epoch ms。 */
  at: number;
}

/** `accounts.json` 的顶层结构。 */
export interface PoolDocument {
  schemaVersion: 1;
  accounts: PoolAccount[];
}

/** 账号 id：principal 的 sha256 前 16 位。 */
export function poolAccountId(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 16);
}

/** 生成一个新的设备身份。 */
export function newDeviceId(): string {
  return `${POOL_DEVICE_PREFIX}${randomBytes(16).toString("hex")}`;
}

/** `accounts.json` 的绝对路径。 */
export function poolFile(): string {
  return join(dataDir(), POOL_FILE);
}

/**
 * 读号池。文件不存在 / 损坏 / schemaVersion 不认识 → 空池，**永不抛**。
 *
 * 单行坏掉只跳过那一行，不做"整表作废" —— 一个账号的 token 是空的
 * 不该让另外四个号也消失。
 */
export async function readPool(): Promise<PoolAccount[]> {
  const raw = (await readJson(poolFile())) as Partial<PoolDocument> | undefined;
  if (raw === undefined) return [];
  if (raw.schemaVersion !== 1) return [];
  if (!Array.isArray(raw.accounts)) return [];
  const out: PoolAccount[] = [];
  const seen = new Set<string>();
  for (const item of raw.accounts) {
    const account = normalizeAccount(item);
    if (account === undefined) continue;
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    out.push(account);
  }
  return out;
}

/** 单行归一化。缺关键字段就丢掉这一行。 */
function normalizeAccount(input: unknown): PoolAccount | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const token = rec["token"];
  if (typeof token !== "string" || token.length === 0) return undefined;
  const principal = rec["principal"];
  if (typeof principal !== "string" || principal.length === 0) return undefined;
  const kind = rec["kind"];
  const deviceId = rec["deviceId"];
  const source = rec["source"];
  return {
    id: typeof rec["id"] === "string" && rec["id"].length > 0 ? rec["id"] : poolAccountId(principal),
    ...(typeof rec["label"] === "string" ? { label: rec["label"] } : {}),
    token,
    kind: kind === "xhx_token" ? "xhx_token" : "access_token",
    principal,
    ...(typeof rec["expiresAt"] === "number" ? { expiresAt: rec["expiresAt"] } : {}),
    addedAt: typeof rec["addedAt"] === "number" ? rec["addedAt"] : 0,
    // **缺失时一律 false**：号池会花积分，读不出"用户勾过"就当没勾。
    enabled: rec["enabled"] === true,
    // 旧文件没有 deviceId → 补一个。补出来的就是它此后的固定身份。
    deviceId: typeof deviceId === "string" && deviceId.length > 0 ? deviceId : newDeviceId(),
    source: source === "desktop" ? "desktop" : "qr",
    ...(normalizeMeasure(rec["measure"]) === undefined ? {} : { measure: normalizeMeasure(rec["measure"]) }),
  };
}

function normalizeMeasure(input: unknown): PoolMeasure | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const state = rec["state"];
  if (state !== "ok" && state !== "limited" && state !== "empty" && state !== "dead" && state !== "flaky") {
    return undefined;
  }
  return {
    state,
    at: typeof rec["at"] === "number" ? rec["at"] : 0,
    ...(typeof rec["until"] === "number" ? { until: rec["until"] } : {}),
    ...(typeof rec["note"] === "string" ? { note: rec["note"] } : {}),
    ...(typeof rec["resetHint"] === "string" ? { resetHint: rec["resetHint"] } : {}),
  };
}

/** 写号池。失败向上抛（调用方要告诉用户"没存上"）。 */
export async function writePool(accounts: readonly PoolAccount[]): Promise<void> {
  const doc: PoolDocument = { schemaVersion: 1, accounts: [...accounts] };
  await writeJson(poolFile(), doc);
}

/**
 * 加入或更新一个账号，返回新的整表。
 *
 * 同一个 principal 第二次加入时：**保留原来的 `deviceId`、`enabled`、`measure`**，
 * 只更新 token / expiresAt / label（如果传了）。这条很重要 —— 重新扫码
 * 换 token 不该让账号"变成一个新号"（那样冷却记录和勾选状态全丢）。
 */
export function upsertAccount(
  accounts: readonly PoolAccount[],
  input: {
    token: string;
    kind: "access_token" | "xhx_token";
    principal: string;
    expiresAt?: number;
    label?: string;
    source: "qr" | "desktop";
    now: number;
  },
): PoolAccount[] {
  const id = poolAccountId(input.principal);
  const existing = accounts.find((a) => a.id === id);
  const next: PoolAccount = {
    id,
    ...(input.label !== undefined ? { label: input.label } : existing?.label === undefined ? {} : { label: existing.label }),
    token: input.token,
    kind: input.kind,
    principal: input.principal,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    addedAt: existing?.addedAt ?? input.now,
    // 新号默认不入池；老号保留用户的勾选。
    enabled: existing?.enabled ?? false,
    deviceId: existing?.deviceId ?? newDeviceId(),
    source: existing?.source ?? input.source,
    ...(existing?.measure === undefined ? {} : { measure: existing.measure }),
  };
  const others = accounts.filter((a) => a.id !== id);
  return [...others, next];
}

/** 该账号是否在冷却中。`dead` 的 `until` 是 `MAX_SAFE_INTEGER`，永远算冷却。 */
export function isCooling(account: PoolAccount, now: number): boolean {
  const until = account.measure?.until;
  if (until === undefined) return false;
  return until > now;
}

/**
 * 这次测量值不值得落盘。
 *
 * `accounts.json` 是**整表原子写**，里面是明文 token。`recordMeasure()` 挂在
 * 每个响应的 `onResponse` 上 —— 如果每轮对话都重写一遍，等于每说一句话就把
 * 所有账号的 token 往磁盘刷一次，还会把日志刷成 `pool/measure ok` 的海洋。
 *
 * 规则只有一条：**`ok` 之后又是 `ok` 就不写。** 其它情况都要写：
 *
 * - 从没测过 → `ok`：这是"首次确认可用"，要留痕；
 * - 任何冷却态 → `ok`：这是解除冷却的唯一记录，丢了会让号白躺；
 * - 任何 → 非 `ok`：冷却必须立刻落盘，否则重启后又会被选中。
 *
 * 注意这里比较的是 `state` 而不是整个 `measure`：`at` 每次都会变，
 * 拿它比较等于没比较。
 */
export function shouldPersistMeasure(previous: PoolMeasure | undefined, next: PoolMeasure): boolean {
  if (next.state !== "ok") return true;
  return previous?.state !== "ok";
}

/**
 * 选号排序。**五条规则，顺序即优先级。**
 *
 * ```
 * ① 未冷却的排前面；都在冷却 → until 升序（最早解锁的先试）
 * ② daily 降序      —— 日更积分不花就作废，必须比"余额多"更重要
 * ③ available 降序  —— 只在读数新鲜（10 分钟内）时参与
 * ④ expiresAt 降序  —— 少一次重新扫码
 * ⑤ id 升序         —— 保证全序可复现，不依赖 Map 迭代顺序
 * ```
 *
 * ## 为什么 ② 在 ③ 之前
 *
 * 这是 workbuddy issue #70 的教训：它原本把"快过期先花"排在"余额高"之后
 * 做严格字典序比较，结果"快过期优先"**实际从未生效** —— 两个账号的余额
 * 几乎从不恰好相等，第二层比较永远轮不到。真实病例是一个账号 196.4 分
 * 在当天作废。
 *
 * 代价是"临期 1 分会排到余额 5 万前面"。这是刻意的：那 1 分是**确定损失**，
 * 而余额 5 万只是"还很多"。
 *
 * ## 为什么 ③ 要"新鲜读数"
 *
 * 排序不能为了排序去打上游。余额读数来自 `refreshQuota()` 的缓存与
 * 签到/测试动作的顺带刷新；超过 10 分钟就当"未知"，不参与比较。
 *
 * @param quota 账号 id → 余额读数
 */
export function sortForUse(
  accounts: readonly PoolAccount[],
  quota: ReadonlyMap<string, PoolQuota>,
  now: number,
): PoolAccount[] {
  const fresh = (id: string): PoolQuota | undefined => {
    const q = quota.get(id);
    if (q === undefined) return undefined;
    if (now - q.at > POOL_QUOTA_FRESH_MS) return undefined;
    return q;
  };
  const untilOf = (a: PoolAccount): number => a.measure?.until ?? 0;
  const rank = (a: PoolAccount): number => (isCooling(a, now) ? 1 : 0);

  return [...accounts].sort((x, y) => {
    // ① 冷却
    const rx = rank(x);
    const ry = rank(y);
    if (rx !== ry) return rx - ry;
    if (rx === 1) {
      const ux = untilOf(x);
      const uy = untilOf(y);
      if (ux !== uy) return ux - uy;
    }
    // ② 日更积分降序
    const qx = fresh(x.id);
    const qy = fresh(y.id);
    const dx = qx?.daily ?? -1;
    const dy = qy?.daily ?? -1;
    if (dx !== dy) return dy - dx;
    // ③ 可用余额降序
    const ax = qx?.available ?? -1;
    const ay = qy?.available ?? -1;
    if (ax !== ay) return ay - ax;
    // ④ 凭据更晚过期优先
    const ex = x.expiresAt ?? 0;
    const ey = y.expiresAt ?? 0;
    if (ex !== ey) return ey - ex;
    // ⑤ id 升序，全序可复现
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

/** 一次响应观测的分类输入。 */
export interface MeasureInput {
  /** HTTP 状态码。拿不到（网络错）时传 `0`。 */
  status: number;
  /** 响应体文本。可能为空 —— `onResponse` 钩子拿不到 body。 */
  bodyText?: string;
  /** 已知的错误 kind（来自 `RaccoonError` 或 `classifyPiAiError`）。优先于 status。 */
  kind?: "TIMEOUT" | "TRANSPORT" | "AUTH" | "RATE_LIMIT" | "SERVER" | "EMPTY_RESPONSE";
  /** epoch ms。 */
  now: number;
}

/**
 * 把一次观测翻译成 `PoolMeasure`。
 *
 * 返回 `undefined` 表示**不记** —— 这个区分很重要：
 *
 * - **HTTP 400 不记。** 请求本身不合法，与账号无关。记了会把好号一个个
 *   标成坏的，而且下一个请求会换到一个同样会 400 的号上，白白闲置。
 * - **流中途断开不记。** 字节已经发给客户端了，换号重放会让用户看到
 *   两段拼接的回答。这条在 pi-ai 通路上自然满足（retry 只在流建立前），
 *   但写下来避免以后有人"优化"成重放。
 */
export function classifyMeasure(input: MeasureInput): PoolMeasure | undefined {
  const { status, bodyText, kind, now } = input;
  const body = bodyText ?? "";

  // 已知 kind 优先：它来自我们自己的错误分类，比裸状态码准。
  if (kind === "AUTH") {
    return { state: "dead", at: now, until: Number.MAX_SAFE_INTEGER, note: "登录已失效，需要重新扫码" };
  }
  if (kind === "RATE_LIMIT") {
    return {
      state: "limited",
      at: now,
      until: now + POOL_COOL_LIMITED_MS,
      note: "被限流",
      resetHint: resetHintOf(body),
    };
  }
  if (kind === "TIMEOUT" || kind === "TRANSPORT") {
    return { state: "flaky", at: now, until: now + POOL_COOL_FLAKY_MS, note: "网络或超时" };
  }
  if (kind === "EMPTY_RESPONSE") {
    // 空响应既可能是网关抖动也可能是账号问题。按抖动处理（会自动回池），
    // 但不影响排序里的"日更积分先花"—— 因为 `flaky` 仍然可参与选择。
    return { state: "flaky", at: now, until: now + POOL_COOL_FLAKY_MS, note: "空响应" };
  }

  if (status === 0) {
    return { state: "flaky", at: now, until: now + POOL_COOL_FLAKY_MS, note: "网络或超时" };
  }
  if (status === 200) {
    return { state: "ok", at: now, note: "正常" };
  }
  if (status === 401 || status === 403) {
    return { state: "dead", at: now, until: Number.MAX_SAFE_INTEGER, note: "登录已失效，需要重新扫码" };
  }
  if (status === 429 || body.includes("200429")) {
    return {
      state: "limited",
      at: now,
      until: now + POOL_COOL_LIMITED_MS,
      note: "被限流",
      resetHint: resetHintOf(body),
    };
  }
  if (status === 402 || looksEmpty(body)) {
    return { state: "empty", at: now, until: nextRaccoonMidnight(now), note: "余额不足" };
  }
  if (status >= 500) {
    return { state: "flaky", at: now, until: now + POOL_COOL_FLAKY_MS, note: `网关 ${status}` };
  }
  // 其它（含 400）→ 不记。
  return undefined;
}

/** 余额不足的文案特征。上游文案不稳定，多给几个。 */
function looksEmpty(body: string): boolean {
  return /余额不足|积分不足|insufficient|no credit|quota exceeded|out of points/i.test(body);
}

/** 从响应体里抠上游给的重置时间，只用于诊断显示，不参与 `until` 计算。 */
function resetHintOf(body: string): string | undefined {
  const m = /"?reset[_-]?(?:at|time|after)"?\s*[:=]\s*"?([0-9T:+\-. Z]{4,40})"?/i.exec(body);
  return m?.[1]?.trim();
}

/** 下一个北京时区零点（epoch ms）。每日积分的刷新点。 */
export function nextRaccoonMidnight(now: number): number {
  // 从"当前北京日期 + 1 天"的 00:00 反推。用固定 +08:00 偏移而不是
  // Intl：中国不实行夏令时，偏移恒定，算起来比格式化再解析可靠。
  const OFFSET_MS = 8 * 60 * 60_000;
  const shifted = now + OFFSET_MS;
  const dayMs = 24 * 60 * 60_000;
  const dayStart = Math.floor(shifted / dayMs) * dayMs;
  return dayStart + dayMs - OFFSET_MS;
}

/** 今天的北京日期，用于 UI 显示"上次签到"。 */
export function todayKey(now: number): string {
  return raccoonDay(now);
}

/** 摘要：给诊断块那一行用。 */
export function poolSummary(accounts: readonly PoolAccount[], activeId: string | undefined, enabled: boolean): string {
  if (!enabled) return "关";
  const usable = accounts.filter((a) => a.enabled).length;
  if (accounts.length === 0) return "开（池空）";
  if (usable === 0) return `开（${accounts.length} 个账号，0 个启用）`;
  const active = activeId === undefined ? "未选中" : activeId.slice(0, 8);
  return `开（${usable} 个启用，当前 ${active}）`;
}
