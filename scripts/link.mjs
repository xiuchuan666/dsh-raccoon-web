#!/usr/bin/env node
/**
 * link.mjs — 把 packages/dsh-raccoon-web 链进 DSH desktop profile
 *
 * 做四件事：
 *   1. profile package.json 的 dependencies 里加 link: 条目
 *   2. dsh.profile.bundles 里加 "dsh-raccoon-web"
 *   3. cordis.patch.yml 里插入一条 insert（幂等：已有就改成当前版本）
 *   4. 在 profile/node_modules 里建目录联接（Windows）或符号链接
 *
 * ## 为什么 insert 的 `name` 写 file URL 而不是裸包名
 *
 * 裸包名（`name: dsh-raccoon-web`）只在**进程启动**时被解析一次：之后改了
 * `lib/index.js`，运行中的宿主不会重新 import，只能重启（`touch cordis.patch.yml`
 * 也不触发）。写成带查询串的绝对 `file://` URL 后，每次改 `?v=` 都会让
 * `Entry.import()` 拿到一个"新模块"，几秒内热更（2026-11-06 实测，见 E-031）。
 *
 * 这不是野路子：`dshmarket/lib/hot.js` 的 `hotMount()` 就是这么写的 ——
 * `ctx.plugin(HotTree, { path: pathToFileURL(file).href })`。宿主侧的
 * `Entry.import()`（`@deepseek-ai/cordis-plugin-loader`）对 file URL 是一等支持。
 *
 * 幂等：重复跑不会产生重复条目。
 *
 * 用法：
 *   node scripts/link.mjs
 *   node scripts/link.mjs --profile <profileName>   # 默认 desktop
 *   node scripts/link.mjs --dry                     # 只打印将要做的事
 */

import { readFile, writeFile, mkdir, symlink, lstat, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PKG_DIR = join(ROOT, "packages", "dsh-raccoon-web");
const PKG_NAME = "dsh-raccoon-web";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx >= 0 ? argv[profileIdx + 1] : "desktop";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);

const log = (...a) => console.log("[link]", ...a);
const warn = (...a) => console.warn("[link] ⚠", ...a);

function die(msg) {
  console.error("[link] ✗", msg);
  process.exit(1);
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function writeJson(p, v) {
  await writeFile(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

// ---------------------------------------------------------------- 前置检查

if (!existsSync(PKG_DIR)) die(`包目录不存在: ${PKG_DIR}`);
if (!existsSync(PROFILE_DIR)) die(`profile 目录不存在: ${PROFILE_DIR}`);

const pkgJsonPath = join(PKG_DIR, "package.json");
if (!existsSync(pkgJsonPath)) die(`包的 package.json 不存在: ${pkgJsonPath}`);

const builtEntry = join(PKG_DIR, "lib", "index.js");
if (!existsSync(builtEntry)) {
  warn("lib/index.js 不存在，先跑 pnpm -w run build；仍然继续（link 后再 build 也行）");
}
const clientFile = join(PKG_DIR, "lib", "client.js");
if (!existsSync(clientFile) && !existsSync(join(PKG_DIR, "client.js"))) {
  warn("client.js 不存在，界面半身不会加载");
}

// ---------------------------------------------------------------- 1) dependencies

const profilePkgPath = join(PROFILE_DIR, "package.json");
const profilePkg = await readJson(profilePkgPath);

profilePkg.dependencies ||= {};
const wantSpec = `link:${PKG_DIR.replaceAll("\\", "/")}`;
const haveSpec = profilePkg.dependencies[PKG_NAME];

if (haveSpec === wantSpec) {
  log(`dependencies 已就绪: ${PKG_NAME} → ${wantSpec}`);
} else {
  log(`dependencies: ${PKG_NAME} ${haveSpec ? `(${haveSpec} →) ` : ""}${wantSpec}`);
  profilePkg.dependencies[PKG_NAME] = wantSpec;
  if (!DRY) await writeJson(profilePkgPath, profilePkg);
}

// ---------------------------------------------------------------- 2) bundles

profilePkg.dsh ||= {};
profilePkg.dsh.profile ||= {};
profilePkg.dsh.profile.bundles ||= [];

if (profilePkg.dsh.profile.bundles.includes(PKG_NAME)) {
  log(`bundles 已包含 ${PKG_NAME}`);
} else {
  profilePkg.dsh.profile.bundles.push(PKG_NAME);
  log(`bundles += ${PKG_NAME}`);
  if (!DRY) await writeJson(profilePkgPath, profilePkg);
}

// ---------------------------------------------------------------- 3) cordis.patch.yml

const patchPath = join(PROFILE_DIR, "cordis.patch.yml");
let patch = existsSync(patchPath) ? await readFile(patchPath, "utf8") : "# Your patch layer for this dsh profile.\n";

/**
 * 写进 insert 的 `name`。
 *
 * 用**带版本查询串的绝对 file URL**，不是裸包名 —— 理由见文件头。
 * `?v=` 取 `lib/index.js` 的 mtime，于是每次 build 完重跑 link 都会换 URL，
 * 运行中的宿主跟着热更（不必重启）。
 */
const ENTRY = (() => {
  const lib = join(PKG_DIR, "lib", "index.js");
  const mtime = existsSync(lib) ? Math.round(statSync(lib).mtimeMs) : 0;
  const url = pathToFileURL(lib);
  url.searchParams.set("v", String(mtime));
  return url.href;
})();

/** 我们那一条 insert 的正则：id + 紧随其后的 name（可能带引号）。 */
const BLOCK_RE = /(- id:\s*llm-raccoon-web\s*\r?\n\s*name:\s*)("[^"]*"|'[^']*'|[^\r\n]+)/;

if (BLOCK_RE.test(patch)) {
  const before = patch.match(BLOCK_RE)[2];
  if (before === `"${ENTRY}"`) {
    log(`cordis.patch.yml 已是最新 entry（?v=${new URL(ENTRY).searchParams.get("v")}）`);
  } else {
    log("cordis.patch.yml entry 换成本次构建的 file URL");
    patch = patch.replace(BLOCK_RE, `$1"${ENTRY}"`);
    if (!DRY) await writeFile(patchPath, patch, "utf8");
  }
} else if (/(^|\n)\s*-\s*id:\s*llm-raccoon-web\b/.test(patch)) {
  // 有条目但没有 name 行（理论上不会出现）：补一行。
  log("cordis.patch.yml 条目缺 name，补上");
  patch = patch.replace(/(^|\n)(\s*-\s*id:\s*llm-raccoon-web\s*)\r?\n/, `$1$2\n      name: "${ENTRY}"\n`);
  if (!DRY) await writeFile(patchPath, patch, "utf8");
} else {
  const block = [
    "",
    "# dsh-raccoon-web：小浣熊官方客户端凭据 / 网页扫码 → DSH provider",
    "# 由 scripts/link.mjs 自动插入；卸载用 scripts/unlink.mjs",
    "# name 是带 ?v= 的 file URL：每次 build 后重跑 link 即可热更运行中的宿主，",
    "# 不必重启（裸包名只在进程启动时解析一次）。",
    "- insert:",
    "    - id: llm-raccoon-web",
    `      name: "${ENTRY}"`,
  ].join("\n");

  log(`cordis.patch.yml += insert llm-raccoon-web（?v=${new URL(ENTRY).searchParams.get("v")}）`);
  if (!DRY) {
    const next = patch.replace(/\s*$/, "\n") + block + "\n";
    await writeFile(patchPath, next, "utf8");
  }
}

// ---------------------------------------------------------------- 4) node_modules 链接

const nmDir = join(PROFILE_DIR, "node_modules");
const linkPath = join(nmDir, PKG_NAME);

async function linkExists(p) {
  try {
    const st = await lstat(p);
    return st.isSymbolicLink() || st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

if (await linkExists(linkPath)) {
  // 如果是同一条链接就跳过；不同就重建
  let same = false;
  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises");
      const target = await readlink(linkPath);
      same = resolve(dirname(linkPath), target) === resolve(PKG_DIR);
    }
  } catch { /* ignore */ }

  if (same) {
    log(`node_modules 链接已就绪: ${linkPath}`);
  } else {
    log(`node_modules 链接指向别处，重建: ${linkPath}`);
    if (!DRY) {
      await rm(linkPath, { recursive: true, force: true });
      await ensureDir(nmDir);
      await symlink(PKG_DIR, linkPath, platform() === "win32" ? "junction" : "dir");
    }
  }
} else {
  log(`创建 node_modules 链接: ${linkPath} → ${PKG_DIR}`);
  if (!DRY) {
    await ensureDir(nmDir);
    await symlink(PKG_DIR, linkPath, platform() === "win32" ? "junction" : "dir");
  }
}

// ---------------------------------------------------------------- 完成

if (DRY) {
  log("（--dry 模式，未写入任何文件）");
} else {
  log("");
  log("✓ 完成。重启 DSH 生效。");
  log(`  验证: curl http://127.0.0.1:<port>/plugins/${PKG_NAME}/status`);
  log(`  卸载: node scripts/unlink.mjs`);
}
