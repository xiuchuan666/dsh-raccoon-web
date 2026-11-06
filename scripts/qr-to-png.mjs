/**
 * 把 QR 矩阵渲染成 PNG，用于人眼/视觉模型校验。
 *
 * 只给开发时用：`node scripts/qr-to-png.mjs "<text>" out.png [scale]`
 * 不是插件的一部分，不进产物。
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/** 生成灰度 PNG（8 bit，无 alpha）。 */
function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
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
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (table === null) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

const [text, outPath, scaleArg] = process.argv.slice(2);
if (text === undefined || outPath === undefined) {
  console.error('usage: node scripts/qr-to-png.mjs "<text>" out.png [scale]');
  process.exit(2);
}
const scale = Number(scaleArg ?? 8);
const margin = 4;

const { encodeQr } = await import("../packages/dsh-raccoon-web/src/protocol/qr.ts");
const matrix = encodeQr(text);
const dim = matrix.size + margin * 2;
const width = dim * scale;
const pixels = Buffer.alloc(width * width, 0xff);

for (let my = 0; my < matrix.size; my++) {
  for (let mx = 0; mx < matrix.size; mx++) {
    if (matrix.modules[my * matrix.size + mx] !== 1) continue;
    const px0 = (mx + margin) * scale;
    const py0 = (my + margin) * scale;
    for (let dy = 0; dy < scale; dy++) {
      const row = (py0 + dy) * width;
      pixels.fill(0x00, row + px0, row + px0 + scale);
    }
  }
}

writeFileSync(outPath, encodePng(width, width, pixels));
console.log(`wrote ${outPath} (${width}x${width}, version ${(matrix.size - 17) / 4}, ${Buffer.byteLength(text)} bytes)`);
console.log(text);
