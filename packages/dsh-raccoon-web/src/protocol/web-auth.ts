/**
 * Web auth 扫码（官方桌面端当前用的那一套）。
 *
 * ## 为什么有两套扫码
 *
 * 小浣熊的扫码登录有**两个互不兼容的命名空间**（2026-11-06 实测，见 E-030）：
 *
 * | | IAM 小程序码（`iam.ts`） | Web auth 码（本文件） |
 * | --- | --- | --- |
 * | 取码 | `POST /api/iam/v1/auth/mp/qrcode` | **本地生成**，不打网络 |
 * | code 形状 | `qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062` | `1759...`（13 位 ms）+ 32 位 hex |
 * | 二维码里的 appname | `商汤小浣熊` | `小浣熊官网` |
 * | 轮询 | `POST /api/iam/v1/auth/mp/qrcode/login` | `POST /api/web/auth/v1/login_with_qrcode_code` |
 * | 拿到的 token | 需要 `iam/confirm` 换 cookie | 直接是 `access_token`（也是 IAM JWT） |
 *
 * 把两种 code 互相喂给对方会得到 `AUTH_QRCODE_INVALID`（IAM 侧）或
 * 永久的 `pending`（Web 侧），这也是早期"扫了没反应"的排查方向之一。
 *
 * 官方客户端用的是 Web auth 码，所以这里默认也用它 —— 少一个网络请求，
 * 少一个"取码失败"的失败模式。IAM 码保留为可选（`qrProtocol: "iam"`），
 * 因为它是唯一在**微信小程序**里能被识别的那一种。
 *
 * ## 这个端点有个陷阱
 *
 * `login_with_qrcode_code` 对**任何**格式正确的 code 都返回
 * `200 {"code":0,"data":{"status":"pending"}}` —— 它无状态，`pending` 是默认值。
 * 所以**不能**用它判断"这个 code 有效"。真正的有效信号只有 `success`
 * （用户确认了）与 `expired`（服务端给了 `expired_at` 且已过）。
 *
 * @module protocol/web-auth
 */

import { randomBytes } from "node:crypto";

import { ORIGIN, WEB_BASE } from "./consts.js";

/** 二维码页面里带的 appname。与 IAM 码的 `商汤小浣熊` 不同（实测）。 */
export const WEB_QR_APP_NAME = "小浣熊官网";

/** 二维码页面路径。`/login/mp` 只能被微信打开，HTTP 直接访问一律 404。 */
export const WEB_QR_PATH = "/login/mp";

/** 一次扫码会话。 */
export interface WebQrSession {
  /** 本地生成的 code。 */
  code: string;
  /** 有效秒数。官方客户端给 300。 */
  expiresIn: number;
  /** 轮询间隔秒数。 */
  pollInterval: number;
}

/** 轮询结果。与 `iam.ts` 的 `QrPoll` 同形，方便 LoginFlow 复用同一套状态机。 */
export interface WebQrPoll {
  status: "pending" | "logging" | "success" | "canceled" | "expired" | "error";
  accessToken?: string;
  /**
   * 服务端一并给的 refresh token。
   *
   * **只做诊断/断言用，绝不落盘**（ADR-0011）：这套凭据的 refresh 会 rotate，
   * 一 rotate 就把官方客户端踢下线，而且我们看不到"用户被踢"。
   */
  refreshToken?: string;
  expiresIn?: number;
  pollInterval?: number;
  message?: string;
  /**
   * 服务端原样回的 `data.status`。
   *
   * 为什么要留一份原文：我们把不认识的 status 一律当 `pending`（上游加新状态
   * 不该让用户登录失败），可这样一来"上游回了 `blocked`"与"上游回了
   * `pending`"在 `status` 字段上完全一样，排障时无从分辨。留原文就能看出来。
   */
  rawStatus?: string;
}

/** 官方客户端的 code 形状：13 位毫秒时间戳 + 32 位小写 hex。 */
const CODE_RE = /^\d{13}[a-f0-9]{32}$/;

/**
 * 轮询时用的 UA。
 *
 * 官方网页端（`23127.*.js` 里的扫码组件）走的是浏览器 `fetch`，浏览器自己带 UA；
 * 官方桌面端走 Electron 的网络栈，也自带一个 UA。我们这里是从 Node 进程发的裸请求，
 * **默认没有 UA** —— 2026-11-12 起补上，让服务端看到的是同一个"网页客户端"。
 *
 * 值取常见的 Windows Chrome UA：我们的 code 是用网页端那套（`appname=小浣熊官网`）
 * 生成的，UA 与 code 来源保持一致，比"伪装成 Electron"更不容易被服务端按来源分流。
 */
const WEB_POLL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 官方网页端随轮询一起发的注册归因（`60488` 模块的 `$Y()`）。
 *
 * 原样照抄形状：`{ registration_source: "web", ...utm_*, referrer? }`。
 * 我们不带 utm（没有来源页），只给 `registration_source`。
 */
const WEB_ATTRIBUTION = { registration_source: "web" } as const;

/** 轮询选项。`attributed: false` 只为单测 —— 生产永远带上 UA 与归因。 */
export interface WebPollOptions {
  attributed?: boolean;
}

/** 取第一个非空字符串。用来兼容顶层 / 嵌套、camelCase / snake_case 几种令牌形状。 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 生成一个 code。
 *
 * 形状照抄官方：`${Date.now()}${randomBytes(16).toString('hex')}`。
 * 用 `randomBytes` 而不是 `Math.random` —— code 等同于"一次性口令"，
 * 可预测的 code 让别人能替你完成登录。
 */
export function generateWebCode(now: number = Date.now()): string {
  return `${now}${randomBytes(16).toString("hex")}`;
}

/** 本地起一个会话。**不发网络请求。** */
export function createWebSession(now: number = Date.now(), expiresIn = 300, pollInterval = 2): WebQrSession {
  return { code: generateWebCode(now), expiresIn, pollInterval };
}

/** 二维码内容。清掉原有 query 再拼，与 iam.ts 的 `qrContent` 保持同一种严谨。 */
export function webQrContent(session: WebQrSession, origin: string = ORIGIN): string {
  const url = new URL(WEB_QR_PATH, origin);
  url.search = "";
  url.searchParams.set("code", session.code);
  url.searchParams.set("appname", WEB_QR_APP_NAME);
  return url.href;
}

/** 判断一个字符串是不是 Web auth 形状的 code。 */
export function isWebCode(value: unknown): value is string {
  return typeof value === "string" && CODE_RE.test(value);
}

/**
 * 轮询一次。
 *
 * **网络错误返回 `pending` 而不是抛** —— 与 `iam.ts` 的 `pollQr` 同一条原则：
 * 一次抖动不能把用户的登录过程杀掉。
 */
export async function pollWebSession(
  code: string,
  fetchImpl: typeof fetch = fetch,
  options: WebPollOptions = {},
): Promise<WebQrPoll> {
  if (!isWebCode(code)) {
    return { status: "error", message: "扫码会话已失效" };
  }

  // 归因与 UA：官方网页端两者都带（见 `WEB_POLL_UA` / `WEB_ATTRIBUTION` 注释）。
  // 服务端是否真按它们绑会话，2026-11-12 还没法证伪 —— 但**带上没有代价**，
  // 而漏带是有代价的（用户实测"微信端点了确认，插件永远收不到 success"）。
  const attributed = options.attributed !== false;

  let response: Response;
  try {
    response = await fetchImpl(`${WEB_BASE}/auth/v1/login_with_qrcode_code`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(attributed ? { "user-agent": WEB_POLL_UA } : {}),
      },
      body: JSON.stringify(
        attributed ? { qrcode_code: code, registration_attribution: WEB_ATTRIBUTION } : { qrcode_code: code },
      ),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // 抖动不是失败。下一次 tick 继续问。
    return { status: "pending" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return response.ok ? { status: "pending" } : { status: "error", message: `HTTP ${response.status}` };
  }

  const envelope = payload as { code?: unknown; message?: unknown; data?: unknown } | null;
  const data = (envelope?.data ?? {}) as Record<string, unknown>;

  if (!response.ok) {
    const text = typeof envelope?.message === "string" ? envelope.message : `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      return { status: "expired", message: text };
    }
    return { status: "error", message: text };
  }

  // 业务码：0 = 成功；其它（含 200035 授权码失效）当错误。
  const code0 = envelope?.code;
  if (typeof code0 === "number" && code0 !== 0) {
    return { status: "error", message: typeof envelope?.message === "string" ? envelope.message : `code ${code0}` };
  }

  const raw = typeof data["status"] === "string" ? data["status"] : "pending";
  const expiresIn = readExpiresIn(data);

  switch (raw) {
    case "success": {
      // **令牌在 `data` 顶层**，不在 `data.tokens` 里 —— 这是 2026-11-12 用官方
      // 两份实现交叉验证出来的：网页端 `23127.*.js` 从 `data` 解构
      // `{status, expired_at, access_token, refresh_token}`；桌面端
      // `accountRequests.js` 的 `tokens(data, true)` 读的也是 `data.access_token`。
      //
      // 早先这里读的是 `data.tokens.accessToken`，于是**即使服务端回了 success，
      // 我们也一律判成"没有带令牌"** —— 用户看到的现象正是"手机点了确认，
      // 插件一点反应都没有"。三种形状都兼容，但顶层优先。
      const nested = (data["tokens"] ?? data["token"]) as Record<string, unknown> | undefined;
      const accessToken = firstString(
        data["access_token"],
        data["accessToken"],
        nested?.["access_token"],
        nested?.["accessToken"],
      );
      if (accessToken === undefined) {
        return { status: "error", message: "小浣熊返回了登录成功，但没有带令牌。" };
      }
      // `refresh_token` 一并收下但**不落盘**（ADR-0011：用了会 rotate，
      // 把官方客户端踢下线）。这里只让它出现在返回值里，供诊断/测试断言。
      const refreshToken = firstString(
        data["refresh_token"],
        data["refreshToken"],
        nested?.["refresh_token"],
        nested?.["refreshToken"],
      );
      return {
        status: "success",
        accessToken,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(expiresIn === undefined ? {} : { expiresIn }),
      };
    }
    case "logging":
      return { status: "logging", rawStatus: raw, ...(expiresIn === undefined ? {} : { expiresIn }) };
    case "canceled":
    case "cancelled":
      return { status: "canceled" };
    case "expired":
      return { status: "expired" };
    case "pending":
      return { status: "pending", rawStatus: raw, ...(expiresIn === undefined ? {} : { expiresIn }) };
    default:
      // 未知状态不杀流程：上游可能加了新状态。当作 pending 继续问。
      return { status: "pending", rawStatus: raw, ...(expiresIn === undefined ? {} : { expiresIn }) };
  }
}

/** `expired_at`（秒）→ 剩余秒数。上游给的不合法就不猜。 */
function readExpiresIn(data: Record<string, unknown>): number | undefined {
  const at = data["expired_at"] ?? data["expires_at"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return undefined;
  const left = at - Math.floor(Date.now() / 1000);
  return left > 0 ? left : 0;
}
