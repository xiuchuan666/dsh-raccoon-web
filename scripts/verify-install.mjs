#!/usr/bin/env node
/**
 * verify-install.mjs — 发布前自检：包结构、元数据、client.js、内核可解析性
 *
 * 用法：node scripts/verify-install.mjs
 * 退出码：0 全绿 / 1 有失败项
 *
 * 这份脚本不依赖网络。它是"装了会不会炸"的静态检查。
 */

import { readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.replace(/[\\/]scripts$/, "");
const PKG_DIR = join(ROOT, "packages", "dsh-raccoon-web");
const PKG_NAME = "dsh-raccoon-web";

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function ok(msg) { return { ok: true, msg }; }
function bad(msg) { return { ok: false, msg }; }

const exists = (p) => existsSync(p);

// ---------------------------------------------------------------- 1) 基本文件

check("package.json 存在", async () => {
  const p = join(PKG_DIR, "package.json");
  return exists(p) ? ok(p) : bad(`缺少 ${p}`);
});

check("lib/index.js 存在（已构建）", async () =>
  exists(join(PKG_DIR, "lib", "index.js")) ? ok("lib/index.js") : bad("缺少 lib/index.js —— 先跑 pnpm -w run build"));

check("client.js 存在", async () => {
  for (const p of [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")]) {
    if (exists(p)) return ok(p);
  }
  return bad("client.js 与 lib/client.js 都不存在");
});

check("cordis.patch.yml 存在", async () =>
  exists(join(PKG_DIR, "cordis.patch.yml")) ? ok("cordis.patch.yml") : bad("缺少 cordis.patch.yml"));

// ---------------------------------------------------------------- 2) 元数据

let pkg;
check("package.json 可解析且合法", async () => {
  try {
    pkg = JSON.parse(await readFile(join(PKG_DIR, "package.json"), "utf8"));
  } catch (e) {
    return bad(`解析失败: ${e.message}`);
  }
  const errs = [];
  if (pkg.name !== PKG_NAME) errs.push(`name 应为 ${PKG_NAME}，实际 ${pkg.name}`);
  if (!pkg.version) errs.push("缺 version");
  if (pkg.type !== "module") errs.push("type 必须是 module（DSH loader 用 import()）");
  if (!pkg.dsh?.bundle?.patch) errs.push("缺 dsh.bundle.patch");
  if (pkg.dsh?.client?.platform !== "web") errs.push("dsh.client.platform 必须是 web");
  if (!Array.isArray(pkg.dsh?.client?.inject)) errs.push("dsh.client.inject 必须是数组");
  return errs.length ? bad(errs.join("; ")) : ok(`${pkg.name}@${pkg.version}`);
});

check("dsh.bundle.patch 指向的文件存在", async () => {
  const rel = pkg?.dsh?.bundle?.patch;
  if (!rel) return bad("未声明");
  const p = join(PKG_DIR, rel);
  return exists(p) ? ok(rel) : bad(`指向的文件不存在: ${rel}`);
});

check("exports 声明齐全", async () => {
  const ex = pkg?.exports;
  if (!ex) return bad("缺 exports");
  const need = [".", "./client", "./cordis.patch.yml"];
  const missing = need.filter((k) => !ex[k]);
  return missing.length ? bad(`缺 ${missing.join(", ")}`) : ok(Object.keys(ex).join(", "));
});

check("peerDependencies 的 dsh 范围合法（预发布逐段并集）", async () => {
  const range = pkg?.peerDependencies?.["@deepseek-ai/dsh-llm"];
  if (!range) return bad("缺 @deepseek-ai/dsh-llm 的 peerDependency");
  const segs = range.split("||").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) {
    return bad(`只有 ${segs.length} 段 —— 预发布版本必须逐段列出（见 E-012）`);
  }
  // 每一段都必须是 ">=x <y" 形状
  for (const s of segs) {
    if (!/^>=\S+\s+<\S+$/.test(s)) return bad(`段格式可疑: "${s}"`);
  }
  return ok(`${segs.length} 段`);
});

check("files 字段包含必要产物", async () => {
  const files = pkg?.files;
  if (!Array.isArray(files)) return bad("缺 files 数组（会让 npm pack 带上不该带的东西）");
  const need = ["lib"];
  const missing = need.filter((f) => !files.includes(f));
  return missing.length ? bad(`缺 ${missing.join(", ")}`) : ok(files.join(", "));
});

check("src/build.ts 的 VERSION 与 package.json 一致", async () => {
  // 这两个值是**手写**的（见 src/build.ts 注释：ESM 读 package.json 要 import assertion，
  // tsup 打包时会变成奇怪代码）。手写就会漂，所以必须有机器检查。
  // 2026-11-11 真实漂过一次：package.json 升 0.2.0，build.ts 还是 0.1.0，
  // 宿主 status 端点报 0.1.0，看起来像"新版本没装上去"。
  if (!pkg?.version) return bad("package.json 没有 version，先修上一条");
  let text;
  try {
    text = await readFile(join(PKG_DIR, "src", "build.ts"), "utf8");
  } catch (e) {
    return bad(`读不到 src/build.ts: ${e.message}`);
  }
  const m = /export\s+const\s+VERSION\s*=\s*"([^"]*)"/.exec(text);
  if (!m) return bad('src/build.ts 里找不到 `export const VERSION = "..."`');
  if (m[1] !== pkg.version) {
    return bad(`build.ts 是 ${m[1]}，package.json 是 ${pkg.version} —— 改一处不算改完`);
  }
  return ok(`${m[1]}（两处一致）`);
});

check("lib/index.js 里的 VERSION 与 package.json 一致（产物是否重新构建）", async () => {
  // 上一条查源码，这一条查**产物**。源码对了但忘了重新构建，宿主跑的还是旧版本。
  if (!pkg?.version) return bad("package.json 没有 version");
  let text;
  try {
    text = await readFile(join(PKG_DIR, "lib", "index.js"), "utf8");
  } catch (e) {
    return bad(`读不到 lib/index.js: ${e.message}`);
  }
  // tsup 会把它内联成 `var VERSION = "0.2.0";` 或 `const VERSION = "0.2.0";`
  const m = /(?:var|const|let)\s+VERSION\s*=\s*"([^"]*)"/.exec(text);
  if (!m) return bad("lib/index.js 里找不到内联的 VERSION");
  if (m[1] !== pkg.version) {
    return bad(`产物里是 ${m[1]}，package.json 是 ${pkg.version} —— 忘了重新构建`);
  }
  return ok(`${m[1]}（产物已更新）`);
});

check("engines 与宿主一致", async () => {
  const e = pkg?.engines?.node;
  if (!e) return bad("缺 engines.node");
  return /22\.19|\^22|>=24|24\.0/.test(e) ? ok(e) : bad(`可疑: ${e}`);
});

// ---------------------------------------------------------------- 3) cordis.patch.yml 内容

check("cordis.patch.yml 是数组且含 insert", async () => {
  try {
    const text = await readFile(join(PKG_DIR, "cordis.patch.yml"), "utf8");
    if (!/^\s*-\s*insert:/m.test(text)) return bad("缺 - insert: 条目");
    if (!/llm-raccoon-web/.test(text)) return bad("缺 id: llm-raccoon-web");
    if (!/name:\s*dsh-raccoon-web/.test(text)) return bad("缺 name: dsh-raccoon-web");
    if (/\t/.test(text)) return bad("含 Tab 字符（YAML 禁止）");
    return ok("结构正确，无 Tab");
  } catch (e) {
    return bad(e.message);
  }
});

// ---------------------------------------------------------------- 4) client.js 硬约束

check("client.js 是 classic script（无 import/export）", async () => {
  const p = [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")].find(exists);
  if (!p) return bad("文件不存在");
  const text = await readFile(p, "utf8");
  const lines = text.split("\n").slice(0, 40); // 只看头 40 行，避免误伤字符串里的词
  const hit = lines.findIndex((l) => /^\s*(import|export)\s/.test(l));
  if (hit >= 0) return bad(`第 ${hit + 1} 行有 import/export —— 会导致整个文件加载失败`);
  const size = Buffer.byteLength(text, "utf8");
  return ok(`${(size / 1024).toFixed(1)} KB`);
});

check("client.js 含 __ModuleLoader__ 与 loader.load(", async () => {
  const p = [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")].find(exists);
  if (!p) return bad("文件不存在");
  const text = await readFile(p, "utf8");
  const a = text.includes("__ModuleLoader__");
  const b = /loader\.load\s*\(/.test(text) || /\.load\s*\(\s*\{/.test(text);
  if (!a) return bad("缺 __ModuleLoader__");
  if (!b) return bad("缺 loader.load(");
  return ok("两者都在");
});

check("client.js 有 BUILD 标记（用于确认缓存）", async () => {
  const p = [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")].find(exists);
  if (!p) return bad("文件不存在");
  const text = await readFile(p, "utf8");
  const hasBuild = /(?:const|var|let)\s+BUILD\s*=/.test(text);
  const hasGlobal = text.includes("__DSH_BUILD_raccoon");
  if (!hasBuild) return bad("缺 const BUILD =");
  if (!hasGlobal) return bad("缺 globalThis.__DSH_BUILD_raccoon");
  return ok("BUILD 标记齐全");
});

check("client.js 的 BUILD 与 src/build.ts 一致（两处手写，最容易漂）", async () => {
  // 这两个 BUILD 是排查"改了界面没变化"的唯一判据（docs/04-ops/01-troubleshooting.md §2）：
  // 宿主 status 里的 build 与浏览器 console 里的 __DSH_BUILD_raccoon 对不上，
  // 就说明浏览器加载的是缓存的旧 client.js。所以两边必须同源。
  const cp = [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")].find(exists);
  if (!cp) return bad("client.js 不存在");
  let srcText;
  try {
    srcText = await readFile(join(PKG_DIR, "src", "build.ts"), "utf8");
  } catch (e) {
    return bad(`读不到 src/build.ts: ${e.message}`);
  }
  const hostBuild = /export\s+const\s+BUILD\s*=\s*"([^"]*)"/.exec(srcText);
  if (!hostBuild) return bad("src/build.ts 里找不到 `export const BUILD = \"...\"`");
  const clientText = await readFile(cp, "utf8");
  // client.js 是手写的 classic script，用单引号；src/build.ts 用双引号。两种都要认。
  const clientBuild = /(?:const|var|let)\s+BUILD\s*=\s*['"]([^'"]*)['"]/.exec(clientText);
  if (!clientBuild) return bad("client.js 里找不到 BUILD 字面量");
  if (clientBuild[1] !== hostBuild[1]) {
    return bad(`client.js 是 ${clientBuild[1]}，src/build.ts 是 ${hostBuild[1]} —— 改 client.js 要同步两处`);
  }
  return ok(`${hostBuild[1]}（两处一致）`);
});

check("client.js 无 console.log（应用 logger 或 console.warn/error）", async () => {
  const p = [join(PKG_DIR, "client.js"), join(PKG_DIR, "lib", "client.js")].find(exists);
  if (!p) return bad("文件不存在");
  const text = await readFile(p, "utf8");
  const n = (text.match(/\bconsole\.log\s*\(/g) || []).length;
  return n === 0 ? ok("0 处") : bad(`有 ${n} 处 console.log`);
});

// ---------------------------------------------------------------- 5) lib/index.js 结构

check("lib/index.js 是单文件（无 chunk）", async () => {
  const libDir = join(PKG_DIR, "lib");
  if (!exists(libDir)) return bad("lib/ 不存在");
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(libDir);
  const chunks = entries.filter((f) => /^chunk-|^[a-z]+-[A-Za-z0-9_-]{8}\.js$/.test(f));
  if (chunks.length > 0) return bad(`发现分包 ${chunks.join(", ")} —— splitting 必须为 false（见 06-coding-conventions）`);
  return ok(entries.join(", "));
});

check("lib/index.js 可被 ESM 解析", async () => {
  const p = join(PKG_DIR, "lib", "index.js");
  if (!exists(p)) return bad("文件不存在");
  try {
    // 只解析不执行：动态 import 会真的执行 apply，所以用 createRequire 之外的方式不可行。
    // 折中：用 vm.SourceTextModule 需要 flag。这里退一步只做语法检查。
    const { execFile } = await import("node:child_process");
    await new Promise((res, rej) => {
      execFile(process.execPath, ["--check", p], (err) => (err ? rej(err) : res()));
    });
    return ok("语法通过");
  } catch (e) {
    return bad(String(e.message).slice(0, 300));
  }
});

check("lib/index.js 导出 name 与 apply", async () => {
  const p = join(PKG_DIR, "lib", "index.js");
  if (!exists(p)) return bad("文件不存在");
  const text = await readFile(p, "utf8");
  const hasName = /export\s*\{[^}]*\bname\b/.test(text) || /export\s+const\s+name\s*=/.test(text) || /export\s+let\s+name\s*=/.test(text);
  const hasApply = /export\s*\{[^}]*\bapply\b/.test(text) || /export\s+(async\s+)?function\s+apply\b/.test(text) || /export\s+const\s+apply\s*=/.test(text);
  if (!hasName) return bad("未导出 name");
  if (!hasApply) return bad("未导出 apply");
  return ok("name + apply 已导出");
});

// ---------------------------------------------------------------- 6) 内核可解析

check("内核包可从安装目录解析", async () => {
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness", "resources", "app", "dsh"),
    "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh",
  ].filter(Boolean);
  const base = candidates.find(exists);
  if (!base) return bad("找不到 DSH 安装目录");
  const mod = join(base, "node_modules", "@deepseek-ai", "dsh-llm");
  if (!exists(mod)) return bad(`找不到 ${mod}`);
  return ok(mod);
});

check("profile 里没有悬空链接残留", async () => {
  const p = join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai", "dsh-llm");
  if (!exists(p)) return ok("不存在（正常）");
  try {
    await access(p);
    return ok("存在且可访问");
  } catch {
    return bad(`${p} 是悬空链接 —— 会让单测 import 失败`);
  }
});

// ---------------------------------------------------------------- 7) 数据目录不被打包

check(".gitignore 存在且忽略产物", async () => {
  const p = join(ROOT, ".gitignore");
  if (!exists(p)) return bad("缺 .gitignore");
  const text = await readFile(p, "utf8");
  const need = ["node_modules", "lib/", "research/pkgs"];
  const missing = need.filter((n) => !text.includes(n));
  return missing.length ? bad(`缺 ${missing.join(", ")}`) : ok(need.join(", "));
});

// ---------------------------------------------------------------- 执行

let failed = 0;
console.log("");
console.log("verify-install  " + new Date().toISOString());
console.log("-".repeat(64));

for (const c of checks) {
  let r;
  try {
    r = await c.fn();
  } catch (e) {
    r = bad(`抛异常: ${e.message}`);
  }
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✅" : "❌"} ${c.name}`);
  console.log(`     ${r.msg}`);
}

console.log("-".repeat(64));
console.log(` ${checks.length - failed}/${checks.length} 通过`);
console.log("");

if (failed > 0) {
  console.log("先修上面红的项再发版。");
  process.exit(1);
} else {
  console.log("✓ 全绿");
  process.exit(0);
}
