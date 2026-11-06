/**
 * 从运行中的 DSH 取一张小浣熊登录二维码，导出成可直接扫的 PNG。
 *
 * 用法：
 *   node scripts/login-qr.mjs                      # 默认 127.0.0.1:57292，导到 research/captures/
 *   node scripts/login-qr.mjs --port 57292
 *   node scripts/login-qr.mjs --out path/to.png
 *   node scripts/login-qr.mjs --wait               # 导出后继续轮询，直到 ready / expired
 *   node scripts/login-qr.mjs --reuse              # 不换码：已有 pending 二维码就沿用它
 *   node scripts/login-qr.mjs --wait-only          # 只轮询，绝不发 login-start
 *
 * 为什么需要这个脚本：登录是人工步骤，二维码 5 分钟就过期。
 * 每次要重扫都得重新取码 + 把 SVG 转成手机能扫的位图，手搓两次就该脚本化了。
 *
 * 为什么不用 cv2 校验：真宿主下发的 57×57（版本 8）符号，
 * cv2.QRCodeDetector 有时检不出来（E-024），QRCodeDetectorAruco 才行。
 * 这个脚本只负责导出，校验交给 verify-install 之外的独立步骤，避免误判成编码 bug。
 *
 * ⚠️ 2026-11-06 血泪坑（E-029）：
 * 早期版本无条件调 login-start，导致"刚把二维码贴给用户，后台 --wait 又换了一张码"，
 * 服务端立刻作废旧码 —— 用户扫的是贴出来的那张，手机上显示"二维码已过期或已被使用"。
 * 所以现在：默认**沿用**仍在有效期内的待扫码（--reuse 语义），要换码必须显式 --new。
 * 这个 bug 的代价是连废 4 张码，写在这里防止重犯。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

/* ── 参数 ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const port = argOf("--port", "57292");
const out = resolve(argOf("--out", "research/captures/raccoon-login-qr.png"));
const scale = Number(argOf("--scale", "12"));
const wait = argv.includes("--wait") || argv.includes("--wait-only");
const waitOnly = argv.includes("--wait-only");
const reuse = !argv.includes("--new"); // 默认沿用未过期的待扫码
const base = `http://127.0.0.1:${port}/plugins/dsh-raccoon-web`;

/* ── PNG 编码（灰度，与 qr-to-png.mjs / verify-qr.mjs 同源） ────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把插件下发的 SVG 还原成位图。
 *
 * SVG 里每个暗模块是 `M{x},{y}h1v1h-1z`，坐标已含静默区偏移 ——
 * 所以这里不需要重新编码二维码，只需要按坐标还原，再按整数倍放大。
 * **整数倍**很重要：非整数倍插值会让模块边缘发灰，手机扫码成功率下降。
 */
function svgToPng(svg) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (viewBox === null) throw new Error("SVG 里找不到 viewBox，插件版本可能不一致");
  const dim = Number(viewBox[1]);

  const dark = new Set();
  for (const m of svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    dark.add(Number(m[2]) * dim + Number(m[1]));
  }

  const width = dim * scale;
  const raw = Buffer.alloc((width + 1) * width, 0xff);
  for (let y = 0; y < width; y++) {
    raw[y * (width + 1)] = 0; // PNG filter: none（必须是 0，否则 libpng 报 bad adaptive filter）
    const sy = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      if (dark.has(sy * dim + Math.floor(x / scale))) raw[y * (width + 1) + 1 + x] = 0x00;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── 与插件通信 ───────────────────────────────────────────────────── */

async function getStatus() {
  const res = await fetch(`${base}/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}（插件没加载？先跑 node scripts/link.mjs）`);
  return res.json();
}

async function startLogin() {
  const res = await fetch(`${base}/action?action=login-start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`login-start ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 主流程 ───────────────────────────────────────────────────────── */

console.log(`[qr] ${base}`);

const before = await getStatus().catch((e) => {
  console.error(`[qr] ${e.message}`);
  process.exit(2);
});
console.log(`[qr] 当前 phase=${before.login?.phase ?? "?"} publish=${before.publish}`);

if (before.login?.phase === "ready") {
  console.log("[qr] 已经登录，无需重扫。要换账号先点「退出登录」。");
  process.exit(0);
}

/**
 * 决定这次是"沿用旧码"还是"换新码"。
 *
 * 沿用的条件：reuse 已开 && phase 是 pending|logging && deadline 还没到。
 * 任何一条不满足就换新码 —— 尤其是 deadline 已过，沿用只会导出一张死码。
 */
const phase = before.login?.phase ?? "none";
const deadline = before.login?.deadline ?? 0;
const live = (phase === "pending" || phase === "logging") && deadline > Date.now() + 3_000;

let reused = false;
if (waitOnly === false && !(reuse && live)) {
  const started = await startLogin();
  if (started.ok !== true) {
    console.error(`[qr] login-start 失败: ${started.error ?? "未知"}`);
    process.exit(2);
  }
} else if (reuse && live) {
  reused = true;
  console.log(`[qr] 沿用现有二维码（phase=${phase}，剩 ${Math.round((deadline - Date.now()) / 1000)} 秒）—— 不换码`);
} else if (waitOnly) {
  console.log("[qr] --wait-only：不取码，只观察现有登录状态");
}

const state = await getStatus();
const svg = state.login?.qrSvg;
if (typeof svg !== "string" || svg.length === 0) {
  if (waitOnly) {
    // --wait-only 本来就是"只盯状态"，没有二维码是正常情况
  } else {
    console.error(`[qr] 没拿到二维码（phase=${state.login?.phase}）: ${state.login?.message ?? ""}`);
    process.exit(2);
  }
}

if (typeof svg === "string" && svg.length > 0) {
  const png = svgToPng(svg);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);

  const total = Math.round(((state.login?.deadline ?? 0) - Date.now()) / 1000);
  const viewBox = /viewBox="0 0 (\d+) /.exec(svg);
  const dim = viewBox === null ? 0 : Number(viewBox[1]);
  const quiet = 4; // renderQrSvg 的默认静默区
  const version = dim > 0 ? (dim - quiet * 2 - 17) / 4 : 0;

  console.log(`[qr] ✓ ${out}${reused ? "（沿用旧码，未换码）" : ""}`);
  console.log(`[qr]   ${png.length} 字节，${dim}×${dim} 矩阵（版本 ${version}）× ${scale} 倍 = ${dim * scale}px`);
  console.log(`[qr]   有效期 ${total} 秒（${new Date(state.login?.deadline ?? 0).toTimeString().slice(0, 8)} 过期）`);
}

if (!wait) {
  console.log("[qr] 用微信扫这张图；加 --wait-only 只盯状态、不换码。");
  process.exit(0);
}

console.log("[qr] 等待扫码…（本模式不再发 login-start，不会作废你手上那张码）");
let last = "";
const until = (state.login?.deadline ?? 0) > 0 ? state.login.deadline + 5_000 : Date.now() + 360_000;
while (Date.now() < until) {
  const now = await getStatus();
  const phase = now.login?.phase ?? "?";
  if (phase !== last) {
    console.log(`[qr] ${new Date().toTimeString().slice(0, 8)} phase=${phase}`);
    last = phase;
  }
  if (phase === "ready") {
    console.log(`[qr] ✓ 登录成功 principal=${now.login?.principal ?? "-"}`);
    console.log(`[qr]   publish=${now.publish} catalogReady=${now.catalogReady} models=${now.models?.length ?? 0}`);
    process.exit(0);
  }
  if (phase === "expired" || phase === "error") {
    console.error(`[qr] ✗ ${phase}: ${now.login?.message ?? ""}（重跑本脚本取新码）`);
    process.exit(3);
  }
  await sleep(1_500);
}
console.error("[qr] ✗ 二维码过期，重跑本脚本取新码");
process.exit(3);
