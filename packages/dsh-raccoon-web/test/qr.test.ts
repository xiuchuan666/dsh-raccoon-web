/**
 * QR 编码器单测。
 *
 * 这些用例覆盖 docs/03-plan/02-test-plan.md 的 QR-1 ~ QR-11。
 * 真解码（QR-12）不在这里 —— 它要 Python + OpenCV，由
 * `node scripts/verify-qr.mjs` 单独跑（12/12 已通过）。
 *
 * 为什么这些断言值得写：自实现 QR 的失败模式**不是抛错，是"看起来正常但扫不出来"**。
 * 所以每条断言都对着一份规格书里的硬事实（容量表、版本信息块、时序图案）。
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { MAX_VERSION, encodeQr, pickVersion, renderQrSvg } from "../src/protocol/qr.js";

/** byte 模式 + M 级各版本容量。这张表来自 ISO/IEC 18004 的容量表。 */
const CAPACITY: Record<number, number> = {
  1: 14,
  2: 26,
  3: 42,
  4: 62,
  5: 84,
  6: 106,
  7: 122,
  8: 152,
  9: 180,
  10: 213,
};

describe("pickVersion", () => {
  it("QR-1: 空内容也要给版本 1", () => {
    assert.equal(pickVersion(0), 1);
  });

  it("QR-2: 每个容量边界都选到正确的版本", () => {
    for (const [version, capacity] of Object.entries(CAPACITY)) {
      assert.equal(pickVersion(capacity), Number(version), `${capacity} 字节应该是版本 ${version}`);
    }
  });

  it("QR-3: 比容量多 1 字节就升版本", () => {
    for (const [version, capacity] of Object.entries(CAPACITY)) {
      const v = Number(version);
      if (v === MAX_VERSION) continue;
      assert.equal(pickVersion(capacity + 1), v + 1, `${capacity + 1} 字节应该跳过版本 ${v}`);
    }
  });

  it("QR-4: 二维码内容实测 149 字节 → 版本 8", () => {
    // E-007：https://xiaohuanxiong.com/login/mp?code=qr-...&appname=...&source=platform
    // 实测 149 字节。版本 7 只有 122 字节容量，不够。
    assert.equal(pickVersion(149), 8);
  });

  it("QR-5: 超过版本 10 容量直接抛（不静默降级）", () => {
    assert.throws(() => pickVersion(CAPACITY[MAX_VERSION]! + 1), /超过 QR 版本/);
  });
});

describe("encodeQr", () => {
  it("QR-6: 矩阵尺寸 = 4v + 17", () => {
    for (const [version, capacity] of Object.entries(CAPACITY)) {
      const text = "A".repeat(capacity);
      const matrix = encodeQr(text);
      assert.equal(matrix.size, Number(version) * 4 + 17, `版本 ${version} 的尺寸`);
      assert.equal(matrix.modules.length, matrix.size * matrix.size);
    }
  });

  it("QR-7: 三个定位图案的左上角与右下角是暗模块", () => {
    const matrix = encodeQr("https://xiaohuanxiong.com/login/mp");
    const at = (x: number, y: number): number => matrix.modules[y * matrix.size + x] ?? -1;
    const size = matrix.size;

    // 左上 (0,0) / 右上 (size-1,0) / 左下 (0,size-1) 都是定位图案的角
    assert.equal(at(0, 0), 1);
    assert.equal(at(size - 1, 0), 1);
    assert.equal(at(0, size - 1), 1);
    // 定位图案内圈第 7 格是分隔符（亮）
    assert.equal(at(7, 0), 0);
    assert.equal(at(0, 7), 0);
  });

  it("QR-8: 版本 ≥7 必须写版本信息块（否则手机扫不出）", () => {
    const matrix = encodeQr("B".repeat(130)); // 版本 8
    assert.ok(matrix.size >= 45, `版本 8 的尺寸应 ≥45，实际 ${matrix.size}`);

    const size = matrix.size;
    const at = (x: number, y: number): number => matrix.modules[y * size + x] ?? -1;

    // 版本信息块在 (size-11..size-9, 0..5) 与转置位置。
    // 它由 BCH(18,6) 算出，**一定不是全 0** —— 这里验证两处都有暗模块。
    let blockA = 0;
    let blockB = 0;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      blockA += at(a, c);
      blockB += at(c, a);
    }
    assert.ok(blockA > 0, "版本信息块 A 全是亮模块，说明没写");
    assert.ok(blockB > 0, "版本信息块 B 全是亮模块，说明没写");
    assert.equal(blockA, blockB, "两处版本信息块的内容必须一致");
  });

  it("QR-9: 时序图案在第 6 行与第 6 列交替", () => {
    const matrix = encodeQr("https://xiaohuanxiong.com/login/mp?x=1");
    const size = matrix.size;
    const at = (x: number, y: number): number => matrix.modules[y * size + x] ?? -1;

    // 时序图案从 (8,6) 到 (size-9,6)，交替 1/0 起于暗
    for (let i = 8; i <= size - 9; i++) {
      assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0, `(i=${i}, 6) 时序图案不对`);
      assert.equal(at(6, i), i % 2 === 0 ? 1 : 0, `(6, i=${i}) 时序图案不对`);
    }
  });

  it("QR-10: 暗模块 (x=8, y=size-8) 恒为暗", () => {
    // 规格规定的"永远为暗"的模块，用来校准阅读器的采样网格。
    // 坐标是 (列 8, 行 4v+9)，而 4v+9 === size-8 —— **不是转置的 (行 8, 列 size-8)**。
    // 第一版测试把它写反了，断言失败；实现里 `setFn(b, 8, size - 8, true)` 是对的。
    const matrix = encodeQr("hello");
    const size = matrix.size;
    assert.equal(matrix.modules[(size - 8) * size + 8], 1);
  });

  it("QR-11: 同样的输入两次编码结果完全一致（掩码选择是确定的）", () => {
    const a = encodeQr("https://xiaohuanxiong.com/login/mp");
    const b = encodeQr("https://xiaohuanxiong.com/login/mp");
    assert.deepEqual(Array.from(a.modules), Array.from(b.modules));
  });

  it("QR-12: UTF-8 中文按字节计长（不是按字符）", () => {
    const chinese = "商汤小浣熊";
    // 5 个字符 = 15 字节。版本 1 只有 14 字节容量，装不下 → 版本 2（26 字节）。
    // 如果按字符数（5）算，会错选版本 1，编码时直接溢出。
    assert.equal(Buffer.byteLength(chinese, "utf8"), 15);
    assert.equal(pickVersion(chinese.length), 1, "按字符数算会错选版本 1");
    assert.equal(pickVersion(Buffer.byteLength(chinese, "utf8")), 2);
  });
});

describe("renderQrSvg", () => {
  it("QR-13: 输出是自包含的 <svg>，带静默区与 crispEdges", () => {
    const svg = renderQrSvg("https://xiaohuanxiong.com/login/mp");
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.endsWith("</svg>"));
    assert.ok(svg.includes('shape-rendering="crispEdges"'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
    // 不能带 XML 声明：它会被塞进 innerHTML
    assert.ok(!svg.includes("<?xml"));
  });

  it("QR-14: viewBox 含静默区（margin*2）", () => {
    const matrix = encodeQr("hello");
    const svg = renderQrSvg("hello", { margin: 4 });
    assert.ok(svg.includes(`viewBox="0 0 ${matrix.size + 8} ${matrix.size + 8}"`));
  });

  it("QR-15: 尺寸参数透传", () => {
    const svg = renderQrSvg("hello", { size: 240 });
    assert.ok(svg.includes('width="240"'));
    assert.ok(svg.includes('height="240"'));
  });
});
