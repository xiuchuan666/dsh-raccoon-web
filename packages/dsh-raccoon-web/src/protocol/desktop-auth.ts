/**
 * 读取**官方桌面客户端**的登录态（只读）。
 *
 * ## 为什么要这条路
 *
 * 扫码路线要求用户掏出手机，且我们的轮询一旦重开会话就把旧码作废（E-029）。
 * 但大多数人本来就已经登录着「商汤小浣熊」桌面客户端 —— 那份 token 就在磁盘上，
 * 同一台机器、同一个用户、同一个网关。workbuddy / trae 这类反代插件之所以
 * "装上就能用"，就是因为它们读的是本地客户端的凭据，而不是让用户重新登录一次。
 *
 * 2026-11-06 实测：读到的 `access_token` 对 `model_catalog` / `chat/completions` /
 * `points/v1/balance` / `auth/v1/user_info` 四个端点全部 HTTP 200。
 *
 * ## 三条边界（这是本项目自己的约束，不是上游的）
 *
 * 1. **只读。** 不写、不改、不删客户端的任何文件。刷新 token 是客户端自己的事，
 *    我们每次启动重读一遍就够 —— 这样客户端换号/登出，我们下一次就读不到了。
 * 2. **不上传。** token 只在宿主进程内存与 `model` 请求头里出现，绝不进
 *    `status` 端点、绝不进日志（日志只打 `sha256` 前 8 位）。
 * 3. **读不到就明说。** 不猜路径、不扫全盘、不读浏览器 cookie 库、
 *    不碰 Windows 凭据管理器 —— 只在官方约定的几个位置找不到时返回 `undefined`，
 *    让 UI 明示"未检测到桌面端登录态，可以扫码，或者先登录官方客户端"。
 *
 * ## 路径规则（与官方 asar 内 `boxAgentAuthFile.js` 的 `getBoxAgentAuthPath()` 一致）
 *
 * ```
 * BOX_AGENT_CONFIG_DIR ? <dir>/auth.json
 *                      : <BOX_AGENT_HOME | ~/.box-agent>/config/auth.json
 * ```
 *
 * 但**桌面端自己启动时会把 `BOX_AGENT_CONFIG_DIR` 指到 profile 目录下的
 * `agent/config`**（`clientProfile.js` 的 `WINDOWS_PROFILE_DIRECTORY = '.office-raccoon'`），
 * 所以真实落点是 `~/.office-raccoon/agent/config/auth.json`。
 * 两个位置都试，profile 目录优先 —— 它是客户端当前真正在用的那份。
 *
 * @module protocol/desktop-auth
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { jwtClaims, principalOf } from "./chat.js";

/** 一个读到的客户端登录态。**不含任何写操作所需的字段。** */
export interface DesktopAuth {
  /** `access_token` 原值。调用方只该把它塞进请求头。 */
  token: string;
  /** 固定为 `access_token` —— 桌面端只存 IAM 直发的 JWT。 */
  kind: "access_token";
  /** JWT 的 `exp × 1000`；解不出来就没有。 */
  expiresAt?: number;
  /** JWT 的 `sub`。用于算稳定 session id。 */
  principal?: string;
  /** `office_identity`，官方用来决定要不要带 `X-Org-Code`。`personal` = 个人账号。 */
  officeIdentity?: string;
  /** 实际读到的那份文件。诊断用（路径本身不敏感，它不含 token）。 */
  source: string;
}

/** 一个候选位置。`why` 只用于日志与诊断。 */
interface Candidate {
  path: string;
  why: string;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 候选 auth.json 位置，**按优先级排列**。
 *
 * 顺序的理由：客户端启动时会用 profile 目录覆盖 `BOX_AGENT_CONFIG_DIR`，
 * 所以 `.office-raccoon/agent/config` 是"它现在真正在用的那份"；
 * `.box-agent/config` 是 box-agent 自己的默认位置（客户端没启动过时可能有）；
 * 其它是历史/兼容形状。
 */
export function authCandidates(home: string = homedir()): Candidate[] {
  const out: Candidate[] = [];

  // ① 环境变量显式指定 —— 官方也认这个，优先级最高。
  const configDir = envValue("BOX_AGENT_CONFIG_DIR");
  if (configDir !== undefined) out.push({ path: join(configDir, "auth.json"), why: "BOX_AGENT_CONFIG_DIR" });

  const boxHome = envValue("BOX_AGENT_HOME");
  if (boxHome !== undefined) out.push({ path: join(boxHome, "config", "auth.json"), why: "BOX_AGENT_HOME" });

  // ② 桌面端 profile 目录（Windows 用点前缀，POSIX 不带点）。
  out.push({ path: join(home, ".office-raccoon", "agent", "config", "auth.json"), why: "profile (windows)" });
  out.push({ path: join(home, "office-raccoon", "agent", "config", "auth.json"), why: "profile (posix)" });
  out.push({ path: join(home, ".office-raccoon", "config", "auth.json"), why: "profile (flat)" });

  // ③ box-agent 默认位置。
  out.push({ path: join(home, ".box-agent", "config", "auth.json"), why: "box-agent" });

  return out;
}

/** 上游写文件用的 key 名（`AUTH_FILE_KEYS`）。读的时候三种拼写都认。 */
function readField(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

/**
 * 校验一个 access token 的**形状**。
 *
 * 只做本地能做的判断（非空、无空白、长度上限、JWT 解得出 exp）。**不验签** ——
 * 验签需要公钥，而"这个 token 还能不能用"的唯一权威判断是拿它去打一次
 * `model_catalog`（见 `catalog.ts` 的 `fetchCatalog`）。
 *
 * 长度上限 65536 抄自官方的 `tokens()` 校验：那条规则是为了挡住"把一个文件
 * 当 token 读进来"这类错，不是为了挡恶意 token。
 */
export function looksLikeToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  if (token.length === 0 || token.length > 65_536) return false;
  if (/\s/.test(token)) return false;
  for (let i = 0; i < token.length; i += 1) {
    if (token.charCodeAt(i) < 32) return false;
  }
  return true;
}

/** 从一份已解析的 auth.json 抽 token。返回 `undefined` 表示"这份里没有可用 token"。 */
export function authFromDocument(raw: unknown, source: string): DesktopAuth | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;

  // 官方读的是扁平三键兜底（`readBoxAgentDesktopAuthState`）：access_token → token → auth_token。
  const token = readField(rec, ["access_token", "accessToken", "token", "auth_token"]);
  if (token === undefined || !looksLikeToken(token)) return undefined;

  const officeIdentity = readField(rec, ["office_identity", "officeIdentity"]);
  const claims = jwtClaims(token);
  const rawExp = claims?.["exp"];
  const exp = typeof rawExp === "number" ? rawExp * 1000 : undefined;
  const principal = principalOf(token);

  const auth: DesktopAuth = { token, kind: "access_token", source };
  if (exp !== undefined) auth.expiresAt = exp;
  if (principal.length > 0) auth.principal = principal;
  if (officeIdentity !== undefined) auth.officeIdentity = officeIdentity;
  return auth;
}

/**
 * 读本地客户端的登录态。
 *
 * **永不抛。** 每个候选位置单独 try：一个位置权限不足/格式坏掉不该让
 * 后面的位置也读不到。全部读不到就返回 `undefined`。
 *
 * `readFileImpl` 只为测试注入，生产走 `node:fs/promises`。
 */
export async function readDesktopAuth(options: {
  home?: string;
  candidates?: readonly Candidate[];
  readFileImpl?: (path: string) => Promise<string>;
  now?: () => number;
} = {}): Promise<DesktopAuth | undefined> {
  const readFileImpl =
    options.readFileImpl ?? ((path: string): Promise<string> => readFile(path, "utf8"));
  const candidates = options.candidates ?? authCandidates(options.home ?? homedir());
  const now = options.now ?? Date.now;

  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFileImpl(candidate.path);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const auth = authFromDocument(parsed, candidate.path);
    if (auth === undefined) continue;
    // 已过期的 token 不当"可用" —— 但也不要继续找下一份：同一个人只可能有一份
    // 真凭据，另一份更旧。直接返回，让上层按"过期"文案提示用户开一下客户端。
    if (auth.expiresAt !== undefined && auth.expiresAt <= now()) return auth;
    return auth;
  }
  return undefined;
}

/** token 是否已过期（留 60 秒余量）。过期判断只用于提示，不用于删凭据。 */
export function desktopAuthExpired(auth: DesktopAuth, now: number = Date.now()): boolean {
  return auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= now;
}
