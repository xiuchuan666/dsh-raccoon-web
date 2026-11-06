#!/usr/bin/env node
/**
 * unlink.mjs — 从 DSH desktop profile 里彻底移除 dsh-raccoon-web
 *
 * 清理四处（幂等）：
 *   1. profile package.json 的 dependencies
 *   2. dsh.profile.bundles
 *   3. cordis.patch.yml 里的 insert 条目
 *   4. node_modules 里的链接
 *
 * 默认**保留** raccoon-web/ 数据目录（含 token）—— 里面是用户的登录态。
 * 要删得显式加 --purge-data。
 *
 * 用法：
 *   node scripts/unlink.mjs
 *   node scripts/unlink.mjs --purge-data      # 连 token 一起删
 *   node scripts/unlink.mjs --dry
 */

import { readFile, writeFile, rm, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.replace(/[\\/]scripts$/, "");
const PKG_NAME = "dsh-raccoon-web";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const PURGE = argv.includes("--purge-data");
const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx >= 0 ? argv[profileIdx + 1] : "desktop";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const DATA_DIR = join(PROFILE_DIR, "raccoon-web");

const log = (...a) => console.log("[unlink]", ...a);
const warn = (...a) => console.warn("[unlink] ⚠", ...a);

if (!existsSync(PROFILE_DIR)) {
  warn(`profile 目录不存在，无事可做: ${PROFILE_DIR}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 1+2) package.json

const profilePkgPath = join(PROFILE_DIR, "package.json");
if (existsSync(profilePkgPath)) {
  const pkg = JSON.parse(await readFile(profilePkgPath, "utf8"));
  let dirty = false;

  if (pkg.dependencies?.[PKG_NAME]) {
    log(`dependencies -= ${PKG_NAME} (${pkg.dependencies[PKG_NAME]})`);
    delete pkg.dependencies[PKG_NAME];
    dirty = true;
  }

  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const i = bundles.indexOf(PKG_NAME);
    if (i >= 0) {
      log(`bundles -= ${PKG_NAME} (index ${i})`);
      bundles.splice(i, 1);
      dirty = true;
    }
  }

  if (dirty && !DRY) {
    await writeFile(profilePkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
  if (!dirty) log("package.json 已经是干净的");
}

// ---------------------------------------------------------------- 3) cordis.patch.yml

const patchPath = join(PROFILE_DIR, "cordis.patch.yml");
if (existsSync(patchPath)) {
  const before = await readFile(patchPath, "utf8");

  // 删掉整个以 "# dsh-raccoon-web" 注释开头、含 "insert:" 与 "llm-raccoon-web" 的块，
  // 以及任何只含 llm-raccoon-web 的裸条目。
  const lines = before.split("\n");
  const out = [];
  let skipping = false;
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 块起点：我们的注释行
    if (/^#\s*dsh-raccoon-web/.test(line.trim())) {
      skipping = true;
      removed++;
      continue;
    }
    // 由 link.mjs 插入的第二行注释
    if (/^#\s*由 scripts\/link\.mjs 自动插入/.test(line.trim())) {
      continue;
    }
    if (skipping) {
      // insert: 行
      if (/^\s*-\s*insert:\s*$/.test(line)) continue;
      // 其下的 4 空格缩进两条
      if (/^\s{4}-\s*id:\s*llm-raccoon-web\s*$/.test(line)) continue;
      // name 行两种形态都要认：
      //   裸包名 `name: dsh-raccoon-web`
      //   file URL `name: "file:///.../lib/index.js?v=123"`（link.mjs 现在写这种，见 E-031）
      if (/^\s{6}name:\s*(dsh-raccoon-web\s*$|"[^"]*lib\/index\.js[^"]*"\s*$|'[^']*lib\/index\.js[^']*'\s*$)/.test(line)) {
        skipping = false;
        continue;
      }
      // 空行也吞掉（块尾）
      if (line.trim() === "") continue;
      // 其它内容：说明块已经结束，放行并停止跳过
      skipping = false;
      out.push(line);
      continue;
    }

    // 裸条目形式：- { id: llm-raccoon-web, ... }
    if (/^\s*-\s*\{[^}]*llm-raccoon-web/.test(line)) {
      removed++;
      continue;
    }
    out.push(line);
  }

  let next = out.join("\n");

  // 兜底：任何残留的单行引用（注释除外）
  const residual = next
    .split("\n")
    .filter((l) => /llm-raccoon-web|dsh-raccoon-web/.test(l) && !/^\s*#/.test(l));

  if (residual.length > 0) {
    warn(`还有 ${residual.length} 行残留引用，需要人工确认：`);
    for (const l of residual) warn("  " + l);
  }

  if (next !== before) {
    log(`cordis.patch.yml 清理 ${removed} 块`);
    if (!DRY) await writeFile(patchPath, next, "utf8");
  } else {
    log("cordis.patch.yml 已经是干净的");
  }
}

// ---------------------------------------------------------------- 4) node_modules

const linkPath = join(PROFILE_DIR, "node_modules", PKG_NAME);
if (existsSync(linkPath) || (await lstat(linkPath).catch(() => null))) {
  log(`node_modules -= ${PKG_NAME}`);
  if (!DRY) await rm(linkPath, { recursive: true, force: true });
} else {
  log("node_modules 里没有链接");
}

// ---------------------------------------------------------------- 5) 数据目录

if (existsSync(DATA_DIR)) {
  if (PURGE) {
    log(`--purge-data：删除 ${DATA_DIR}（含 token）`);
    if (!DRY) await rm(DATA_DIR, { recursive: true, force: true });
  } else {
    warn(`保留数据目录（含登录态）：${DATA_DIR}`);
    warn("  连 token 一起删：node scripts/unlink.mjs --purge-data");
  }
}

log("");
if (DRY) log("（--dry 模式，未写入任何文件）");
else log("✓ 完成。重启 DSH 生效。");
