#!/usr/bin/env node
/**
 * copy-client.mjs — 把手写的 client.js 复制到 lib/
 *
 * 为什么需要这一步：
 *   - client.js 是 **classic script**（不能有 import/export），所以它不能进 tsup 的
 *     打包流程（tsup 会把它当 ESM 处理）。
 *   - 但 `exports["./client"]` 指向 `lib/client.js`，所以产物必须落在 lib/ 里。
 *   - tsup 的 `clean: true` 每次都会清空 lib/，所以必须由 `onSuccess` 钩子在构建后复制。
 *
 * 顺带做一次静态检查：如果 client.js 里出现了 import/export 语句，直接失败，
 * 避免"构建通过但界面不加载"这种最难查的问题（见 docs/02-design/05-error-model.md）。
 */

import { copyFile, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = HERE.replace(/[\\/]scripts$/, "") + "/packages/dsh-raccoon-web";

const SRC = join(PKG_DIR, "client.js");
const DEST_DIR = join(PKG_DIR, "lib");
const DEST = join(DEST_DIR, "client.js");

if (!existsSync(SRC)) {
  console.error("[copy-client] ✗ client.js 不存在:", SRC);
  process.exit(1);
}

const text = await readFile(SRC, "utf8");

// 只看前 60 行，避免误伤字符串里的 "import" 单词
const head = text.split("\n").slice(0, 60);
const badLine = head.findIndex((l) => /^\s*(import|export)\s/.test(l));
if (badLine >= 0) {
  console.error(`[copy-client] ✗ client.js 第 ${badLine + 1} 行有 import/export —— classic script 不允许`);
  process.exit(1);
}

if (!text.includes("__ModuleLoader__")) {
  console.error("[copy-client] ✗ client.js 里找不到 __ModuleLoader__");
  process.exit(1);
}

await mkdir(DEST_DIR, { recursive: true });
await copyFile(SRC, DEST);

const st = await stat(DEST);
const kb = (st.size / 1024).toFixed(1);
const build = text.match(/(?:const|var|let)\s+BUILD\s*=\s*["']([^"']+)["']/)?.[1] ?? "(未声明)";

console.log(`[copy-client] ✓ lib/client.js  ${kb} KB  build=${build}`);
