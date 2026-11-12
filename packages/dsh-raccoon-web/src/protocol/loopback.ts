/**
 * 浏览器 loopback 登录（官方桌面端**换账号**时走的那一条）。
 *
 * ## 为什么需要第三条路
 *
 * 小浣熊一共三条登录路，我们先后实现了两条：
 *
 * | 路 | 取码 | 结果 |
 * | --- | --- | --- |
 * | IAM 小程序码（`iam.ts`） | `POST /api/iam/v1/auth/mp/qrcode` | 可用，但码只能被微信小程序认 |
 * | Web auth 码（`web-auth.ts`） | 本地生成 + `/login/mp?code=` | **码页面 404**，见下 |
 * | 浏览器 loopback（本文件） | `GET /authorize?...` | **可用**，官方换账号就用它 |
 *
 * 2026-11-12 实测：`GET https://xiaohuanxiong.com/login/mp?code=...` 对任何 UA
 * （微信 iPhone、微信 Windows、Chrome、curl）都返回 **404 + 9723 字节的
 * `__next_error__` 页面**；而 `login_with_qrcode_code` 对任何 code 都恒定返回
 * `{"status":"pending"}`。两者合起来的结论是：**服务端已经不再提供 `/login/mp`
 * 这个页面**，那条扫码链路在服务端侧就断了 —— 不是我们的 code 格式不对，
 * 也不是缺 UA / 缺归因（那两样 2026-11-12 已补齐，行为无变化）。
 *
 * 而官方桌面端自己换账号时根本不用扫码：它打开浏览器到 `/authorize`，
 * 用户在浏览器里正常登录（手机号 / 微信扫码都行），登录完成后浏览器重定向到
 * 客户端在本机起的一次性 HTTP 服务，客户端拿 `code` 去换 token。用户
 * 2026-11-12 描述的正是这个过程（"先在浏览器里面登录，然后浏览器再把客户端
 * 重新拉起来"）。
 *
 * ## 这条路为什么比扫码可靠
 *
 * - 浏览器里跑的是**官方网页端本体**，登录方式、风控、验证码全由它自己处理，
 *   我们不需要猜任何一步。
 * - 换 token 的端点 `login_with_authorization_code` **会校验** code
 *   （假 code → `400 {"code":200035,"message":"authorization_code_not_found_error"}`），
 *   不像 `login_with_qrcode_code` 那样无状态恒 pending。
 * - 全程不需要服务端认识我们：`/authorize` 对裸请求返回 200（实测 28550 字节，
 *   标题「客户端授权 | 商汤小浣熊」，正文「此应用希望使用你的账号登录」）。
 *
 * ## 安全边界
 *
 * - 只在 `127.0.0.1` 上 `listen(0)`（系统分配端口），不接受外部连接。
 * - `state` 是 32 字节随机数的 hex（64 字符），回调必须**逐字符相等**才认。
 * - 只接受 `GET /auth/callback`，只接受一个 `code` 参数，多余参数一律拒。
 * - 一次性：收到第一个合法回调就关服务，之后同端口不再应答。
 * - 超时（默认 5 分钟）自动关闭，不泄漏监听。
 * - **code 与 token 都不落盘、不进日志**（ADR-0011 同一条规矩）。
 *
 * @module protocol/loopback
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { ORIGIN, WEB_BASE } from "./consts.js";

/**
 * 浏览器授权页路径。
 *
 * 官方 `webLogin.js` 的 `desktopLoginUrl()` 就是 `new URL('/authorize', base)`，
 * 然后 `searchParams` 塞 `login_source=desktop` 与 `appname`。
 */
export const AUTHORIZE_PATH = "/authorize";

/**
 * 授权页上的应用名。
 *
 * 官方取值是 `` `${enterpriseName('zh')}客户端` ``，而 `enterpriseName('zh')`
 * 是 `商汤小浣熊`，拼起来就是 `商汤小浣熊客户端`。页面上会原样显示
 * 「授权 商汤小浣熊客户端」。
 */
export const AUTHORIZE_APP_NAME = "商汤小浣熊客户端";

/** 回调路径。官方 `webLoginLoopback.js` 固定 `/auth/callback`。 */
export const CALLBACK_PATH = "/auth/callback";

/** 一次性回调服务的默认存活时间。官方给 300000ms。 */
export const LOOPBACK_TIMEOUT_MS = 300_000;

/** 回调地址的长度上限（官方同款，防超长 URL 打满日志与解析）。 */
const MAX_URL_LENGTH = 8_192;

/** 授权码长度上限。 */
const MAX_CODE_LENGTH = 4_096;

/** 换 token 端点。官方 `desktopLogin.js` 的 `exchangeDesktopLoginCode()`。 */
export const EXCHANGE_PATH = `${WEB_BASE}/auth/v1/login_with_authorization_code`;

/** 一次 loopback 会话。 */
export interface LoopbackSession {
  /** 交给用户在浏览器里打开的地址。 */
  url: string;
  /** 本机回调地址，同时作为 `/authorize` 的 `redirect` 参数。 */
  redirect: string;
  /** 一次性随机 state（64 位 hex）。 */
  state: string;
  /** 实际监听的端口。 */
  port: number;
}

/** 回调结果。 */
export interface LoopbackResult {
  status: "success" | "canceled" | "expired" | "error";
  accessToken?: string;
  /**
   * 服务端一并给的 refresh token。
   *
   * **只做诊断/断言，绝不落盘**（ADR-0011）：这套凭据的 refresh 会 rotate，
   * 一 rotate 就把官方客户端踢下线，而且我们看不到"用户被踢"。
   */
  refreshToken?: string;
  message?: string;
}

/** 换 token 的结果（不含 HTTP 细节，供单测替身）。 */
export interface ExchangeResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  message?: string;
}

/**
 * 拼授权页地址。
 *
 * 参数顺序与官方一致（`login_source` → `appname` → `desktop_callback` →
 * `redirect` → `state`）。顺序不影响服务端，但一致便于对比抓包。
 */
export function authorizeUrl(input: {
  redirect: string;
  state: string;
  origin?: string;
  appName?: string;
}): string {
  const url = new URL(AUTHORIZE_PATH, input.origin ?? ORIGIN);
  url.search = "";
  url.searchParams.set("login_source", "desktop");
  url.searchParams.set("appname", input.appName ?? AUTHORIZE_APP_NAME);
  url.searchParams.set("desktop_callback", "loopback");
  url.searchParams.set("redirect", input.redirect);
  url.searchParams.set("state", input.state);
  return url.href;
}

/** 生成 state：32 字节随机数的 hex，64 个字符。 */
export function newState(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 校验一次回调请求。
 *
 * 返回 `code` 表示合法；返回 `undefined` 表示该请求不是我们要的（不合法）。
 * 单独抽出来是为了能脱离 HTTP 单测 —— 这里的判据比业务逻辑更容易写错。
 */
export function parseCallback(
  rawUrl: string | undefined,
  state: string,
): { code: string } | { reason: string } {
  if (rawUrl === undefined) return { reason: "missing url" };
  if (rawUrl.length > MAX_URL_LENGTH) return { reason: "url too long" };
  if (!rawUrl.startsWith(`${CALLBACK_PATH}?`)) return { reason: "wrong path" };

  let url: URL;
  try {
    // 用一个固定 authority 解析相对 URL：我们只关心 path 与 query。
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { reason: "unparsable url" };
  }
  if (url.pathname !== CALLBACK_PATH) return { reason: "wrong path" };
  if (url.hash !== "") return { reason: "unexpected hash" };

  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "code" && key !== "state")) return { reason: "unexpected param" };
  if (url.searchParams.getAll("state").length !== 1) return { reason: "state count" };
  if (url.searchParams.getAll("code").length !== 1) return { reason: "code count" };

  const received = url.searchParams.get("state") ?? "";
  if (!/^[a-f0-9]{64}$/.test(received)) return { reason: "state shape" };
  if (received.length !== state.length) return { reason: "state length" };
  // 定长比较，避免按前缀猜。两边长度已确认相等，`timingSafeEqual` 不会抛。
  if (!timingSafeEqual(Buffer.from(received), Buffer.from(state))) return { reason: "state mismatch" };

  const code = url.searchParams.get("code") ?? "";
  if (code.trim() === "") return { reason: "empty code" };
  if (code.length > MAX_CODE_LENGTH) return { reason: "code too long" };
  // 授权码不该含控制字符（官方同款检查）。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(code)) return { reason: "control char in code" };

  return { code: code.trim() };
}

/** 结果页 HTML。用户点完浏览器里的"确认"之后看到的就是这一页。 */
function resultPage(title: string, message: string): string {
  const esc = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) =>
      ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
    );
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6;color:#1a1a1a"><h1 style="font-size:1.25rem">${esc(message)}</h1><p style="color:#666">可以关闭此页面，回到 DSH 的「设置 → 小浣熊 → 账号池」查看结果。</p></body></html>`;
}

/**
 * 起一个一次性回调服务。
 *
 * 返回的 `wait` 会一直等到"收到合法回调 + 换 token 完成"或超时/取消。
 * `close()` 可以随时收摊（用户点了取消、插件卸载）。
 */
export async function startLoopback(input: {
  /** 换 token 的实现。默认打真网关；单测可以注入。 */
  exchange?: (code: string) => Promise<ExchangeResult>;
  /** 超时。默认 `LOOPBACK_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 外部时钟，测试用。 */
  now?: () => number;
}): Promise<{
  session: LoopbackSession;
  wait: Promise<LoopbackResult>;
  close: () => void;
}> {
  const state = newState();
  const exchange = input.exchange ?? ((code: string) => exchangeCode(code));
  const timeoutMs = input.timeoutMs ?? LOOPBACK_TIMEOUT_MS;

  let server: Server | undefined;
  let settled = false;
  let resolveWait: (result: LoopbackResult) => void = () => undefined;
  const wait = new Promise<LoopbackResult>((resolve) => {
    resolveWait = resolve;
  });

  const finish = (result: LoopbackResult, closeServer: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    if (closeServer && server !== undefined) {
      server.close();
      // 有 keep-alive 连接时 `close()` 不会立刻释放端口，这里强制掐掉。
      server.closeAllConnections?.();
    }
    resolveWait(result);
  };

  const onAbort = (): void => finish({ status: "canceled", message: "已取消浏览器登录。" }, true);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, title: string, message: string): void => {
      const body = resultPage(title, message);
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        connection: "close",
      });
      res.end(body);
    };

    if (req.method !== "GET") {
      send(403, "无效的回调", "登录回调无效，请从 DSH 重新发起。");
      return;
    }
    const parsed = parseCallback(req.url, state);
    if ("reason" in parsed) {
      send(400, "无效的回调", "登录回调无效，请从 DSH 重新发起。");
      return;
    }
    if (settled) {
      send(409, "此登录请求已处理", "这个登录请求已经处理过了。");
      return;
    }

    let result: ExchangeResult;
    try {
      result = await exchange(parsed.code);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (!result.ok || result.accessToken === undefined) {
      send(502, "登录未完成", result.message ?? "授权码换取令牌失败，请从 DSH 重试。");
      finish({ status: "error", message: result.message ?? "授权码换取令牌失败。" }, true);
      return;
    }

    send(200, "登录成功", "登录成功");
    finish(
      {
        status: "success",
        accessToken: result.accessToken,
        ...(result.refreshToken === undefined ? {} : { refreshToken: result.refreshToken }),
      },
      true,
    );
  };

  server = createServer({ maxHeaderSize: 8_192 }, (req, res) => {
    void handler(req, res);
  });
  server.maxConnections = 8;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      server?.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("无法在本机起登录回调服务。");
  }

  const port = address.port;
  const redirect = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const session: LoopbackSession = {
    url: authorizeUrl({ redirect, state }),
    redirect,
    state,
    port,
  };

  server.on("error", () => finish({ status: "error", message: "登录回调服务出错。" }, true));

  const timer = setTimeout(() => {
    finish({ status: "expired", message: "浏览器登录超时，请重新发起。" }, true);
  }, timeoutMs);
  timer.unref?.();

  if (input.signal?.aborted === true) {
    onAbort();
  } else {
    input.signal?.addEventListener("abort", onAbort, { once: true });
  }

  return { session, wait, close: () => finish({ status: "canceled", message: "已取消浏览器登录。" }, true) };
}

/**
 * 用授权码换 token。
 *
 * 端点 `POST /api/web/auth/v1/login_with_authorization_code`，body
 * `{ authorization_code }`。2026-11-12 实测：假 code → `400 code=200035`，
 * 说明它真的在校验（与 `login_with_qrcode_code` 的无状态完全不同）。
 *
 * 成功判据与官方 `desktopLogin.js` 一致：`code === 0` 且 `data.access_token`。
 * IAM token 不要求 `refresh_token`（官方只在非 IAM token 时才要求）。
 */
export async function exchangeCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(EXCHANGE_PATH, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ authorization_code: code }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, message: `HTTP ${response.status}` };
  }

  const envelope = payload as { code?: unknown; message?: unknown; data?: unknown } | null;
  const data = (envelope?.data ?? {}) as Record<string, unknown>;
  const bizCode = envelope?.code;

  if (!response.ok || (typeof bizCode === "number" && bizCode !== 0)) {
    const text = typeof envelope?.message === "string" ? envelope.message : `HTTP ${response.status}`;
    return { ok: false, message: text };
  }

  const accessToken =
    typeof data["access_token"] === "string" && data["access_token"].length > 0
      ? data["access_token"]
      : typeof data["accessToken"] === "string" && data["accessToken"].length > 0
        ? data["accessToken"]
        : undefined;
  if (accessToken === undefined) {
    return { ok: false, message: "小浣熊返回了成功，但没有带令牌。" };
  }

  const refreshToken =
    typeof data["refresh_token"] === "string" && data["refresh_token"].length > 0
      ? data["refresh_token"]
      : typeof data["refreshToken"] === "string" && data["refreshToken"].length > 0
        ? data["refreshToken"]
        : undefined;

  return { ok: true, accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) };
}
