/**
 * 把 profile 的 cordis.patch.yml 里那条 insert 的 `name` 换成**带版本查询串的绝对
 * file URL**，让运行中的 DSH 立刻重新 import 我们的 lib/index.js。
 *
 * 为什么需要它（2026-11-06 实测，E-030）：
 *
 * - 直接覆盖 `lib/index.js` 不会热更。`touch cordis.patch.yml` 也不行。
 * - 宿主的插件解析走 `@deepseek-ai/cordis-plugin-loader` 的
 *   `Entry.import(name)`（`lib/index.js:214-227`）：有 internal loader 时
 *   `this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})`，没有时裸
 *   `import(name)`。**`name` 写绝对 `file://` URL 是被支持的**。
 * - 而 `loader.internal` 按 specifier 缓存模块 —— 裸包名每次都命中同一份旧模块。
 *   加 `?v=<时间戳>` 就是一个新 specifier，于是它真的会重新读盘。
 * - dshmarket 自己的热挂载（`lib/hot.js` 的 `hotMount`）也这么干：把 insert 行
 *   写成 `name: '<resolveProfileEntry(...)>'`，即绝对路径。
 *
 * 副作用与边界：
 * - 改完 profile 的 cordis.patch.yml 会被 dsh 自己重写成它规范化后的形状（引号、
 *   缩进可能变），这是正常的，不必惊讶。
 * - 卸载走 `scripts/unlink.mjs`，它按 `llm-raccoon-web` 这个 id 认，不看 name。
 *
 * 用法：
 *   node scripts/revive.mjs                 # 用当前时间戳做版本号
 *   node scripts/revive.mjs --tag 1305      # 指定版本号（便于对照 build）
 *   node scripts/revive.mjs --dry           # 只看会写成什么
 *   node scripts/revive.mjs --restore       # 还原成裸包名（下次启动才会重载）
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const RESTORE = argv.includes("--restore");
const tagIndex = argv.indexOf("--tag");
const profileIndex = argv.indexOf("--profile");
const TAG =
  tagIndex >= 0 && argv[tagIndex + 1] !== undefined
    ? argv[tagIndex + 1]
    : String(Date.now()).slice(-6);

// 必须用 fileURLToPath 而不是读 URL.pathname：工作区路径含中文，
// pathname 是百分号编码的（%E5%B0%8F...），existsSync 会判成不存在。
const REPO = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(REPO, "packages", "dsh-raccoon-web", "lib", "index.js");
const PROFILE_DIR =
  profileIndex >= 0 && argv[profileIndex + 1] !== undefined
    ? argv[profileIndex + 1]
    : join(homedir(), ".dsh", "profiles", "desktop");
const PATCH_PATH = join(PROFILE_DIR, "cordis.patch.yml");

function log(message) {
  console.log(`[revive] ${message}`);
}

if (!existsSync(PATCH_PATH)) {
  console.error(`[revive] ✗ 没有找到 ${PATCH_PATH}`);
  console.error("        先用 node scripts/link.mjs 把插件链进 profile。");
  process.exit(1);
}
if (!existsSync(ENTRY)) {
  console.error(`[revive] ✗ 没有找到 ${ENTRY}`);
  console.error("        先跑 pnpm build。");
  process.exit(1);
}

const source = await readFile(PATCH_PATH, "utf8");

/**
 * 匹配我们那条 insert 的 `name` 行（整行替换，保留 id 与缩进）。
 *
 * 只认 `llm-raccoon-web` 这一段上下文里的 name —— 不能全局替换 `name:`，
 * profile 里还有二十来个别的插件。
 */
const BLOCK_RE = /(- id:\s*llm-raccoon-web\s*\r?\n\s*name:\s*)("[^"]*"|'[^']*'|[^\r\n]+)/;

if (!BLOCK_RE.test(source)) {
  console.error("[revive] ✗ cordis.patch.yml 里没有 llm-raccoon-web 那条 insert");
  console.error("        先用 node scripts/link.mjs。");
  process.exit(1);
}

const nextValue = RESTORE
  ? "dsh-raccoon-web"
  : `"${pathToFileURL(ENTRY).href}?v=${TAG}"`;

const next = source.replace(BLOCK_RE, (_match, prefix) => `${prefix}${nextValue}`);

if (next === source) {
  log("已经就是目标形状，什么都没改");
  process.exit(0);
}

if (DRY) {
  log(`--dry：会把 name 改成`);
  log(`  ${nextValue}`);
  process.exit(0);
}

await writeFile(PATCH_PATH, next, "utf8");
log(`name → ${nextValue}`);
log(
  RESTORE
    ? "已还原成裸包名：下次启动 DSH 才会加载新代码"
    : `宿主应在几秒内重新 import（入口 ${relative(REPO, ENTRY)}）`,
);
log("验证：curl -s http://127.0.0.1:57292/plugins/dsh-raccoon-web/status | grep -o '\"build\":\"[^\"]*\"'");
