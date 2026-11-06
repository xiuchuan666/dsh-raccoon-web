/**
 * HTTP 路由：状态快照 + 八个 action。
 *
 * ## 为什么走 HTTP 而不是别的
 *
 * 浏览器半身（`client.js`）跑在渲染进程里，拿不到宿主进程的任何对象。
 * 宿主与它之间唯一的通路是 `webServer` 上的两条路由。参考插件全部这么做
 * （minimaxcode 的 `lib/index.js:2383-2410` 是最干净的示例）。
 *
 * ## 两条安全边界
 *
 * 1. **只接受 loopback。** `isLoopback(req.headers.host)` 拦掉任何非本机来源。
 *    这条路由能让调用方触发扫码、换掉 provider、看到账号余额 —— 它不该被
 *    局域网里另一个进程碰到。
 * 2. **action 只接受 POST。** GET 会被浏览器预取、被代理缓存、被 `<img>` 触发。
 *    状态查询是幂等的所以允许 GET，改变状态的一律 POST。
 *
 * ## 为什么 action 用 `?action=` 而不是路径
 *
 * `webServer.register({kind:"exact", path})` 是精确匹配（不支持 `:param`）。
 * 想用 RESTful 路径就得注册八条路由，八条路由各自要挂 `ctx.effect`。
 * 一个 query 参数换八条路由，划算。
 *
 * @module host/routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LOGIN_TIMEOUT_MS } from "../protocol/consts.js";
import type { LoginSnapshot } from "./login-flow.js";
import type { Logger } from "./log.js";
import { tokenTag } from "./log.js";

/** 两个端点。浏览器半身的 client.js 里有一份同样的常量。 */
export const STATUS_PATH = "/plugins/dsh-raccoon-web/status";
export const ACTION_PATH = "/plugins/dsh-raccoon-web/action";

/** 一个 action 的返回值。`ok:false` 时 `error` 是给用户看的中文。 */
export interface ActionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * 是不是本机请求。
 *
 * `Host` 头在 HTTP/1.1 里是必需的吗？不是 —— 但浏览器和 `fetch` 总会带。
 * 三种 localhost 形态：`127.0.0.1:1234`、`localhost:1234`、`[::1]:1234`。
 * IPv6 的方括号必须先剥掉，否则 `split(":")[0]` 拿到的是 `[`。
 *
 * 缺失 Host 头时返回 false。这不是"保守"—— 没有 Host 的请求本来就不是
 * 浏览器发的正常请求，拒绝它不会误伤任何真实场景。
 */
export function isLoopback(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return false;
  let name = host;
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end < 0) return false;
    name = name.slice(1, end);
    return name === "::1";
  }
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  return name === "127.0.0.1" || name === "localhost";
}

/**
 * 读请求体，上限 64KB。
 *
 * 我们的 body 只有几个字段（模型 id、开关布尔），64KB 是给"将来可能加
 * 一个粘贴 token 的框"留的余量。超了直接截断 —— 不截断的话一个恶意
 * 请求就能让宿主进程吃满内存。
 */
export async function readRequestBody(req: IncomingMessage, limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 路由依赖。全部由 host/index.ts 注入。 */
export interface RoutesDeps {
  logger: Logger;
  /** 当前状态快照（含 diagnostics）。 */
  snapshot: () => Promise<unknown>;
  /** 执行一个 action。 */
  runAction: (action: string, body: Record<string, unknown>) => Promise<ActionResult>;
}

/** 一个已注册的路由句柄。 */
export interface RouteHandle {
  (): void;
}

/** 宿主 webServer 里我们用到的那一小块。 */
export interface WebServerLike {
  register(route: { kind: "exact"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): RouteHandle;
}

/**
 * 挂两条路由。
 *
 * @returns 注销函数。**必须**由调用方挂到 `ctx.effect` 上 ——
 *   卸载插件时不注销路由，重启后第二次注册会撞 409。
 */
export function registerRoutes(webServer: WebServerLike, deps: RoutesDeps): () => void {
  const disposers: RouteHandle[] = [];

  disposers.push(
    webServer.register({
      kind: "exact",
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          send(res, 403, { error: "loopback only" });
          return;
        }
        try {
          const payload = await deps.snapshot();
          send(res, 200, payload);
        } catch (error) {
          deps.logger.error("route/status-failed", { message: errText(error) });
          send(res, 500, { error: errText(error) });
        }
      },
    }),
  );

  disposers.push(
    webServer.register({
      kind: "exact",
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req.headers.host)) {
          send(res, 403, { error: "loopback only" });
          return;
        }
        if (req.method !== "POST") {
          send(res, 405, { error: "POST only" });
          return;
        }

        let action = "";
        let body: Record<string, unknown> = {};
        try {
          action = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("action") ?? "";
          const text = await readRequestBody(req);
          if (text.trim().length > 0) {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
          }
        } catch {
          // body 不是 JSON 不算错 —— 大部分 action 不需要 body。
        }

        if (action.length === 0) {
          send(res, 400, { ok: false, error: "缺少 action 参数" });
          return;
        }

        try {
          const result = await deps.runAction(action, body);
          send(res, 200, result);
        } catch (error) {
          deps.logger.error("route/action-failed", { action, message: errText(error) });
          send(res, 500, { ok: false, error: errText(error) });
        }
      },
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 已经注销过。
      }
    }
  };
}

/** 发 JSON。`Content-Type` 必带 charset —— 中文不写会在某些 devtools 里显示乱码。 */
function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // 状态里有余额，不该被任何中间层缓存。
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 登录快照 → status 里的 login 块。
 *
 * 单独拿出来是因为 tokenTag 这类"只给一部分"的规则要集中在一处：
 * status 里 principal 只给前 8 位，而日志里给的是 token 的 sha256 前 8 位 ——
 * 两个不同的东西，别混。
 */
export function loginBlock(snapshot: LoginSnapshot, token: { principal?: string; kind?: "access_token" | "xhx_token"; expiresAt?: number; source?: "qr" | "desktop" } | undefined): {
  phase: LoginSnapshot["phase"];
  qrSvg?: string;
  deadline?: number;
  message?: string;
  principal?: string;
  kind?: "access_token" | "xhx_token";
  expiresAt?: number;
  source?: "qr" | "desktop";
} {
  const out: ReturnType<typeof loginBlock> = { phase: snapshot.phase };
  if (snapshot.qrSvg !== undefined) out.qrSvg = snapshot.qrSvg;
  if (snapshot.deadline !== undefined) out.deadline = snapshot.deadline;
  if (snapshot.message !== undefined) out.message = snapshot.message;
  if (token?.principal !== undefined) out.principal = token.principal.slice(0, 8);
  if (token?.kind !== undefined) out.kind = token.kind;
  if (token?.expiresAt !== undefined) out.expiresAt = token.expiresAt;
  if (token?.source !== undefined) out.source = token.source;
  return out;
}

/** 登录整体超时（给 client 端倒计时兜底用）。 */
export const LOGIN_DEADLINE_MS = LOGIN_TIMEOUT_MS;

/** 供 log 模块之外的地方复用一个安全的 token 摘要。 */
export { tokenTag };
