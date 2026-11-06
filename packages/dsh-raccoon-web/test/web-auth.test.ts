/**
 * Web auth 扫码协议单测（docs/03-plan/02-test-plan.md 的 WA-1 ~ WA-14）。
 *
 * 这一套与 `iam.ts` 是**不同命名空间**（E-030）。最容易被误改的两处：
 *
 * 1. `appname` 是「小浣熊官网」而不是「商汤小浣熊」。
 * 2. `login_with_qrcode_code` 对任何格式正确的 code 都回 `pending` ——
 *    所以"能不能用"只能靠 `success` 判断，不能靠 `pending` 反推。
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  WEB_QR_APP_NAME,
  createWebSession,
  generateWebCode,
  isWebCode,
  pollWebSession,
  webQrContent,
} from "../src/protocol/web-auth.js";
import { pickVersion } from "../src/protocol/qr.js";
import { fakeFetch, json, text } from "./helpers.js";

const CODE_RE = /^\d{13}[a-f0-9]{32}$/;

describe("generateWebCode", () => {
  it("WA-1: 形状是 13 位毫秒 + 32 位小写 hex", () => {
    const code = generateWebCode(1_793_936_829_945);
    assert.match(code, CODE_RE);
    assert.equal(code.length, 45);
    assert.ok(code.startsWith("1793936829945"));
  });

  it("WA-2: 同一个时间戳两次生成不同（后半段是随机数）", () => {
    const a = generateWebCode(1_793_936_829_945);
    const b = generateWebCode(1_793_936_829_945);
    assert.notEqual(a, b);
    assert.equal(a.slice(0, 13), b.slice(0, 13));
  });

  it("WA-3: 大小写不产生大写 hex（官方是 /^\\d{13}[a-f0-9]{32}$/）", () => {
    for (let i = 0; i < 20; i++) {
      assert.match(generateWebCode(), CODE_RE);
    }
  });
});

describe("isWebCode", () => {
  it("WA-4: 只认 45 字符那种形状", () => {
    assert.equal(isWebCode(generateWebCode()), true);
    // IAM 码：不能当 Web 码用（两套命名空间不同）
    assert.equal(isWebCode("qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062"), false);
    // 大写的 hex 不认（官方入口正则就是小写）
    assert.equal(isWebCode(`1793936829945${"A".repeat(32)}`), false);
    assert.equal(isWebCode(""), false);
    assert.equal(isWebCode(undefined), false);
    assert.equal(isWebCode(123), false);
  });
});

describe("createWebSession", () => {
  it("WA-5: 默认 300 秒 / 2 秒轮询，不发任何网络请求", () => {
    const session = createWebSession(1_793_936_829_945);
    assert.equal(session.expiresIn, 300);
    assert.equal(session.pollInterval, 2);
    assert.match(session.code, CODE_RE);
  });

  it("WA-6: 参数可覆盖（测试与设置需要）", () => {
    const session = createWebSession(1_793_936_829_945, 60, 1);
    assert.equal(session.expiresIn, 60);
    assert.equal(session.pollInterval, 1);
  });
});

describe("webQrContent", () => {
  it("WA-7: appname 是「小浣熊官网」，不是「商汤小浣熊」", () => {
    const session = { code: generateWebCode(1_793_936_829_945), expiresIn: 300, pollInterval: 2 };
    const url = new URL(webQrContent(session));
    assert.equal(url.searchParams.get("appname"), WEB_QR_APP_NAME);
    assert.equal(url.searchParams.get("appname"), "小浣熊官网");
  });

  it("WA-8: 路径是 /login/mp，code 原样带上，没有额外参数", () => {
    const session = { code: generateWebCode(1_793_936_829_945), expiresIn: 300, pollInterval: 2 };
    const url = new URL(webQrContent(session));
    assert.equal(url.pathname, "/login/mp");
    assert.equal(url.origin, "https://xiaohuanxiong.com");
    assert.equal(url.searchParams.get("code"), session.code);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["appname", "code"]);
    assert.equal(url.hash, "");
  });

  it("WA-9: 实测 139 字节 → QR 版本 8（与 IAM 码同版本）", () => {
    const session = { code: generateWebCode(1_793_936_829_945), expiresIn: 300, pollInterval: 2 };
    const content = webQrContent(session);
    // 2026-11-06 实测：Web 码的二维码内容 139 字节。
    // 版本 7 容量 122 字节不够，版本 8 容量 152 → 正好落在 8。
    // 这也说明"版本 ≥7 必须写版本信息块"这条对我们**始终**成立，
    // 不是边缘情况（见 ADR-0002 的五个易错点）。
    const bytes = Buffer.byteLength(content);
    assert.ok(bytes > 122 && bytes <= 152, `实际 ${bytes} 字节`);
    assert.equal(pickVersion(bytes), 8);
  });
});

describe("pollWebSession", () => {
  it("WA-10: pending 就是 pending（这个端点无状态，不能靠它判有效）", async () => {
    const code = generateWebCode();
    const fetchImpl = fakeFetch(json(200, { code: 0, message: "success", data: { status: "pending" } }));
    const poll = await pollWebSession(code, fetchImpl);
    assert.equal(poll.status, "pending");
    const call = fetchImpl.calls[0]!;
    assert.equal(call.url, "https://xiaohuanxiong.com/api/web/auth/v1/login_with_qrcode_code");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body!), { qrcode_code: code });
  });

  it("WA-11: success 带 accessToken，两种大小写键名都认", async () => {
    const code = generateWebCode();
    const camel = await pollWebSession(
      code,
      fakeFetch(json(200, { code: 0, data: { status: "success", tokens: { accessToken: "tok-a" } } })),
    );
    assert.equal(camel.status, "success");
    assert.equal(camel.accessToken, "tok-a");

    const snake = await pollWebSession(
      code,
      fakeFetch(json(200, { code: 0, data: { status: "success", tokens: { access_token: "tok-b" } } })),
    );
    assert.equal(snake.accessToken, "tok-b");
  });

  it("WA-12: success 没带令牌是错误，不是 success", async () => {
    const poll = await pollWebSession(
      generateWebCode(),
      fakeFetch(json(200, { code: 0, data: { status: "success", tokens: {} } })),
    );
    assert.equal(poll.status, "error");
    assert.match(poll.message ?? "", /没有带令牌/);
  });

  it("WA-13: 网络错误返回 pending（抖动不能杀登录）", async () => {
    const code = generateWebCode();
    const poll = await pollWebSession(code, fakeFetch({ kind: "throw", error: new TypeError("fetch failed") }));
    assert.equal(poll.status, "pending");
  });

  it("WA-14: 非 JSON 响应：200 当 pending，非 200 当 error", async () => {
    const code = generateWebCode();
    const ok = await pollWebSession(code, fakeFetch(text(200, "<html>oops</html>")));
    assert.equal(ok.status, "pending");
    const bad = await pollWebSession(code, fakeFetch(text(502, "<html>oops</html>")));
    assert.equal(bad.status, "error");
  });

  it("WA-15: 401/403 视为 expired（会话真的没了，不是抖动）", async () => {
    const code = generateWebCode();
    const poll = await pollWebSession(code, fakeFetch(json(401, { code: 200003, message: "authorization_verify_error" })));
    assert.equal(poll.status, "expired");
  });

  it("WA-16: 业务码非 0 是 error（带后端文案）", async () => {
    const poll = await pollWebSession(
      generateWebCode(),
      fakeFetch(json(200, { code: 20_035, message: "authorization code invalid" })),
    );
    assert.equal(poll.status, "error");
    assert.match(poll.message ?? "", /invalid/);
  });

  it("WA-17: logging / canceled / expired 三个中间态都认", async () => {
    const code = generateWebCode();
    assert.equal((await pollWebSession(code, fakeFetch(json(200, { code: 0, data: { status: "logging" } })))).status, "logging");
    assert.equal(
      (await pollWebSession(code, fakeFetch(json(200, { code: 0, data: { status: "canceled" } })))).status,
      "canceled",
    );
    assert.equal(
      (await pollWebSession(code, fakeFetch(json(200, { code: 0, data: { status: "expired" } })))).status,
      "expired",
    );
  });

  it("WA-18: 未知 status 当 pending（上游加新状态不该让用户登录失败）", async () => {
    const poll = await pollWebSession(generateWebCode(), fakeFetch(json(200, { code: 0, data: { status: "verifying" } })));
    assert.equal(poll.status, "pending");
  });

  it("WA-19: 不是 Web 码就直接报会话失效，不打网络", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: { status: "pending" } }));
    const poll = await pollWebSession("qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062", fetchImpl);
    assert.equal(poll.status, "error");
    assert.equal(fetchImpl.calls.length, 0);
  });
});
