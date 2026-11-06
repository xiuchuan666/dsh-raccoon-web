/**
 * QR 编码器的端到端校验：用 OpenCV 真的解一遍。
 *
 * 为什么需要：矩阵"看起来对"和"手机能扫出来"是两件事。
 * 版本 ≥ 7 的版本信息块、版本 ≥ 5 的分块交错、掩码选择 —— 这三处错任何一处，
 * 人眼看矩阵仍然像二维码，但解不出来。所以必须用真解码器验。
 *
 * 依赖：python + opencv（本机已有 cv2 5.0.0）。
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/verify-qr.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const { encodeQr, pickVersion, MAX_VERSION } = await import("../packages/dsh-raccoon-web/src/protocol/qr.ts");

/* ── PNG 编码（灰度，与 qr-to-png.mjs 同源） ───────────────────── */

let crcTable = null;
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

function pngFromMatrix(matrix, scale = 6, margin = 4) {
  const dim = matrix.size + margin * 2;
  const width = dim * scale;
  const raw = Buffer.alloc((width + 1) * width, 0xff);
  for (let y = 0; y < width; y++) raw[y * (width + 1)] = 0;
  for (let my = 0; my < matrix.size; my++) {
    for (let mx = 0; mx < matrix.size; mx++) {
      if (matrix.modules[my * matrix.size + mx] !== 1) continue;
      const px0 = (mx + margin) * scale;
      const py0 = (my + margin) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const row = (py0 + dy) * (width + 1) + 1;
        raw.fill(0x00, row + px0, row + px0 + scale);
      }
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── 用 OpenCV 解码 ───────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "qr-verify-"));
const py = join(dir, "decode.py");
writeFileSync(
  py,
  [
    "import sys, cv2",
    "d = cv2.QRCodeDetector()",
    "bad = 0",
    "for path in sys.argv[1:]:",
    "    img = cv2.imread(path)",
    "    val, _, _ = d.detectAndDecode(img)",
    "    print('OK\\t' + val if val else 'FAIL\\t')",
  ].join("\n"),
  "utf8",
);

/* ── 逐版本测：每个版本一个刚好填满的内容 ──────────────────────── */

const cases = [];
// 真实用例：二维码 URL，149 字节 → 版本 8
cases.push({
  name: "raccoon-qr-url",
  text: "https://xiaohuanxiong.com/login/mp?code=qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform",
});
// 各版本边界：用可打印 ASCII 填到该版本的容量
const CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
for (let v = 1; v <= MAX_VERSION; v++) {
  const cap = CAPACITY[v];
  const body = "A".repeat(cap);
  const expect = v;
  cases.push({ name: `v${v}-full`, text: body, expect });
}
// 中文（多字节 UTF-8）
cases.push({ name: "utf8-chinese", text: "小浣熊登录测试：https://xiaohuanxiong.com/login/mp?code=abc" });

const files = [];
for (const c of cases) {
  const version = pickVersion(Buffer.byteLength(c.text));
  if (c.expect !== undefined && version !== c.expect) {
    console.log(`✗ ${c.name}: pickVersion=${version} 期望 ${c.expect}`);
    process.exitCode = 1;
    continue;
  }
  const matrix = encodeQr(c.text);
  const file = join(dir, `${c.name}.png`);
  writeFileSync(file, pngFromMatrix(matrix));
  files.push({ file, text: c.text, name: c.name, version });
}

const out = execFileSync("python", [py, ...files.map((f) => f.file)], {
  encoding: "utf8",
  // Windows 上 python 默认按本地代码页（cp936）写 stdout，UTF-8 内容会变成乱码；
  // print 还会把 \n 转成 \r\n。两个都必须在外部治住，否则"解对了"也会判失败。
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
})
  .split(/\r?\n/)
  .map((l) => l.replace(/\r$/, ""))
  .filter((l) => l !== "");

let failures = 0;
files.forEach((f, i) => {
  const line = out[i] ?? "FAIL\t";
  const tab = line.indexOf("\t");
  const status = tab < 0 ? "FAIL" : line.slice(0, tab);
  const decoded = tab < 0 ? "" : line.slice(tab + 1);
  if (status === "OK" && decoded === f.text) {
    console.log(`✓ ${f.name} (v${f.version}, ${Buffer.byteLength(f.text)} 字节)`);
  } else {
    failures++;
    console.log(`✗ ${f.name} (v${f.version}): 解出 ${JSON.stringify((decoded ?? "").slice(0, 60))}`);
    process.exitCode = 1;
  }
});

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? `\n全部通过：${files.length} 个用例` : `\n${failures} 个失败`);
