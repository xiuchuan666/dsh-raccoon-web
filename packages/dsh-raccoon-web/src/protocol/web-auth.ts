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
  expiresIn?: number;
  pollInterval?: number;
  message?: string;
}

/** 官方客户端的 code 形状：13 位毫秒时间戳 + 32 位小写 hex。 */
const CODE_RE = /^\d{13}[a-f0-9]{32}$/;

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
export async function pollWebSession(code: string, fetchImpl: typeof fetch = fetch): Promise<WebQrPoll> {
  if (!isWebCode(code)) {
    return { status: "error", message: "扫码会话已失效" };
  }

  let response: Response;
  try {
    response = await fetchImpl(`${WEB_BASE}/auth/v1/login_with_qrcode_code`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ qrcode_code: code }),
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
      const tokens = data["tokens"] as Record<string, unknown> | undefined;
      const accessToken = tokens?.["accessToken"] ?? tokens?.["access_token"];
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        return { status: "error", message: "小浣熊返回了登录成功，但没有带令牌。" };
      }
      return { status: "success", accessToken, ...(expiresIn === undefined ? {} : { expiresIn }) };
    }
    case "logging":
      return { status: "logging", ...(expiresIn === undefined ? {} : { expiresIn }) };
    case "canceled":
    case "cancelled":
      return { status: "canceled" };
    case "expired":
      return { status: "expired" };
    case "pending":
      return { status: "pending", ...(expiresIn === undefined ? {} : { expiresIn }) };
    default:
      // 未知状态不杀流程：上游可能加了新状态。当作 pending 继续问。
      return { status: "pending", ...(expiresIn === undefined ? {} : { expiresIn }) };
  }
}

/** `expired_at`（秒）→ 剩余秒数。上游给的不合法就不猜。 */
function readExpiresIn(data: Record<string, unknown>): number | undefined {
  const at = data["expired_at"] ?? data["expires_at"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return undefined;
  const left = at - Math.floor(Date.now() / 1000);
  return left > 0 ? left : 0;
}
