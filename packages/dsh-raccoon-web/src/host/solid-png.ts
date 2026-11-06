/**
 * 造一张纯色 PNG。**零依赖，只用 `node:zlib`。**
 *
 * ## 为什么需要它
 *
 * ADR-0006：目录里的 `vision` 标签不可信（2026-09-18 实测 5 个模型错 2 个，
 * 两个方向都错）。唯一可靠的判定是**发一张图看它能不能读**。
 *
 * 用什么图很关键：
 * - **不能用文字图**：模型 OCR 不行会被误判成"看不到图"，
 *   而我们要测的是"图有没有到达模型"。
 * - **不能用复杂照片**：压不进 1MB 预算，也没必要。
 * - **纯色最好**：一个 3×3 的红块，问"这张图是什么颜色"，能答"红"就说明
 *   整条图片通路（base64 编码、多模态字段、网关转发）都通了。
 *
 * ## PNG 结构
 *
 * 8 字节签名 + IHDR + IDAT + IEND。三块都是 `length(4) + type(4) + data + crc(4)`，
 * CRC 覆盖 `type + data`。像素数据是每行前面加一个 filter 字节（0 = None），
 * 然后 zlib deflate。
 *
 * 这份实现只支持 8 bit RGB（color type 2）—— 够用，且不可能写错。
 *
 * @module host/solid-png
 */

import { deflateSync } from "node:zlib";

/** CRC32 表。PNG 每块结尾都要它，`zlib.crc32` 在 Node 22 还没有。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 造一个 PNG chunk。 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = type.charCodeAt(i);

  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * 造一张 `width × height` 的纯色 PNG。
 *
 * @param width 像素宽。
 * @param height 像素高。
 * @param rgb 三个 0–255 分量。
 * @returns PNG 字节。
 */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`solidPng: 尺寸必须是正整数，收到 ${width}×${height}`);
  }
  const [r, g, b] = rgb;

  // 每行：1 字节 filter(0) + width × 3 字节 RGB
  const rowLength = 1 + width * 3;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = new Uint8Array(deflateSync(raw));
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 探测用的红块。
 *
 * `#ed1c24` 不是随便挑的：它是标准红（中国红偏暗的那一支），
 * 与纯 `#ff0000` 相比在 JPEG 压缩后更不容易偏成橙色。
 * 3×3 是 ADR-0006 定的 —— 再小有的模型会说"图太小"。
 */
export const PROBE_PNG_BASE64: string = Buffer.from(solidPng(3, 3, [0xed, 0x1c, 0x24])).toString("base64");
