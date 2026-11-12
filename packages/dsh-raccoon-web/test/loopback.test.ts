/**
 * 浏览器 loopback 登录的单元测试（LB-1 ~ LB-26）。
 *
 * 这条路 2026-11-12 起是"加号"的主路线：扫码那条（`/login/mp`）在服务端侧
 * 已经 404，而官方桌面端换账号用的正是 `/authorize` + 本机回调 + 授权码换 token。
 *
 * 测试重点全在**拒收判据**上 —— 这是一个监听本机端口的 HTTP 服务，
 * 判据写松了，任何本机进程都能往我们池里塞一个账号。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTHORIZE_APP_NAME,
  CALLBACK_PATH,
  LOOPBACK_TIMEOUT_MS,
  authorizeUrl,
  exchangeCode,
  newState,
  parseCallback,
  startLoopback,
  type ExchangeResult,
} from "../src/protocol/loopback.js";

const STATE = "a".repeat(64);

function cb(query: string): string {
  return `${CALLBACK_PATH}?${query}`;
}

describe("authorizeUrl", () => {
  it("LB-1: 五个参数齐全，顺序与官方一致", () => {
    const url = authorizeUrl({ redirect: "http://127.0.0.1:5000/auth/callback", state: STATE });
    assert.equal(url.startsWith("https://xiaohuanxiong.com/authorize?"), true);
    const params = [...new URL(url).searchParams.entries()];
    assert.deepEqual(
      params.map(([key]) => key),
      ["login_source", "appname", "desktop_callback", "redirect", "state"],
    );
    assert.equal(params[0]?.[1], "desktop");
    assert.equal(params[1]?.[1], AUTHORIZE_APP_NAME);
    assert.equal(params[2]?.[1], "loopback");
    assert.equal(params[4]?.[1], STATE);
  });

  it("LB-2: redirect 里的端口与路径原样保留", () => {
    const redirect = "http://127.0.0.1:51789/auth/callback";
    const url = new URL(authorizeUrl({ redirect, state: STATE }));
    assert.equal(url.searchParams.get("redirect"), redirect);
  });

  it("LB-3: origin 与 appName 可覆盖（单测与将来换环境用）", () => {
    const url = new URL(
      authorizeUrl({
        redirect: "http://127.0.0.1:1/auth/callback",
        state: STATE,
        origin: "https://example.test",
        appName: "示例客户端",
      }),
    );
    assert.equal(url.origin, "https://example.test");
    assert.equal(url.searchParams.get("appname"), "示例客户端");
  });
});

describe("newState", () => {
  it("LB-4: 64 位小写 hex", () => {
    const state = newState();
    assert.equal(state.length, 64);
    assert.match(state, /^[a-f0-9]{64}$/);
  });

  it("LB-5: 两次不同", () => {
    assert.notEqual(newState(), newState());
  });
});

describe("parseCallback 的拒收判据", () => {
  it("LB-6: 合法回调给出 code", () => {
    const parsed = parseCallback(cb(`code=abc123&state=${STATE}`), STATE);
    assert.deepEqual(parsed, { code: "abc123" });
  });

  it("LB-7: 没有 url", () => {
    assert.deepEqual(parseCallback(undefined, STATE), { reason: "missing url" });
  });

  it("LB-8: url 超长（> 8192）", () => {
    const long = cb(`code=${"x".repeat(9000)}&state=${STATE}`);
    assert.deepEqual(parseCallback(long, STATE), { reason: "url too long" });
  });

  it("LB-9: 路径不对（前缀与解析后两处都查）", () => {
    assert.deepEqual(parseCallback("/other?code=a&state=" + STATE, STATE), { reason: "wrong path" });
    assert.deepEqual(parseCallback("/auth/callbackx?code=a&state=" + STATE, STATE), {
      reason: "wrong path",
    });
  });

  it("LB-10: 带 hash 一律拒", () => {
    assert.deepEqual(parseCallback(cb(`code=abc&state=${STATE}#frag`), STATE), {
      reason: "unexpected hash",
    });
  });

  it("LB-11: 多余参数一律拒（防日志注入与将来加参数被误用）", () => {
    assert.deepEqual(parseCallback(cb(`code=abc&state=${STATE}&extra=1`), STATE), {
      reason: "unexpected param",
    });
  });

  it("LB-12: state 出现两次拒", () => {
    assert.deepEqual(parseCallback(cb(`code=abc&state=${STATE}&state=${STATE}`), STATE), {
      reason: "state count",
    });
  });

  it("LB-13: code 出现两次拒", () => {
    assert.deepEqual(parseCallback(cb(`code=a&code=b&state=${STATE}`), STATE), {
      reason: "code count",
    });
  });

  it("LB-14: state 形状不对（不是 64 位 hex）", () => {
    assert.deepEqual(parseCallback(cb("code=abc&state=zzzz"), STATE), { reason: "state shape" });
  });

  it("LB-15: state 长度对但内容不同", () => {
    assert.deepEqual(parseCallback(cb(`code=abc&state=${"b".repeat(64)}`), STATE), {
      reason: "state mismatch",
    });
  });

  it("LB-16: code 是空白", () => {
    assert.deepEqual(parseCallback(cb(`code=%20%20&state=${STATE}`), STATE), { reason: "empty code" });
  });

  it("LB-17: code 超长（> 4096）", () => {
    assert.deepEqual(parseCallback(cb(`code=${"x".repeat(4100)}&state=${STATE}`), STATE), {
      reason: "code too long",
    });
  });

  it("LB-18: code 含控制字符", () => {
    assert.deepEqual(parseCallback(cb(`code=a%00b&state=${STATE}`), STATE), {
      reason: "control char in code",
    });
  });

  it("LB-19: code 两端空白会被 trim", () => {
    assert.deepEqual(parseCallback(cb(`code=%20abc%20&state=${STATE}`), STATE), { code: "abc" });
  });
});

describe("exchangeCode", () => {
  function stub(status: number, payload: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  it("LB-20: code=0 且 data.access_token → 成功，并带上 refresh_token", async () => {
    const result = await exchangeCode(
      "code-1",
      stub(200, {
        code: 0,
        message: "success",
        data: { access_token: "tok", refresh_token: "ref" },
      }),
    );
    assert.deepEqual(result, { ok: true, accessToken: "tok", refreshToken: "ref" });
  });

  it("LB-21: 只给 access_token（IAM token 不要求 refresh）也算成功", async () => {
    const result = await exchangeCode("code-1", stub(200, { code: 0, data: { access_token: "tok" } }));
    assert.deepEqual(result, { ok: true, accessToken: "tok" });
  });

  it("LB-22: 200035 授权码不存在 → 失败并带服务端文案", async () => {
    const result = await exchangeCode(
      "bad",
      stub(400, {
        code: 200035,
        message: "authorization_code_not_found_error",
        details: "authorization code not found",
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.message, "authorization_code_not_found_error");
  });

  it("LB-23: code=0 但没令牌 → 失败（不能当成功）", async () => {
    const result = await exchangeCode("code-1", stub(200, { code: 0, data: {} }));
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /没有带令牌/);
  });

  it("LB-24: 网络异常 → 失败但不抛", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await exchangeCode("code-1", boom);
    assert.equal(result.ok, false);
    assert.equal(result.message, "ECONNRESET");
  });

  it("LB-25: 非 JSON 响应 → 失败并带状态码", async () => {
    const html = (async () =>
      new Response("<html>oops</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const result = await exchangeCode("code-1", html);
    assert.equal(result.ok, false);
    assert.equal(result.message, "HTTP 502");
  });
});

describe("startLoopback", () => {
  /** 真的走一遍本机回调：起服务 → 打自己的回调地址 → 等结果。 */
  async function roundTrip(
    query: (state: string) => string,
    exchange?: (code: string) => Promise<ExchangeResult>,
  ): Promise<{ status: string; body: string; code?: string }> {
    const started = await startLoopback({
      ...(exchange === undefined ? {} : { exchange }),
      timeoutMs: 5_000,
    });
    const captured: { code?: string } = {};
    const resultPromise = started.wait.then((result) => {
      captured.code = result.accessToken;
      return result;
    });
    const response = await fetch(`${started.session.redirect}?${query(started.session.state)}`);
    const body = await response.text();
    const result = await resultPromise;
    return { status: result.status, body, ...(captured.code === undefined ? {} : { code: captured.code }) };
  }

  it("LB-26: 合法回调 → 换到 token，页面说成功", async () => {
    const seen: string[] = [];
    const result = await roundTrip(
      (state) => `code=ok-code&state=${state}`,
      async (code) => {
        seen.push(code);
        return { ok: true, accessToken: "tok-1" };
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.code, "tok-1");
    assert.deepEqual(seen, ["ok-code"]);
    assert.match(result.body, /登录成功/);
  });

  it("LB-27: state 不匹配 → 400，且不调 exchange", async () => {
    const seen: string[] = [];
    const started = await startLoopback({
      exchange: async (code) => {
        seen.push(code);
        return { ok: true, accessToken: "tok-1" };
      },
      timeoutMs: 5_000,
    });
    const response = await fetch(
      `${started.session.redirect}?code=ok-code&state=${"c".repeat(64)}`,
    );
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.match(body, /无效的回调/);
    assert.deepEqual(seen, []);
    // 判据没过不等于这一轮结束：服务还在等，主动收摊免得测试等 5 秒。
    started.close();
    const result = await started.wait;
    assert.equal(result.status, "canceled");
  });

  it("LB-28: 换 token 失败 → 502，页面说未完成", async () => {
    const result = await roundTrip(
      (state) => `code=bad&state=${state}`,
      async () => ({ ok: false, message: "authorization_code_not_found_error" }),
    );
    assert.equal(result.status, "error");
    assert.match(result.body, /authorization_code_not_found_error/);
  });

  it("LB-29: close() 立刻收摊，结果是 canceled", async () => {
    const started = await startLoopback({ timeoutMs: 5_000 });
    started.close();
    const result = await started.wait;
    assert.equal(result.status, "canceled");
  });

  it("LB-30: 超时 → expired", async () => {
    const started = await startLoopback({ timeoutMs: 30 });
    const result = await started.wait;
    assert.equal(result.status, "expired");
  });

  it("LB-31: AbortSignal 取消 → canceled", async () => {
    const controller = new AbortController();
    const started = await startLoopback({ timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    const result = await started.wait;
    assert.equal(result.status, "canceled");
  });

  it("LB-32: 只监听 127.0.0.1，端口由系统分配", async () => {
    const started = await startLoopback({ timeoutMs: 5_000 });
    try {
      assert.match(started.session.redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      assert.equal(started.session.port > 0, true);
      assert.match(started.session.url, /^https:\/\/xiaohuanxiong\.com\/authorize\?/);
    } finally {
      started.close();
      await started.wait;
    }
  });

  it("LB-33: 同一个回调打第二次 → 409（一次性）", async () => {
    const started = await startLoopback({
      exchange: async () => ({ ok: true, accessToken: "tok-1" }),
      timeoutMs: 5_000,
    });
    const first = await fetch(`${started.session.redirect}?code=a&state=${started.session.state}`);
    await first.text();
    await started.wait;
    // 服务已经关了，再打就是连不上 —— 这正是"一次性"的证明。
    await assert.rejects(async () => {
      await fetch(`${started.session.redirect}?code=a&state=${started.session.state}`);
    });
  });

  it("LB-34: 非 GET 一律 403", async () => {
    const started = await startLoopback({ timeoutMs: 5_000 });
    try {
      const response = await fetch(started.session.redirect, { method: "POST" });
      const body = await response.text();
      assert.equal(response.status, 403);
      assert.match(body, /无效的回调/);
    } finally {
      started.close();
      await started.wait;
    }
  });

  it("LB-35: LOOPBACK_TIMEOUT_MS 是 5 分钟（与官方一致）", () => {
    assert.equal(LOOPBACK_TIMEOUT_MS, 300_000);
  });
});
