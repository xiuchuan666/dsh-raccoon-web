/**
 * 自实现 QR 编码器：byte 模式 + 纠错等级 M + 版本 1–10（容量 14–213 字节）。
 *
 * 为什么自己写而不是装 `qrcode`（180KB）/`qrcode-generator`（40KB）：
 * 插件跑在宿主进程里，多一个依赖就多一份和宿主 node_modules 打架的机会，
 * 而我们需要的能力窄到只有"把一段 ASCII URL 变成矩阵再变 SVG"。
 * 完整取舍见 ADR-0002。
 *
 * 实测需求：二维码内容 149 字节（E-007），落在版本 8（容量 152）。
 * **版本 ≥ 7 必须写 18 bit 版本信息块（两处），否则手机扫不出来** ——
 * 这不是边缘情况，是这个插件的默认路径。
 *
 * @module protocol/qr
 */

import { RaccoonError } from "./errors.js";

/** 编码结果的矩阵。`modules[y * size + x]` 为 1 表示深色。 */
export interface QrMatrix {
  size: number;
  modules: Uint8Array;
}

/** 每版本的总码字数（含纠错）。ISO/IEC 18004 表 1。 */
const RAW_CODEWORDS = [-1, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346] as const;

/** 纠错等级 M 的每块纠错码字数。 */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;

/** 纠错等级 M 的分块数。 */
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;

/** 对齐图案中心坐标。版本 1 没有对齐图案。 */
const ALIGN_POS: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** 纠错等级 M 在格式信息里的两位编码。 */
const ECL_M = 0b00;

/** byte 模式指示符。 */
const MODE_BYTE = 0b0100;

/** 版本上限。超了直接抛 —— 我们的内容永远 149 字节，不为此扩表。 */
export const MAX_VERSION = 10;

/** 某版本 + 纠错 M 的数据码字数。 */
function dataCodewords(version: number): number {
  const raw = RAW_CODEWORDS[version];
  const ecc = ECC_PER_BLOCK[version];
  const blocks = NUM_BLOCKS[version];
  if (raw === undefined || ecc === undefined || blocks === undefined) {
    throw new RaccoonError("INVALID_REQUEST", `不支持的 QR 版本 ${version}`);
  }
  return raw - ecc * blocks;
}

/** 某版本能装多少字节（byte 模式）。 */
function byteCapacity(version: number): number {
  const lengthBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - lengthBits) / 8);
}

/** 按内容长度选最小可用版本。 */
export function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (byteLength <= byteCapacity(v)) return v;
  }
  throw new RaccoonError(
    "INVALID_REQUEST",
    `内容 ${byteLength} 字节超过 QR 版本 ${MAX_VERSION} 的容量（${byteCapacity(MAX_VERSION)} 字节）`,
  );
}

/** GF(256) 乘法，本原多项式 0x11D。 */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 生成多项式 (x - a^0)(x - a^1)...(x - a^(deg-1)) 的系数。 */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** 余数多项式 = EC 码字。 */
function rsRemainder(data: readonly number[], divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/** 位流写入器。 */
class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): this {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }
}

/** 数据码字：模式 + 长度 + 数据 + 终止符 + 填充。 */
function buildDataCodewords(bytes: readonly number[], version: number): number[] {
  const capacityBits = dataCodewords(version) * 8;
  const bb = new BitBuffer();
  bb.push(MODE_BYTE, 4);
  bb.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bb.push(b, 8);

  // 终止符最多 4 bit
  bb.push(0, Math.min(4, capacityBits - bb.bits.length));
  // 补齐到字节边界
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);

  const out: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bb.bits[i + j] ?? 0);
    out.push(v);
  }
  // 填充码字 0xEC / 0x11 交替
  for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    out.push(pad);
  }
  return out;
}

/** 分块 + 纠错 + 交错。版本 ≥ 5 一定走分块，所以这段是默认路径。 */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const raw = RAW_CODEWORDS[version] ?? 0;
  const eccLen = ECC_PER_BLOCK[version] ?? 0;
  const numBlocks = NUM_BLOCKS[version] ?? 1;
  const numShortBlocks = numBlocks - (raw % numBlocks);
  const shortBlockLen = Math.floor(raw / numBlocks);

  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + dataLen);
    k += chunk.length;
    const ecc = rsRemainder(chunk, divisor);
    const block = [...chunk];
    if (i < numShortBlocks) block.push(0); // 占位，交错时跳过
    block.push(...ecc);
    blocks.push(block);
  }

  const result: number[] = [];
  const blockLen = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLen; i++) {
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      if (block === undefined) continue;
      // 短块在这一列是占位 0，跳过
      if (i === shortBlockLen - eccLen && j < numShortBlocks) continue;
      const v = block[i];
      if (v !== undefined) result.push(v);
    }
  }
  return result;
}

/** 编码矩阵的内部状态。 */
interface Builder {
  size: number;
  mod: Uint8Array;
  fn: Uint8Array;
}

function makeBuilder(version: number): Builder {
  const size = version * 4 + 17;
  return { size, mod: new Uint8Array(size * size), fn: new Uint8Array(size * size) };
}

function setFn(b: Builder, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= b.size || y >= b.size) return;
  const i = y * b.size + x;
  b.mod[i] = dark ? 1 : 0;
  b.fn[i] = 1;
}

function isFn(b: Builder, x: number, y: number): boolean {
  return b.fn[y * b.size + x] === 1;
}

function getMod(b: Builder, x: number, y: number): boolean {
  return b.mod[y * b.size + x] === 1;
}

function drawFinder(b: Builder, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(b, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(b: Builder, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(b, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 格式信息：15 bit，BCH(15,5)，生成多项式 0x537，掩码 0x5412。 */
function drawFormatBits(b: Builder, mask: number): void {
  const data = (ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = b.size;

  // 第一份：左上角
  for (let i = 0; i <= 5; i++) setFn(b, 8, i, ((bits >>> i) & 1) === 1);
  setFn(b, 8, 7, ((bits >>> 6) & 1) === 1);
  setFn(b, 8, 8, ((bits >>> 7) & 1) === 1);
  setFn(b, 7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) setFn(b, 14 - i, 8, ((bits >>> i) & 1) === 1);

  // 第二份：右上 + 左下
  for (let i = 0; i < 8; i++) setFn(b, size - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) setFn(b, 8, size - 15 + i, ((bits >>> i) & 1) === 1);

  // 恒暗模块
  setFn(b, 8, size - 8, true);
}

/**
 * 版本信息：18 bit，BCH(18,6)，生成多项式 0x1F25，**两处**（右上 / 左下）。
 * 版本 < 7 不写。**漏了这段手机就扫不出来** —— ADR-0002 的五个易错点之一。
 */
function drawVersionBits(b: Builder, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = b.size - 11 + (i % 3);
    const c = Math.floor(i / 3);
    setFn(b, a, c, bit);
    setFn(b, c, a, bit);
  }
}

function drawFunctionPatterns(b: Builder, version: number): void {
  const size = b.size;
  // 时序图案
  for (let i = 0; i < size; i++) {
    setFn(b, 6, i, i % 2 === 0);
    setFn(b, i, 6, i % 2 === 0);
  }
  // 三个定位图案
  drawFinder(b, 3, 3);
  drawFinder(b, size - 4, 3);
  drawFinder(b, 3, size - 4);

  // 对齐图案（跳过与定位图案重叠的三个角）
  const pos = ALIGN_POS[version] ?? [];
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const skipCorner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
      if (skipCorner) continue;
      const cx = pos[i];
      const cy = pos[j];
      if (cx === undefined || cy === undefined) continue;
      drawAlignment(b, cx, cy);
    }
  }
  // 先按掩码 0 写一遍格式信息（占位，稍后按最优掩码重写）
  drawFormatBits(b, 0);
  drawVersionBits(b, version);
}

/** zigzag 铺数据码字。 */
function placeCodewords(b: Builder, codewords: readonly number[]): void {
  const size = b.size;
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖向时序列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFn(b, x, y) || i >= totalBits) continue;
        const byte = codewords[i >>> 3] ?? 0;
        b.mod[y * size + x] = ((byte >>> (7 - (i & 7))) & 1) === 1 ? 1 : 0;
        i++;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(b: Builder, mask: number): void {
  for (let y = 0; y < b.size; y++) {
    for (let x = 0; x < b.size; x++) {
      if (isFn(b, x, y)) continue;
      if (maskBit(mask, x, y)) {
        const i = y * b.size + x;
        b.mod[i] = b.mod[i] === 1 ? 0 : 1;
      }
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + 1;
  }
}

/** N1=3 / N2=3 / N3=40 / N4=10。 */
function penaltyScore(b: Builder): number {
  const size = b.size;
  let score = 0;
  const lines: string[] = [];
  for (let y = 0; y < size; y++) {
    let s = "";
    for (let x = 0; x < size; x++) s += getMod(b, x, y) ? "1" : "0";
    lines.push(s);
  }
  for (let x = 0; x < size; x++) {
    let s = "";
    for (let y = 0; y < size; y++) s += getMod(b, x, y) ? "1" : "0";
    lines.push(s);
  }
  for (const s of lines) {
    let run = 1;
    for (let i = 1; i <= s.length; i++) {
      if (i < s.length && s[i] === s[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    score += 40 * (countOccurrences(s, "10111010000") + countOccurrences(s, "00001011101"));
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = b.mod[y * size + x];
      if (c === b.mod[y * size + x + 1] && c === b.mod[(y + 1) * size + x] && c === b.mod[(y + 1) * size + x + 1]) {
        score += 3;
      }
    }
  }
  let dark = 0;
  for (let i = 0; i < b.mod.length; i++) if (b.mod[i] === 1) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/** 编码成矩阵。 */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const version = pickVersion(bytes.length);
  const b = makeBuilder(version);

  drawFunctionPatterns(b, version);
  const codewords = addEccAndInterleave(buildDataCodewords(bytes, version), version);
  placeCodewords(b, codewords);

  // 八种掩码各试一遍，取 penalty 最小的
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(b, mask);
    drawFormatBits(b, mask);
    const score = penaltyScore(b);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(b, mask); // 撤销
  }
  applyMask(b, bestMask);
  drawFormatBits(b, bestMask);

  return { size: b.size, modules: b.mod };
}

export interface QrSvgOptions {
  /** 边长（像素）。默认 168。 */
  size?: number;
  /** 静默区模块数。默认 4（标准要求）。 */
  margin?: number;
  dark?: string;
  light?: string;
}

/**
 * 渲染成 SVG 字符串。
 *
 * 只输出 `<svg>`，不带 `<?xml?>` —— 它会被塞进 DOM 的 innerHTML 里。
 * 用 `shape-rendering="crispEdges"` 保证不糊边，否则手机可能扫不出来。
 */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const { size = 168, margin = 4, dark = "#111827", light = "#ffffff" } = options;
  const matrix = encodeQr(text);
  const dim = matrix.size + margin * 2;

  let path = "";
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y * matrix.size + x] === 1) {
        path += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="登录二维码">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
