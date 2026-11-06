/**
 * 扫码登录：IAM 三段式。
 *
 * ① `POST /auth/mp/qrcode`         取二维码
 * ② `POST /auth/mp/qrcode/login`   轮询到 success，拿 access_token
 * ③ `POST /api/web/auth/v1/iam/confirm`  换成 xhx_token（不致命）
 *
 * 然后 `GET /api/web/llm/v2/model_catalog` 才是**唯一权威**的"这 token 能用"校验。
 *
 * 不持有状态，全部纯函数 + 注入的 fetch。
 *
 * @module protocol/iam
 */

import { IAM_BASE, IAM_TIMEOUT_MS, ORIGIN, QR_APP_NAME, WEB_BASE } from "./consts.js";
import { RaccoonError, isDeadSessionCode } from "./errors.js";
import { confirmHeaders, iamHeaders, webHeaders } from "./headers.js";

/** 一次二维码会话。 */
export interface QrSession {
  code: string;
  scanPath: string;
  expiresIn: number;
  pollInterval: number;
}

/** 轮询结果。 */
export interface QrPoll {
  status: "pending" | "logging" | "success" | "canceled" | "expired" | "error";
  accessToken?: string;
  expiresIn?: number;
  pollInterval?: number;
  message?: string;
}

type FetchImpl = typeof fetch;

/** 上游 IAM 的响应外形。 */
interface IamEnvelope<T> {
  code?: string | number;
  message?: string;
  data?: T;
}

/** `POST` 一个 IAM 端点并解开 `{code, data}`。 */
async function postIam<T>(
  path: string,
  body: unknown,
  fetchImpl: FetchImpl,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${IAM_BASE}${path}`, {
      method: "POST",
      headers: iamHeaders(),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new RaccoonError("TIMEOUT", `小浣熊登录服务 ${IAM_TIMEOUT_MS / 1000} 秒内没有响应`, { cause: err });
    }
    throw new RaccoonError("TRANSPORT", `连不上小浣熊登录服务：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  // 不截断 —— 解析路径上绝不截断（E-006 的教训）
  const text = await res.text();
  let payload: IamEnvelope<T> | undefined;
  try {
    payload = JSON.parse(text) as IamEnvelope<T>;
  } catch {
    throw new RaccoonError("SERVER", `小浣熊登录服务返回了无法解析的内容（HTTP ${res.status}）`, {
      status: res.status,
      upstream: text,
    });
  }

  const code = payload.code;
  const ok = code === "OK" || code === 0 || code === "0";
  if (!ok) {
    throw new RaccoonError("SERVER", `小浣熊登录服务返回 ${String(code ?? res.status)}`, {
      status: res.status,
      upstream: text,
    });
  }
  if (payload.data === undefined) {
    throw new RaccoonError("SERVER", "小浣熊登录服务没有返回 data", { status: res.status, upstream: text });
  }
  return payload.data;
}

/**
 * 校验 scan_path —— 防畸形。
 *
 * 上游返回的 `scan_path` 会被 `new URL(scanPath, ORIGIN)` 解析后塞进二维码。
 * 如果它变成 `//evil.com/x` 或带 `#`，二维码就会指向别处 —— 这等于把用户的
 * 微信扫码结果送到第三方。所以这里必须拒绝一切不是"本站绝对路径"的输入。
 */
export function assertScanPath(scanPath: unknown): string {
  if (typeof scanPath !== "string" || scanPath === "") {
    throw new RaccoonError("SERVER", "小浣熊登录服务没有返回 scan_path");
  }
  if (!scanPath.startsWith("/") || scanPath.startsWith("//")) {
    throw new RaccoonError("SERVER", `小浣熊返回的 scan_path 不是站内绝对路径：${scanPath}`);
  }
  if (/[\\\s#]/.test(scanPath)) {
    throw new RaccoonError("SERVER", `小浣熊返回的 scan_path 含非法字符：${scanPath}`);
  }
  let url: URL;
  try {
    url = new URL(scanPath, ORIGIN);
  } catch {
    throw new RaccoonError("SERVER", `小浣熊返回的 scan_path 无法解析：${scanPath}`);
  }
  if (url.protocol !== "https:" || url.origin !== ORIGIN || url.hash !== "") {
    throw new RaccoonError("SERVER", `小浣熊返回的 scan_path 指向了站外：${url.href}`);
  }
  return scanPath;
}

/** ① 取二维码。 */
export async function createQr(fetchImpl: FetchImpl = fetch): Promise<QrSession> {
  const data = await postIam<{
    qrcode_code?: unknown;
    scan_path?: unknown;
    expires_in?: unknown;
    poll_interval?: unknown;
  }>("/auth/mp/qrcode", {}, fetchImpl);

  const code = data.qrcode_code;
  if (typeof code !== "string" || code === "") {
    throw new RaccoonError("SERVER", "小浣熊登录服务没有返回 qrcode_code");
  }
  const scanPath = assertScanPath(data.scan_path);

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
  // 上游实测返回 300（E-001）。允许 1–3600，超范围说明协议变了。
  if (!(expiresIn > 0 && expiresIn <= 3600)) {
    throw new RaccoonError("SERVER", `小浣熊返回的 expires_in 不合理：${String(data.expires_in)}`);
  }
  const pollInterval = typeof data.poll_interval === "number" && data.poll_interval > 0 ? data.poll_interval : 2;

  return { code, scanPath, expiresIn, pollInterval };
}

/**
 * ② 拼二维码内容。
 *
 * 实测 149 字节（E-007）：
 * `https://xiaohuanxiong.com/login/mp?code=qr-...&appname=%E5%95%86%E6%B1%A4...&source=platform`
 *
 * `search` 先清空 —— 上游的 scan_path 目前不带 query，但如果哪天带了，
 * 我们也不能让它的参数和我们的混在一起。
 */
export function qrContent(session: QrSession): string {
  const url = new URL(session.scanPath, ORIGIN);
  url.search = "";
  url.searchParams.set("code", session.code);
  url.searchParams.set("appname", QR_APP_NAME);
  url.searchParams.set("source", "platform");
  return url.href;
}

/** 上游错误码 → 我们的判定。 */
const QR_EXPIRED_CODES = new Set(["AUTH_QRCODE_EXPIRED", "AUTH_QRCODE_NOT_FOUND"]);

/** 网络类错误码：**不能让它们杀掉登录流程**，网络抖动是常态。 */
const QR_TRANSIENT_CODES = new Set(["NETWORK_ERROR", "TIMEOUT"]);

/**
 * ③ 轮询一次。
 *
 * 关键：**NETWORK_ERROR / TIMEOUT 必须返回 pending，不能抛**。
 * 参考实现踩过这个坑 —— 用户在地铁里抖了一下就要重新扫码。
 */
export async function pollQr(code: string, fetchImpl: FetchImpl = fetch): Promise<QrPoll> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${IAM_BASE}/auth/mp/qrcode/login`, {
      method: "POST",
      headers: iamHeaders(),
      body: JSON.stringify({ qrcode_code: code }),
      redirect: "error",
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    // 网络抖动：继续等，别把登录搞死
    return { status: "pending" };
  }

  let payload: { code?: unknown; message?: unknown; data?: Record<string, unknown> } | undefined;
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    // 网关偶尔返回 HTML（502 页面）。这也不是致命错误。
    return { status: "pending", message: "网关返回了非 JSON 响应，继续等待" };
  }

  const rawCode = typeof payload?.code === "string" ? payload.code : String(payload?.code ?? "");
  if (QR_EXPIRED_CODES.has(rawCode)) return { status: "expired" };
  if (QR_TRANSIENT_CODES.has(rawCode)) return { status: "pending" };

  const notOk = !(rawCode === "OK" || rawCode === "0" || rawCode === "undefined" && false);
  if (notOk && rawCode !== "") {
    // 其它业务错误：报告但不终止（可能是临时的）
    return { status: "error", message: typeof payload?.message === "string" ? payload.message : rawCode };
  }

  const data = payload?.data ?? {};
  const status = data["status"];
  const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : undefined;
  const pollInterval = typeof data["poll_interval"] === "number" ? data["poll_interval"] : undefined;

  if (status === "success") {
    const accessToken = data["access_token"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new RaccoonError("SERVER", "小浣熊说登录成功但没有返回 access_token", { upstream: text });
    }
    const tokenType = data["token_type"];
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new RaccoonError("SERVER", `小浣熊返回了不支持的 token_type：${tokenType}`, { upstream: text });
    }
    return { status: "success", accessToken, expiresIn, pollInterval };
  }
  if (status === "canceled") return { status: "canceled", message: "已在手机上取消登录" };
  // pending / logging / 未知状态统一按 pending 处理：宁可多等，不要误判
  return {
    status: status === "logging" ? "logging" : "pending",
    ...(expiresIn === undefined ? {} : { expiresIn }),
    ...(pollInterval === undefined ? {} : { pollInterval }),
  };
}

/** 从 Set-Cookie 里抠出某个 cookie 值。 */
export function cookieValue(setCookies: readonly string[], matches: (name: string) => boolean): string | undefined {
  for (const raw of setCookies) {
    const first = raw.split(";")[0];
    if (first === undefined) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    if (!matches(name)) continue;
    let value = first.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * ④ 换业务 cookie（xhx_token）。
 *
 * **失败不致命**：这一步只是把 IAM 的 access_token 换成 web 侧的 cookie。
 * 有些账号/区域可能压根不需要它。所以这里 catch 掉一切，返回 undefined，
 * 由调用方以 `model_catalog` 探测结果为准定生死。
 */
export async function confirmSession(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${WEB_BASE}/auth/v1/iam/confirm`, {
      method: "POST",
      headers: confirmHeaders(accessToken),
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    // Node 18+ 的 undici 有 getSetCookie()；没有就退回 get("set-cookie")
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const list =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (headers.get("set-cookie") ?? "").split(/,(?=[^;]+?=)/).filter(Boolean);
    return cookieValue(list, (name) => name === "xhx_token" || name.endsWith("xhx_token"));
  } catch {
    return undefined;
  }
}

/**
 * ⑤ 唯一权威校验：这个 token 现在能不能用。
 *
 * 判据：HTTP ok + `data.categories` 是数组。
 * **不接受**"HTTP 200 就算成功" —— 网关在没有权限时也返回 200 + 空 data。
 */
export async function validateToken(token: string, fetchImpl: FetchImpl = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${WEB_BASE}/llm/v2/model_catalog`, {
      method: "GET",
      headers: webHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      if (isDeadSessionCode(code)) return false;
      return false;
    }
    const text = await res.text();
    const payload = JSON.parse(text) as { code?: unknown; data?: { categories?: unknown } };
    if (typeof payload.code === "number" && payload.code !== 0) return false;
    return Array.isArray(payload.data?.categories);
  } catch {
    return false;
  }
}
