#!/usr/bin/env node
/**
 * probe-gateway.mjs — 直接打小浣熊网关，确认协议假设是否仍然成立
 *
 * 这是"改协议代码前必跑"的脚本。它不依赖 DSH，只用 node 内置 fetch。
 *
 * 用法：
 *   node scripts/probe-gateway.mjs                 # 打四个端点（无 token）
 *   node scripts/probe-gateway.mjs --qr            # 额外取一个二维码并做一次轮询
 *   node scripts/probe-gateway.mjs --token <T>     # 带 token 打目录/积分
 *   node scripts/probe-gateway.mjs --from-profile  # 从 token.json 读 token
 *   node scripts/probe-gateway.mjs --save          # 把原始响应存到 research/captures/
 *
 * 退出码：
 *   0  全部符合预期
 *   1  有端点行为与 05-empirical-findings.md 记录不符（需要更新文档）
 *   2  脚本自身出错
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.replace(/[\\/]scripts$/, "");
const CAPTURE_DIR = join(ROOT, "research", "captures");

// ---------------------------------------------------------------- 常量（与 src/protocol/consts.ts 保持一致）

const ORIGIN = "https://xiaohuanxiong.com";
const IAM_BASE = `${ORIGIN}/api/iam/v1`;
const WEB_BASE = `${ORIGIN}/api/web`;
const LLM = `${WEB_BASE}/llm/v2`;
const POINTS = `${WEB_BASE}/points`;
const CLIENT_VERSION = "v1.0.35";

const argv = process.argv.slice(2);
const DO_QR = argv.includes("--qr");
const SAVE = argv.includes("--save");
const FROM_PROFILE = argv.includes("--from-profile");
const tokenIdx = argv.indexOf("--token");
let TOKEN = tokenIdx >= 0 ? argv[tokenIdx + 1] : process.env.RACCOON_TOKEN || "";

const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx >= 0 ? argv[profileIdx + 1] : "desktop";

const results = [];
let mismatches = 0;

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function clientPlatform() {
  if (process.platform === "win32") return "desktop-windows";
  if (process.platform === "darwin") return "desktop-macos";
  return "desktop-linux";
}

async function req(method, url, { headers = {}, body, timeout = 30000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, ok: res.ok, text, json, ms: Date.now() - t0, setCookie: res.headers.getSetCookie?.() ?? [] };
  } catch (e) {
    return { status: 0, ok: false, text: "", json: undefined, ms: Date.now() - t0, error: e };
  }
}

function record(name, expectation, actual, ok, detail) {
  results.push({ name, expectation, actual, ok, detail });
  if (!ok) mismatches++;
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${name}`);
  console.log(`     期望: ${expectation}`);
  console.log(`     实际: ${actual}`);
  if (detail) console.log(`     细节: ${detail}`);
}

async function maybeSave(name, payload) {
  if (!SAVE || payload === undefined) return;
  await mkdir(CAPTURE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(CAPTURE_DIR, `${name}-${ts}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  console.log(`     saved → ${file}`);
}

// ---------------------------------------------------------------- 读 token

if (FROM_PROFILE && !TOKEN) {
  const p = join(homedir(), ".dsh", "profiles", PROFILE, "raccoon-web", "token.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(await readFile(p, "utf8"));
      TOKEN = j.token ?? "";
      console.log(`[probe] 从 ${p} 读到 token（长度 ${TOKEN.length}）`);
    } catch (e) {
      console.warn(`[probe] token.json 解析失败: ${e.message}`);
    }
  } else {
    console.log(`[probe] ${p} 不存在，按未登录处理`);
  }
}

const bearer = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const bizHeaders = {
  ...bearer,
  accept: "application/json",
  "x-raccoon-language": "zh",
  "x-client-platform": clientPlatform(),
  "x-client-version": CLIENT_VERSION,
  "x-org-code": "",
};

console.log("");
console.log("=".repeat(64));
console.log(" 小浣熊网关探测  " + new Date().toISOString());
console.log(` DSH profile: ${PROFILE}    token: ${TOKEN ? "有" : "无"}`);
console.log("=".repeat(64));
console.log("");

// ---------------------------------------------------------------- 1) 二维码

let qrSession;
{
  const r = await req("POST", `${IAM_BASE}/auth/mp/qrcode`, {
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });

  const d = r.json?.data;
  const ok = r.status === 200 && r.json?.code === "OK" && typeof d?.qrcode_code === "string" && typeof d?.scan_path === "string";

  record(
    "POST /api/iam/v1/auth/mp/qrcode",
    "200 {code:'OK', data:{qrcode_code, scan_path, expires_in, poll_interval}}",
    ok ? `200 code=OK expires=${d.expires_in}s poll=${d.poll_interval}s scan_path=${d.scan_path}` : `${r.status} ${r.text.slice(0, 160)}`,
    ok,
    r.error ? String(r.error) : undefined,
  );

  if (ok) {
    qrSession = { code: d.qrcode_code, scanPath: d.scan_path, expiresIn: d.expires_in, pollInterval: d.poll_interval };

    // 2) 二维码内容长度 —— 决定 QR 版本
    const url = new URL(d.scan_path, ORIGIN);
    url.search = "";
    url.searchParams.set("code", d.qrcode_code);
    url.searchParams.set("appname", "商汤小浣熊");
    url.searchParams.set("source", "platform");
    const content = url.href;
    const bytes = Buffer.byteLength(content, "utf8");

    // byte 模式 M 级容量：v7=122, v8=152, v9=180, v10=213
    const need = bytes <= 122 ? 7 : bytes <= 152 ? 8 : bytes <= 180 ? 9 : bytes <= 213 ? 10 : 0;

    record(
      "二维码内容长度",
      "≤213 字节（byte/M 级 v10 上限）",
      `${bytes} 字节 → QR 版本 ${need || "超出 10"}`,
      need > 0,
      content,
    );
    await maybeSave("qr-content", { content, bytes, version: need });
  }
}

// ---------------------------------------------------------------- 3) 轮询（一次）

if (DO_QR && qrSession) {
  const r = await req("POST", `${IAM_BASE}/auth/mp/qrcode/login`, {
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ qrcode_code: qrSession.code }),
  });
  const st = r.json?.data?.status;
  const ok = r.status === 200 && (st === "pending" || st === "logging");
  record(
    "POST /api/iam/v1/auth/mp/qrcode/login（未扫码）",
    "200 status ∈ {pending, logging}",
    `${r.status} status=${st} ${r.json?.code ?? ""}`,
    ok,
  );
}

// ---------------------------------------------------------------- 4) 未授权访问

{
  const r = await req("GET", `${LLM}/model_catalog`, { headers: { accept: "application/json" } });
  const code = r.json?.code;
  const ok = r.status === 401 && code === 200001;
  record(
    "GET /api/web/llm/v2/model_catalog（无 token）",
    "401 {code:200001, message:'authorization_empty_error'}",
    `${r.status} code=${code} ${r.json?.message ?? r.text.slice(0, 80)}`,
    ok,
  );
}

// ---------------------------------------------------------------- 5) 带 token 的端点

if (TOKEN) {
  {
    const r = await req("GET", `${LLM}/model_catalog`, { headers: bizHeaders, timeout: 20000 });
    const cats = r.json?.data?.categories;
    const ok = r.status === 200 && Array.isArray(cats);
    const modelCount = Array.isArray(cats)
      ? cats.reduce((n, c) => n + (Array.isArray(c.models) ? c.models.length : 0), 0) || cats.length
      : 0;
    record(
      "GET /api/web/llm/v2/model_catalog（带 token）",
      "200 + data.categories 是数组",
      `${r.status} categories=${Array.isArray(cats) ? cats.length : "非数组"} models≈${modelCount} code=${r.json?.code ?? "-"}`,
      ok,
      ok ? undefined : r.text.slice(0, 200),
    );
    await maybeSave("model-catalog", r.json);

    if (Array.isArray(cats) && cats.length > 0) {
      const first = cats[0];
      const firstModel = (Array.isArray(first.models) ? first.models[0] : undefined) ?? first;
      console.log("     目录字段样例: " + JSON.stringify(Object.keys(firstModel || {})).slice(0, 300));
      await maybeSave("model-sample", firstModel);
    }
  }

  {
    const r = await req("GET", `${POINTS}/v1/balance`, { headers: bizHeaders, timeout: 20000 });
    const d = r.json?.data;
    const available = pick(d?.available_points, d?.total_chargeable_points, d?.total, d?.balance, d?.points);
    const ok = r.status === 200 && typeof available === "number";
    record(
      "GET /api/web/points/v1/balance",
      "200 + 能读出可用积分数字",
      `${r.status} available=${available ?? "-"} keys=${d ? Object.keys(d).join(",") : "-"}`,
      ok,
      ok ? undefined : r.text.slice(0, 200),
    );
    await maybeSave("points-balance", r.json);
  }

  {
    const r = await req("GET", `${POINTS}/v2/bills?paging.limit=50&type=all`, { headers: bizHeaders, timeout: 20000 });
    const items = r.json?.data?.items;
    const ok = r.status === 200 && Array.isArray(items);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const grant = Array.isArray(items) ? items.find((x) => x.biz_type === "daily_grant") : undefined;
    record(
      "GET /api/web/points/v2/bills",
      "200 + data.items 是数组",
      `${r.status} items=${Array.isArray(items) ? items.length : "非数组"} 今日(${today})=${grant ? "有 daily_grant" : "无 daily_grant"}`,
      ok,
      ok ? (grant ? JSON.stringify(grant).slice(0, 200) : undefined) : r.text.slice(0, 200),
    );
    await maybeSave("points-bills", r.json);
  }
} else {
  console.log("⏭  跳过目录/积分（没有 token；加 --token <T> 或 --from-profile）");
}

// ---------------------------------------------------------------- 汇总

console.log("");
console.log("=".repeat(64));
const passed = results.filter((r) => r.ok).length;
console.log(` 结果: ${passed}/${results.length} 符合预期`);
if (mismatches > 0) {
  console.log(" ⚠ 有不符预期的端点 —— 先更新 docs/01-research/05-empirical-findings.md，再改代码");
} else {
  console.log(" ✓ 全部与文档记录一致");
}
console.log("=".repeat(64));
console.log("");

process.exit(mismatches > 0 ? 1 : 0);
