/**
 * SSE / 请求体 / 会话 id 单测（docs/03-plan/02-test-plan.md 的 CH-1 ~ CH-21）。
 *
 * 两条最关键的：
 *   CH-9  不认识的帧返回 null，**不抛** —— 否则上游加个字段就能打断整轮对话。
 *   CH-18~21 applyThinking 四态 —— 思考开关是小浣熊唯一的私有扩展点。
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyThinking,
  buildBody,
  chatStream,
  jwtClaims,
  parseFrame,
  principalOf,
  sessionIdFor,
} from "../src/protocol/chat.js";
import { RaccoonError } from "../src/protocol/errors.js";
import { failure, fakeFetch, frame, hangingFetch, json, sse } from "./helpers.js";

describe("parseFrame", () => {
  it("CH-1: 空行与注释行返回 null", () => {
    assert.equal(parseFrame(""), null);
    assert.equal(parseFrame("   "), null);
    assert.equal(parseFrame(": keep-alive"), null);
  });

  it("CH-2: 非 data: 行返回 null", () => {
    assert.equal(parseFrame("event: message"), null);
  });

  it("CH-3: [DONE] → finishReason stop", () => {
    assert.deepEqual(parseFrame("data: [DONE]"), { finishReason: "stop" });
  });

  it("CH-4: 文本增量", () => {
    const f = parseFrame(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}`);
    assert.equal(f?.text, "你好");
  });

  it("CH-5: reasoning_content 是思考通道", () => {
    const f = parseFrame(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想一想" } }] })}`);
    assert.equal(f?.reasoning, "想一想");
  });

  it("CH-6: reasoning 与 reasoning_text 两个别名也认", () => {
    assert.equal(parseFrame(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "a" } }] })}`)?.reasoning, "a");
    assert.equal(
      parseFrame(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_text: "b" } }] })}`)?.reasoning,
      "b",
    );
  });

  it("CH-7: tool_calls 增量带 index", () => {
    const f = parseFrame(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "read", arguments: '{"a"' } }] } }],
      })}`,
    );
    assert.deepEqual(f?.toolCall, { index: 1, id: "call_1", name: "read", argumentsDelta: '{"a"' });
  });

  it("CH-8: usage 只取三个数", () => {
    const f = parseFrame(
      `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}`,
    );
    assert.deepEqual(f?.usage, { input: 10, output: 20, total: 30 });
  });

  it("CH-9: 不认识的帧返回 null，不抛", () => {
    assert.equal(parseFrame(`data: ${JSON.stringify({ weird: true })}`), null);
    assert.equal(parseFrame("data: {broken json"), null);
    assert.equal(parseFrame("data: 42"), null);
    assert.equal(parseFrame("data: null"), null);
  });

  it("CH-10: 顶层 error 形状（Q1 形状 A）", () => {
    const f = parseFrame(`data: ${JSON.stringify({ error: { message: "上游炸了", code: "X" } })}`);
    assert.equal(f?.error?.message, "上游炸了");
    assert.equal(f?.error?.code, "X");
    assert.equal(f?.error?.rateLimited, false);
  });

  it("CH-11: 顶层 code 非 0 形状（Q1 形状 B）", () => {
    const f = parseFrame(`data: ${JSON.stringify({ code: 200429, message: "too many" })}`);
    assert.equal(f?.error?.code, 200429);
    assert.equal(f?.error?.rateLimited, true);
  });

  it("CH-12: delta.error 形状（Q1 形状 C）", () => {
    const f = parseFrame(`data: ${JSON.stringify({ choices: [{ delta: { error: { message: "nope" } } }] })}`);
    assert.equal(f?.error?.message, "nope");
  });

  it("CH-13: finish_reason 单独也认", () => {
    assert.equal(parseFrame(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`)?.finishReason, "length");
  });
});

describe("applyThinking", () => {
  it("CH-14: off → thinking.type=disabled，不带 reasoning_effort", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, "off");
    assert.deepEqual(body["extra_body"], { thinking: { type: "disabled" } });
    assert.equal(body["reasoning_effort"], undefined);
  });

  it("CH-15: none → disabled 且额外带 reasoning_effort=none", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, "none");
    assert.deepEqual(body["extra_body"], { thinking: { type: "disabled" } });
    assert.equal(body["reasoning_effort"], "none");
  });

  it("CH-16: on → enabled，但不把字面量 on 当档位发上去", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, "on");
    assert.deepEqual(body["extra_body"], { thinking: { type: "enabled" } });
    assert.equal(body["reasoning_effort"], undefined);
  });

  it("CH-17: high → enabled + reasoning_effort=high", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, "high");
    assert.deepEqual(body["extra_body"], { thinking: { type: "enabled" } });
    assert.equal(body["reasoning_effort"], "high");
  });

  it("CH-18: undefined → enabled（默认开思考）", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, undefined);
    assert.deepEqual(body["extra_body"], { thinking: { type: "enabled" } });
  });

  it("CH-19: 大小写不敏感（OFF 也是关）", () => {
    const body: Record<string, unknown> = {};
    applyThinking(body, "OFF");
    assert.deepEqual(body["extra_body"], { thinking: { type: "disabled" } });
  });
});

describe("buildBody", () => {
  it("CH-20: 必带 stream 与 stream_options.include_usage", () => {
    const body = buildBody({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.equal(body["stream"], true);
    assert.deepEqual(body["stream_options"], { include_usage: true });
    assert.equal(body["model"], "m");
  });

  it("CH-21: maxTokens → max_tokens（不是 max_completion_tokens）", () => {
    const body = buildBody({ model: "m", messages: [], maxTokens: 100 });
    assert.equal(body["max_tokens"], 100);
    assert.equal(body["max_completion_tokens"], undefined);
  });

  it("CH-22: maxTokens 为 0 或负数时不发", () => {
    assert.equal(buildBody({ model: "m", messages: [], maxTokens: 0 })["max_tokens"], undefined);
    assert.equal(buildBody({ model: "m", messages: [], maxTokens: -1 })["max_tokens"], undefined);
  });

  it("CH-23: 有 tools 才带 tool_choice", () => {
    const withTools = buildBody({
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "f", description: "", parameters: {} } }],
    });
    assert.equal(withTools["tool_choice"], "auto");
    assert.equal(buildBody({ model: "m", messages: [] })["tool_choice"], undefined);
  });
});

describe("sessionIdFor / principalOf", () => {
  it("CH-24: sessionId 形状是 sess-0-<8 hex>", () => {
    assert.match(sessionIdFor("user-1", "GLM-5-3"), /^sess-0-[0-9a-f]{8}$/);
  });

  it("CH-25: 同账号同模型永远同一个 id（这是反风控的关键）", () => {
    assert.equal(sessionIdFor("user-1", "GLM-5-3"), sessionIdFor("user-1", "GLM-5-3"));
  });

  it("CH-26: 换模型就换 id（上游按模型分会话）", () => {
    assert.notEqual(sessionIdFor("user-1", "GLM-5-3"), sessionIdFor("user-1", "Kimi-K3"));
  });

  it("CH-27: 换账号就换 id", () => {
    assert.notEqual(sessionIdFor("user-1", "GLM-5-3"), sessionIdFor("user-2", "GLM-5-3"));
  });

  it("CH-28: principal 优先取 JWT 的 sub", () => {
    // 不验签的解析：中间那段 base64url
    const payload = Buffer.from(JSON.stringify({ sub: "u-42" })).toString("base64url");
    const token = `h.${payload}.s`;
    assert.deepEqual(jwtClaims(token), { sub: "u-42" });
    assert.equal(principalOf(token), "u-42");
  });

  it("CH-29: 非 JWT 时退回 token 哈希前缀", () => {
    const principal = principalOf("xhx_opaque_token");
    assert.match(principal, /^h:[0-9a-f]{12}$/);
  });

  it("CH-30: 空 token 也不炸", () => {
    assert.match(principalOf(""), /^h:[0-9a-f]{12}$/);
  });
});

describe("chatStream", () => {
  it("CH-31: 逐帧回调文本", async () => {
    const fetchImpl = fakeFetch(
      sse([frame({ choices: [{ delta: { content: "你" } }] }), frame({ choices: [{ delta: { content: "好" } }] }), "data: [DONE]\n\n"]),
    );
    const pieces: string[] = [];
    let finished = false;
    await chatStream("tok", { model: "m" }, (f) => {
      if (f.text !== undefined) pieces.push(f.text);
      if (f.finishReason !== undefined) finished = true;
    }, { fetchImpl });
    assert.deepEqual(pieces, ["你", "好"]);
    assert.equal(finished, true);
  });

  it("CH-32: 打的是 /api/web/llm/v2/chat/completions，带 authorization 与 session id", async () => {
    const fetchImpl = fakeFetch(sse(["data: [DONE]\n\n"]));
    await chatStream("tok", { model: "GLM-5-3" }, () => {}, { fetchImpl });
    const call = fetchImpl.calls[0]!;
    assert.equal(call.url, "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["authorization"], "Bearer tok");
    assert.match(call.headers["x-raccoon-session-id"] ?? "", /^sess-0-[0-9a-f]{8}$/);
    // 这几个头是官方客户端特征，缺了容易被判成脚本
    assert.equal(call.headers["x-raccoon-language"], "zh");
    assert.equal(call.headers["x-client-platform"], "desktop-windows");
    assert.equal(call.headers["x-client-version"], "v1.0.35");
    assert.equal(call.headers["x-org-code"], "");
  });

  it("CH-33: 一个 chunk 里含多行也能全解出来", async () => {
    const fetchImpl = fakeFetch(
      sse([frame({ choices: [{ delta: { content: "a" } }] }) + frame({ choices: [{ delta: { content: "b" } }] })]),
    );
    const pieces: string[] = [];
    await chatStream("tok", { model: "m" }, (f) => { if (f.text !== undefined) pieces.push(f.text); }, { fetchImpl });
    assert.deepEqual(pieces, ["a", "b"]);
  });

  it("CH-34: 尾部没有换行的半行也尝试解析", async () => {
    const fetchImpl = fakeFetch(sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`]));
    const pieces: string[] = [];
    await chatStream("tok", { model: "m" }, (f) => { if (f.text !== undefined) pieces.push(f.text); }, { fetchImpl });
    assert.deepEqual(pieces, ["tail"]);
  });

  it("CH-35: 401 → AUTH", async () => {
    const fetchImpl = fakeFetch(json(401, { code: 200003, message: "authorization_verify_error" }));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "AUTH";
    });
  });

  it("CH-36: 429 → RATE_LIMIT", async () => {
    const fetchImpl = fakeFetch(json(429, { message: "user_model_rate_limited" }));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "RATE_LIMIT";
    });
  });

  it("CH-37: 413 → INVALID_REQUEST", async () => {
    const fetchImpl = fakeFetch(json(413, { message: "too large" }));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "INVALID_REQUEST";
    });
  });

  it("CH-38: 500 → SERVER", async () => {
    const fetchImpl = fakeFetch(json(500, { message: "boom" }));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "SERVER";
    });
  });

  it("CH-39: 网络错误 → TRANSPORT", async () => {
    const fetchImpl = fakeFetch(failure(new Error("ECONNREFUSED")));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "TRANSPORT";
    });
  });

  it("CH-40: 首字节超时 → TIMEOUT", async () => {
    const fetchImpl = hangingFetch();
    await assert.rejects(
      chatStream("tok", { model: "m" }, () => {}, { fetchImpl, firstByteTimeoutMs: 30 }),
      (err: unknown) => err instanceof RaccoonError && err.kind === "TIMEOUT",
    );
  });

  it("CH-41: 外部 abort → ABORTED", async () => {
    const fetchImpl = hangingFetch();
    const controller = new AbortController();
    const promise = chatStream("tok", { model: "m" }, () => {}, {
      fetchImpl,
      firstByteTimeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, (err: unknown) => err instanceof RaccoonError && err.kind === "ABORTED");
  });

  it("CH-42: 流里出现限流帧 → RATE_LIMIT（200 也可能报错）", async () => {
    const fetchImpl = fakeFetch(sse([frame({ code: 200429, message: "user_model_rate_limited" })]));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "RATE_LIMIT";
    });
  });

  it("CH-43: 流里出现普通错误帧 → SERVER", async () => {
    const fetchImpl = fakeFetch(sse([frame({ error: { message: "上游炸了" } })]));
    await assert.rejects(chatStream("tok", { model: "m" }, () => {}, { fetchImpl }), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "SERVER";
    });
  });
});
