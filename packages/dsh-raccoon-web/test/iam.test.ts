/**
 * 登录协议单测（docs/03-plan/02-test-plan.md 的 IAM-1 ~ IAM-22）。
 *
 * 最容易写错的一条是 IAM-14/15：**网络抖动必须返回 pending，不能抛**。
 * 参考实现踩过这个坑 —— 用户在地铁里抖一下就要重新扫码。
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assertScanPath,
  confirmSession,
  cookieValue,
  createQr,
  pollQr,
  qrContent,
  validateToken,
} from "../src/protocol/iam.js";
import { failure, fakeFetch, json, text } from "./helpers.js";

/** E-001 实测响应的完整形状。 */
function qrOk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "OK",
    message: "success",
    data: {
      expires_in: 300,
      poll_interval: 2,
      qrcode_code: "qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062",
      scan_path: "/login/mp",
      status: "pending",
      ...overrides,
    },
  };
}

describe("createQr", () => {
  it("IAM-1: 正常响应解析出四个字段", async () => {
    const fetchImpl = fakeFetch(json(200, qrOk()));
    const session = await createQr(fetchImpl);
    assert.equal(session.code, "qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062");
    assert.equal(session.scanPath, "/login/mp");
    assert.equal(session.expiresIn, 300);
    assert.equal(session.pollInterval, 2);
  });

  it("IAM-2: 打的是 IAM 的 qrcode 端点，POST，带 JSON 头", async () => {
    const fetchImpl = fakeFetch(json(200, qrOk()));
    await createQr(fetchImpl);
    const call = fetchImpl.calls[0]!;
    assert.equal(call.url, "https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.body, "{}");
  });

  it("IAM-3: 缺 qrcode_code 抛 SERVER", async () => {
    const fetchImpl = fakeFetch(json(200, qrOk({ qrcode_code: undefined })));
    await assert.rejects(createQr(fetchImpl), /qrcode_code/);
  });

  it("IAM-4: expires_in 为 0 抛（说明协议变了）", async () => {
    const fetchImpl = fakeFetch(json(200, qrOk({ expires_in: 0 })));
    await assert.rejects(createQr(fetchImpl), /expires_in/);
  });

  it("IAM-5: expires_in 超过 3600 抛", async () => {
    const fetchImpl = fakeFetch(json(200, qrOk({ expires_in: 7200 })));
    await assert.rejects(createQr(fetchImpl), /expires_in/);
  });

  it("IAM-6: code 不是 OK 时抛，并带上上游原文", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "SOMETHING_ELSE", message: "boom" }));
    await assert.rejects(createQr(fetchImpl), /SOMETHING_ELSE/);
  });

  it("IAM-7: 返回 HTML 时抛 SERVER（不静默重试）", async () => {
    const fetchImpl = fakeFetch(text(502, "<html>bad gateway</html>"));
    await assert.rejects(createQr(fetchImpl), /无法解析/);
  });

  it("IAM-8: 网络错误抛 TRANSPORT", async () => {
    const fetchImpl = fakeFetch(failure(new Error("ECONNREFUSED")));
    await assert.rejects(createQr(fetchImpl), /连不上小浣熊登录服务/);
  });
});

describe("assertScanPath", () => {
  it("IAM-9: 接受站内绝对路径", () => {
    assert.equal(assertScanPath("/login/mp"), "/login/mp");
  });

  it("IAM-10: 拒绝协议相对路径 //evil.com/x（会把用户扫码结果送去第三方）", () => {
    assert.throws(() => assertScanPath("//evil.com/x"), /不是站内绝对路径/);
  });

  it("IAM-11: 拒绝绝对 URL", () => {
    assert.throws(() => assertScanPath("https://evil.com/x"), /不是站内绝对路径/);
  });

  it("IAM-12: 拒绝带 # 的路径（会把参数藏进 fragment）", () => {
    assert.throws(() => assertScanPath("/login/mp#x"), /非法字符/);
  });

  it("IAM-13: 拒绝反斜杠与空白", () => {
    assert.throws(() => assertScanPath("/login\\mp"), /非法字符/);
    assert.throws(() => assertScanPath("/login mp"), /非法字符/);
  });

  it("IAM-14: 拒绝空值与非字符串", () => {
    assert.throws(() => assertScanPath(""), /scan_path/);
    assert.throws(() => assertScanPath(undefined), /scan_path/);
    assert.throws(() => assertScanPath(42), /scan_path/);
  });
});

describe("qrContent", () => {
  it("IAM-15: 拼出实测的 149 字节内容", () => {
    const content = qrContent({
      code: "qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062",
      scanPath: "/login/mp",
      expiresIn: 300,
      pollInterval: 2,
    });
    assert.equal(
      content,
      "https://xiaohuanxiong.com/login/mp?code=qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062" +
        "&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform",
    );
    // E-007：149 字节。这个数字决定二维码要用版本 8（见 qr.test.ts QR-4）。
    assert.equal(Buffer.byteLength(content, "utf8"), 149);
  });

  it("IAM-16: 清掉 scan_path 自带的 query（不能和我们的参数混）", () => {
    const content = qrContent({
      code: "c",
      scanPath: "/login/mp?stale=1",
      expiresIn: 300,
      pollInterval: 2,
    });
    assert.ok(!content.includes("stale=1"));
    assert.ok(content.startsWith("https://xiaohuanxiong.com/login/mp?code=c"));
  });
});

describe("pollQr", () => {
  it("IAM-17: pending 原样返回，并带上 expires_in / poll_interval", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "OK", data: { status: "pending", expires_in: 269, poll_interval: 2 } }));
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "pending");
    assert.equal(poll.expiresIn, 269);
    assert.equal(poll.pollInterval, 2);
  });

  it("IAM-18: logging 与 pending 必须能区分（UI 文案不同）", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "OK", data: { status: "logging" } }));
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "logging");
  });

  it("IAM-19: success 带出 access_token 与 token_type", async () => {
    const fetchImpl = fakeFetch(
      json(200, { code: "OK", data: { status: "success", access_token: "tok-abc", token_type: "Bearer" } }),
    );
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "success");
    assert.equal(poll.accessToken, "tok-abc");
  });

  it("IAM-20: success 但没有 access_token 抛", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "OK", data: { status: "success" } }));
    await assert.rejects(pollQr("qr-1", fetchImpl), /access_token/);
  });

  it("IAM-21: token_type 不是 bearer 抛", async () => {
    const fetchImpl = fakeFetch(
      json(200, { code: "OK", data: { status: "success", access_token: "t", token_type: "mac" } }),
    );
    await assert.rejects(pollQr("qr-1", fetchImpl), /token_type/);
  });

  it("IAM-22: canceled 带出文案", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "OK", data: { status: "canceled" } }));
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "canceled");
    assert.ok(typeof poll.message === "string" && poll.message.length > 0);
  });

  it("IAM-23: AUTH_QRCODE_EXPIRED → expired", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "AUTH_QRCODE_EXPIRED" }));
    assert.equal((await pollQr("qr-1", fetchImpl)).status, "expired");
  });

  it("IAM-24: AUTH_QRCODE_NOT_FOUND → expired", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "AUTH_QRCODE_NOT_FOUND" }));
    assert.equal((await pollQr("qr-1", fetchImpl)).status, "expired");
  });

  it("IAM-25: 网络错误 → pending，**不抛**（最容易被写错的一条）", async () => {
    const fetchImpl = fakeFetch(failure(new Error("ECONNRESET")));
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "pending");
  });

  it("IAM-26: TIMEOUT 业务码 → pending", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "TIMEOUT" }));
    assert.equal((await pollQr("qr-1", fetchImpl)).status, "pending");
  });

  it("IAM-27: 返回 HTML（502 页面）→ pending", async () => {
    const fetchImpl = fakeFetch(text(502, "<html>502</html>"));
    assert.equal((await pollQr("qr-1", fetchImpl)).status, "pending");
  });

  it("IAM-28: 未知 status 按 pending 处理（宁可多等，不要误判）", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "OK", data: { status: "weird" } }));
    assert.equal((await pollQr("qr-1", fetchImpl)).status, "pending");
  });

  it("IAM-29: 其它业务错误 → error（报告但不终止）", async () => {
    const fetchImpl = fakeFetch(json(200, { code: "SOMETHING_BAD", message: "nope" }));
    const poll = await pollQr("qr-1", fetchImpl);
    assert.equal(poll.status, "error");
    assert.equal(poll.message, "nope");
  });
});

describe("cookieValue", () => {
  it("IAM-30: 从多条 Set-Cookie 里挑出目标", () => {
    const value = cookieValue(
      ["a=1; Path=/", "xhx_token=abc123; Path=/; HttpOnly", "b=2"],
      (name) => name === "xhx_token",
    );
    assert.equal(value, "abc123");
  });

  it("IAM-31: 去掉包裹的引号并 decode", () => {
    const value = cookieValue(['xhx_token="a%20b"; Path=/'], (n) => n.endsWith("xhx_token"));
    assert.equal(value, "a b");
  });

  it("IAM-32: 找不到返回 undefined", () => {
    assert.equal(cookieValue(["a=1"], (n) => n === "xhx_token"), undefined);
  });
});

describe("confirmSession", () => {
  it("IAM-33: 从 Set-Cookie 取到 xhx_token", async () => {
    const fetchImpl = fakeFetch(
      text(200, "{}", { "set-cookie": "xhx_token=tok-x; Path=/; HttpOnly" }),
    );
    assert.equal(await confirmSession("access-1", fetchImpl), "tok-x");
  });

  it("IAM-34: 失败返回 undefined，**不抛**（这一步不致命）", async () => {
    const fetchImpl = fakeFetch(failure(new Error("boom")));
    assert.equal(await confirmSession("access-1", fetchImpl), undefined);
  });

  it("IAM-35: 非 2xx 返回 undefined", async () => {
    const fetchImpl = fakeFetch(json(403, { code: 200003 }));
    assert.equal(await confirmSession("access-1", fetchImpl), undefined);
  });

  it("IAM-36: 打的是 web 的 iam/confirm，带 zh-CN 与 Bearer", async () => {
    const fetchImpl = fakeFetch(text(200, "{}"));
    await confirmSession("access-1", fetchImpl);
    const call = fetchImpl.calls[0]!;
    assert.equal(call.url, "https://xiaohuanxiong.com/api/web/auth/v1/iam/confirm");
    assert.equal(call.headers["authorization"], "Bearer access-1");
    assert.equal(call.headers["x-raccoon-language"], "zh-CN");
    assert.equal(call.body, "{}");
  });
});

describe("validateToken", () => {
  it("IAM-37: categories 是数组 → true", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: { categories: [] } }));
    assert.equal(await validateToken("t", fetchImpl), true);
  });

  it("IAM-38: HTTP 200 但 categories 不是数组 → false（不接受「200 就算成功」）", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: {} }));
    assert.equal(await validateToken("t", fetchImpl), false);
  });

  it("IAM-39: 200003 → false", async () => {
    const fetchImpl = fakeFetch(json(401, { code: 200003, message: "authorization_verify_error" }));
    assert.equal(await validateToken("t", fetchImpl), false);
  });

  it("IAM-40: 网络错误 → false，不抛", async () => {
    const fetchImpl = fakeFetch(failure(new Error("offline")));
    assert.equal(await validateToken("t", fetchImpl), false);
  });
});
