/**
 * token 与实测结果的落盘。
 *
 * ## 存哪
 *
 * `$DSH_HOME/state/<plugin>/` —— 与 sensenova 的位置一致（`stateDir()` 见
 * `dsh-connect-sensenova-token-plan/lib/index.js:1491-1502`）。用 `DSH_HOME`
 * 环境变量优先，否则 `~/.dsh`。**不按 profile 分段**：登录是"这台机器上
 * 这个人"的事实，两个 profile 各扫一次码没有意义。
 *
 * ## 三个设计约束
 *
 * 1. **原子写**：先写 `.tmp` 再 `rename`。`rename` 在同分区上是原子的，
 *    所以读到的文件要么是旧版要么是新版，永远不会是写了一半的 JSON。
 *    temp 名里带 pid + 时间 + 随机串 —— 两个宿主进程（desktop + web）
 *    同时读同一个状态目录时，固定的 temp 名会让彼此的写互相覆盖。
 * 2. **读永不抛**：文件不存在、损坏、schemaVersion 不认识 → 返回 `undefined`。
 *    token 读失败不该让整个插件加载失败。
 * 3. **本地判过期不删 token**：本地时钟不准是常态（尤其是改了时区的机器）。
 *    只有服务端明确回 401 / 200003 才真删。见 docs/02-design/03-state-and-storage.md。
 *
 * @module host/store
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

import { DATA_DIR, PROVIDER_ID } from "../protocol/consts.js";

/** token 文件的结构。`schemaVersion` 不匹配就当没有 —— 不写迁移代码。 */
export interface StoredToken {
  schemaVersion: 1;
  /** access_token（IAM 发的 JWT）。 */
  token: string;
  /** `access_token` = IAM 直发；`xhx_token` = iam/confirm 换到的业务 cookie。 */
  kind: "access_token" | "xhx_token";
  /** epoch ms。 */
  savedAt: number;
  /** JWT 的 exp × 1000；本地解析不出来就不写。 */
  expiresAt?: number;
  /** JWT sub，用于算稳定的 session id。 */
  principal?: string;
  /** 账号展示信息（昵称之类）。目前上游没给，留空。 */
  account?: string;
  /**
   * 这份 token 从哪来。
   *
   * - `qr`：用户在本插件里扫码换来的（我们自己落盘）。
   * - `desktop`：从官方桌面客户端的 `auth.json` 读来的（**我们不落盘**，
   *   只放内存；见 `protocol/desktop-auth.ts` 的三条边界）。
   *
   * 字段可选是为了让旧文件（没有这个键）继续读得出来，当作 `qr`。
   */
  source?: "qr" | "desktop";
}

/** 一条识图实测结论。 */
export interface VisionProbe {
  modelId: string;
  supported: boolean;
  /** epoch ms。 */
  at: number;
  /** 模型原话摘要，最长 60 字。排障用。 */
  note?: string;
}

/** 数据目录里的两个文件名。 */
const TOKEN_FILE = "token.json";
const PROBE_FILE = "vision-probe.json";

/** `$DSH_HOME`，否则 `~/.dsh`。 */
export function dshHome(): string {
  const fromEnv = process.env["DSH_HOME"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), ".dsh");
}

/**
 * 本插件的数据目录：`$DSH_HOME/state/dsh-raccoon-web/`。
 *
 * 目录名用**包名**而不是 `DATA_DIR`（`raccoon-web`）—— 前者与插件在
 * 设置页里的身份一致，后者太泛，`state/raccoon-web` 会让人以为是谁的
 * 通用目录。`DATA_DIR` 留给将来需要按 provider 分家的场景。
 */
export function dataDir(): string {
  return join(dshHome(), "state", PROVIDER_ID === "raccoon-web" ? "dsh-raccoon-web" : DATA_DIR);
}

/**
 * 一个不会与别的进程/同进程并发写撞车的临时路径。
 *
 * 三段后缀各管一件事：
 * - `pid`：区分桌面端与 web 端的两个宿主进程；
 * - `now`：区分同一进程里隔了一会儿的两次写；
 * - `randomUUID().slice(0,8)`：区分同一毫秒内的两次写。**少了这段，
 *   同一 tick 里的两次写会让第二次 `writeFile` 截断第一次还没 rename 的 temp。**
 */
function temporaryOf(dir: string, base: string): string {
  const rand = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
  return join(dir, `${base}.${process.pid}.${Date.now()}.${rand}.tmp`);
}

/** 建目录（0700）。Windows 上 mode 会被忽略，这里只是尽力而为。 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * 原子写一个 JSON 文件。
 *
 * 失败**向上抛**：调用方决定"写不进去"是不是致命。token 写失败要告诉用户
 * （否则扫码成功但重启就没了），probe 写失败则无所谓。
 */
async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = dirname(file);
  await ensureDir(dir);
  const temp = temporaryOf(dir, basename(file));
  try {
    await writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** 读一个 JSON 文件。不存在 / 损坏 / 非对象 → `undefined`，**永不抛**。 */
async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读 token。
 *
 * 三个"当没有"的情形：文件不存在、JSON 坏了、`schemaVersion !== 1`。
 * 第三种是给未来留的：真做了 v2，旧代码读到新文件时应该当作未登录，
 * 而不是把新结构硬当旧的读。
 */
export async function readToken(): Promise<StoredToken | undefined> {
  const raw = (await readJson(join(dataDir(), TOKEN_FILE))) as Partial<StoredToken> | undefined;
  if (raw === undefined) return undefined;
  if (raw.schemaVersion !== 1) return undefined;
  if (typeof raw.token !== "string" || raw.token.length === 0) return undefined;
  if (raw.kind !== "access_token" && raw.kind !== "xhx_token") return undefined;
  if (typeof raw.savedAt !== "number") return undefined;
  return {
    schemaVersion: 1,
    token: raw.token,
    kind: raw.kind,
    savedAt: raw.savedAt,
    ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
    ...(typeof raw.principal === "string" ? { principal: raw.principal } : {}),
    ...(typeof raw.account === "string" ? { account: raw.account } : {}),
  };
}

/** 写 token。失败向上抛。 */
export async function saveToken(token: StoredToken): Promise<void> {
  await writeJson(join(dataDir(), TOKEN_FILE), token);
}

/**
 * 删 token。
 *
 * 不存在也算成功 —— 调用方（退出登录、收到 200003）不该关心"本来有没有"。
 */
export async function clearToken(): Promise<void> {
  await unlink(join(dataDir(), TOKEN_FILE)).catch(() => undefined);
}

/**
 * 读识图实测表。
 *
 * 返回 Map 是因为 roster 需要 `Map.get(modelId)`。损坏的行直接跳过，
 * 不做"整表作废" —— 一行坏掉不该让别的模型的白名单也失效。
 */
export async function readProbes(): Promise<Map<string, VisionProbe>> {
  const raw = await readJson(join(dataDir(), PROBE_FILE));
  const out = new Map<string, VisionProbe>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Partial<VisionProbe>;
    if (typeof rec.modelId !== "string" || rec.modelId.length === 0) continue;
    if (typeof rec.supported !== "boolean") continue;
    out.set(rec.modelId, {
      modelId: rec.modelId,
      supported: rec.supported,
      at: typeof rec.at === "number" ? rec.at : 0,
      ...(typeof rec.note === "string" ? { note: rec.note } : {}),
    });
  }
  return out;
}

/**
 * 写识图实测表。
 *
 * 全量覆盖而不是逐条合并：调用方手里已经有完整 Map，逐条合并会让"删掉一条
 * 错误结论"变得不可能（删了又被旧数据合回来）。
 */
export async function saveProbes(probes: ReadonlyMap<string, VisionProbe>): Promise<void> {
  await writeJson(join(dataDir(), PROBE_FILE), [...probes.values()]);
}

/** 写入探针的一条结论并落盘，返回新的 Map。 */
export async function recordProbe(probe: VisionProbe): Promise<Map<string, VisionProbe>> {
  const probes = await readProbes();
  probes.set(probe.modelId, probe);
  await saveProbes(probes);
  return probes;
}
