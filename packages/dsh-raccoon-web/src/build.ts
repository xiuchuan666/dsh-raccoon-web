/**
 * 构建标记。
 *
 * 两个常量都是**手写**的，不是从 package.json 或时间戳生成的 ——
 * 理由是两个都要能被"人"快速确认：
 *
 * - `VERSION` 与 package.json 的 version 必须一致，由 `scripts/verify-install.mjs`
 *   检查。不做运行时读取是因为 ESM 读 package.json 要用 import assertion，
 *   而 tsup 打包时会把它变成一段奇怪的代码。
 * - `BUILD` 同时出现在宿主（status 端点）与浏览器半身（`client.js`）里。
 *   两边对不上，就说明浏览器加载的是缓存的旧 client.js —— 这是排查
 *   "改了代码但界面没变"的最快判据（见 docs/04-ops/01-troubleshooting.md §2）。
 *
 * 每次改 client.js 都要改这两个文件的 BUILD（宿主 + client.js）。
 *
 * @module build
 */

/** 插件版本。必须与 packages/dsh-raccoon-web/package.json 的 version 一致。 */
export const VERSION = "0.1.0";

/** 构建标记。改 client.js 时同步改。 */
export const BUILD = "2026-11-06T15:35";
