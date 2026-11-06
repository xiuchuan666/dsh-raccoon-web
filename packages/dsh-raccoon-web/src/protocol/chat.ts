/**
 * 对话：请求体构造 + SSE 解析。
 *
 * 这一层**不产出 pi-ai 事件** —— 它只产出中性的 `RaccoonFrame`。
 * 翻译成 pi-ai 的 `text-delta` / `thinking_delta` / `tool-call-delta` 在
 * `provider/api.ts` 做。这样协议层能被单独测（ADR-0004 的直接收益）。
 *
 * 与 OpenAI 的三处不同（见 docs/01-research/03-raccoon-protocol.md §3.3）：
 *   ① 思考开关在 `extra_body.thinking`，不是顶层字段
 *   ② 思考内容回在 `delta.reasoning_content`
 *   ③ 会话 id 在 `x-raccoon-session-id` 头，稳定不变
 *
 * @module protocol/chat
 */

import { createHash } from "node:crypto";

import { FIRST_BYTE_TIMEOUT_MS, LLM_BASE, STREAM_IDLE_TIMEOUT_MS } from "./consts.js";
import { RaccoonError, isDeadSessionCode, isRateLimitCode, isRateLimited, toRaccoonError } from "./errors.js";
import { chatHeaders } from "./headers.js";

/** 请求里的消息（OpenAI 形状的超集）。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** 构造请求体所需的一切。 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  /** 从 DSH 的 reasoningEffort 透传下来。见 `applyThinking`。 */
  reasoningEffort?: string;
}

/** 归一化后的一帧。 */
export interface RaccoonFrame {
  /** 文本增量。 */
  text?: string;
  /** 思考增量（上游字段名 `reasoning_content`）。 */
  reasoning?: string;
  /** 工具调用增量。`index` 用于累积。 */
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  /** 最后一帧的用量。 */
  usage?: { input?: number; output?: number; total?: number };
  /** finish_reason。 */
  finishReason?: string;
  /** 上游在这一帧里报错。 */
  error?: { message: string; code?: string | number; rateLimited: boolean };
}

/**
 * 把 reasoningEffort 翻译成上游的思考开关。
 *
 * `off` / `none` → 关；其它一律开（`"on"` 表示"开但不指定档位"）。
 * `none` 还要额外带顶层 `reasoning_effort: "none"` —— 这是 dsh-llm-adapters
 * 实测出来的怪癖：只发 `thinking.type=disabled` 有的模型仍然会思考。
 */
export function applyThinking(body: Record<string, unknown>, effort: string | undefined): void {
  const normalized = effort?.toLowerCase();
  const off = normalized === "off" || normalized === "none";
  if (off) {
    body["extra_body"] = { thinking: { type: "disabled" } };
    if (normalized === "none") body["reasoning_effort"] = "none";
    return;
  }
  body["extra_body"] = { thinking: { type: "enabled" } };
  // "on" 只是"开"，不该把字面量 "on" 当档位发上去
  if (normalized !== undefined && normalized !== "" && normalized !== "on") {
    body["reasoning_effort"] = effort;
  }
}

/** 构造请求体。 */
export function buildBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    // 上游是 OpenAI 兼容，但实测只认 max_tokens（sensenova 的 compat 里也这么写）
    stream_options: { include_usage: true },
  };
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.topP !== undefined) body["top_p"] = request.topP;
  if (request.maxTokens !== undefined && request.maxTokens > 0) body["max_tokens"] = request.maxTokens;
  if (request.stop !== undefined && request.stop.length > 0) body["stop"] = request.stop;
  if (request.tools !== undefined && request.tools.length > 0) {
    body["tools"] = request.tools;
    body["tool_choice"] = request.toolChoice ?? "auto";
  }
  applyThinking(body, request.reasoningEffort);
  return body;
}

/**
 * 会话 id。
 *
 * `sess-0-<sha256(principal \0 model) 前 8 位>`。
 *
 * 为什么稳定：官方客户端在 26 分钟里 125 次调用都用同一个 `sess-0-53927d74`。
 * 每次请求新 id 会让网关看到"一个账号几分钟内开了几百个会话" —— 这是最容易被
 * 判成脚本的行为。所以同一个账号 + 同一个模型，永远同一个 id。
 *
 * principal 取 JWT 的 `sub`（拿不到就用 token 的哈希）。
 */
export function sessionIdFor(principal: string, model: string): string {
  const hex = createHash("sha256").update(`${principal}\u0000${model}`, "utf8").digest("hex");
  return `sess-0-${hex.slice(0, 8)}`;
}

/** 从 JWT 里不验签地读 payload。拿不到返回 undefined。 */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 算 principal：优先 JWT `sub`，否则 token 前 12 位哈希。 */
export function principalOf(token: string): string {
  const claims = jwtClaims(token);
  const sub = claims?.["sub"] ?? claims?.["user_id"] ?? claims?.["uid"];
  if (typeof sub === "string" && sub !== "") return sub;
  return `h:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * 解析一行 SSE。
 *
 * 上游在流里也会报错，形状有三种可能（Q1 未实测）：
 *   A `data: {"error": {...}}`
 *   B `data: {"code": 200429, "message": "..."}`
 *   C `{"choices":[{"delta":{"error":{...}}}]}`
 * 三种都认。认不出的帧返回 `null` —— **不能抛**，否则一个未知字段就能
 * 把整轮对话打断（CH-9）。
 */
export function parseFrame(line: string): RaccoonFrame | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;

  const data = trimmed.slice(5).trim();
  if (data === "" || data === "[DONE]") return { finishReason: "stop" };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    // 半行/畸形帧：忽略，等下一帧
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;

  // 形状 A：顶层 error
  const topError = obj["error"];
  if (typeof topError === "object" && topError !== null) {
    const e = topError as Record<string, unknown>;
    const message = typeof e["message"] === "string" ? e["message"] : JSON.stringify(e).slice(0, 500);
    const code = e["code"];
    return {
      error: {
        message,
        ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
        rateLimited: isRateLimited(undefined, message) || isRateLimited(undefined, String(code ?? "")),
      },
    };
  }

  // 形状 B：顶层 code 非 0
  const code = obj["code"];
  if (typeof code === "number" && code !== 0) {
    const message = typeof obj["message"] === "string" ? obj["message"] : `code=${code}`;
    return {
      error: {
        message,
        code,
        // 业务码 200429 也是限流（HTTP 200 也可能报限流）
        rateLimited: isRateLimitCode(code) || isRateLimited(undefined, message),
      },
    };
  }

  const usageRaw = obj["usage"];
  const usage =
    typeof usageRaw === "object" && usageRaw !== null
      ? {
          ...numericIf("input", (usageRaw as Record<string, unknown>)["prompt_tokens"]),
          ...numericIf("output", (usageRaw as Record<string, unknown>)["completion_tokens"]),
          ...numericIf("total", (usageRaw as Record<string, unknown>)["total_tokens"]),
        }
      : undefined;

  const choices = obj["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return usage !== undefined ? { usage } : null;
  }
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (choice === undefined) return usage !== undefined ? { usage } : null;

  const delta = choice["delta"] as Record<string, unknown> | undefined;
  const frame: RaccoonFrame = {};
  if (usage !== undefined) frame["usage"] = usage;

  const finish = choice["finish_reason"];
  if (typeof finish === "string") frame.finishReason = finish;

  if (delta !== undefined && delta !== null) {
    // 形状 C：delta 里带 error
    const deltaError = delta["error"];
    if (typeof deltaError === "object" && deltaError !== null) {
      const e = deltaError as Record<string, unknown>;
      const message = typeof e["message"] === "string" ? e["message"] : "上游返回了错误帧";
      return {
        error: {
          message,
          ...(typeof e["code"] === "string" || typeof e["code"] === "number" ? { code: e["code"] } : {}),
          rateLimited: isRateLimited(undefined, message),
        },
      };
    }

    const content = delta["content"];
    if (typeof content === "string" && content !== "") frame.text = content;

    // 思考内容：上游用非标准字段。三个名字都认（pi-ai 也是这么做的）
    for (const k of ["reasoning_content", "reasoning", "reasoning_text"]) {
      const v = delta[k];
      if (typeof v === "string" && v !== "") {
        frame.reasoning = (frame.reasoning ?? "") + v;
        break;
      }
    }

    const toolCalls = delta["tool_calls"];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const tc = toolCalls[0] as Record<string, unknown> | undefined;
      if (tc !== undefined) {
        const fn = tc["function"] as Record<string, unknown> | undefined;
        const index = typeof tc["index"] === "number" ? tc["index"] : 0;
        frame.toolCall = {
          index,
          ...(typeof tc["id"] === "string" && tc["id"] !== "" ? { id: tc["id"] } : {}),
          ...(typeof fn?.["name"] === "string" && fn["name"] !== "" ? { name: fn["name"] } : {}),
          ...(typeof fn?.["arguments"] === "string" ? { argumentsDelta: fn["arguments"] } : {}),
        };
      }
    }
  }

  return Object.keys(frame).length === 0 ? null : frame;
}

function numericIf<K extends string>(key: K, value: unknown): Record<K, number> | Record<string, never> {
  return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Record<K, number>) : {};
}

export interface ChatStreamOptions {
  /** 首字节超时。到了就 abort。 */
  firstByteTimeoutMs?: number;
  /** 两个 chunk 之间的最大间隔。 */
  idleTimeoutMs?: number;
  /** 外部取消信号（用户点停止）。 */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * 发请求 + 逐帧回调。
 *
 * 超时策略（三层）：
 *   ① 首字节：`firstByteTimeoutMs`（默认 60s）内一个 chunk 都没有 → TIMEOUT
 *   ② idle：两个 chunk 之间超过 `idleTimeoutMs`（默认 120s）→ TIMEOUT
 *   ③ 外部 abort → ABORTED（不显示错误）
 *
 * 首字节一到就把定时器换成 idle 定时器 —— 否则长回复会被首字节定时器误杀。
 */
export async function chatStream(
  token: string,
  body: Record<string, unknown>,
  onFrame: (frame: RaccoonFrame) => void,
  options: ChatStreamOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;

  const model = typeof body["model"] === "string" ? body["model"] : "";
  const sessionId = sessionIdFor(principalOf(token), model);

  const controller = new AbortController();
  let timedOut = false;
  let firstByteSeen = false;

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, firstByteTimeoutMs);

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const armIdleTimer = (): void => {
    clearTimer();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  const onExternalAbort = (): void => {
    clearTimer();
    controller.abort();
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetchImpl(`${LLM_BASE}/chat/completions`, {
        method: "POST",
        headers: chatHeaders(token, sessionId),
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimer();
      if (timedOut) {
        throw new RaccoonError(
          "TIMEOUT",
          `小浣熊 ${Math.round(firstByteTimeoutMs / 1000)} 秒内没有返回第一个字节`,
          { cause: err },
        );
      }
      if (options.signal?.aborted === true) throw new RaccoonError("ABORTED", "已取消", { cause: err });
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new RaccoonError("ABORTED", "已取消", { cause: err });
      }
      throw new RaccoonError("TRANSPORT", `连不上小浣熊：${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }

    if (!res.ok) {
      clearTimer();
      const text = await res.text().catch(() => "");
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown }).code;
      } catch {
        code = undefined;
      }
      if (res.status === 401 || res.status === 403 || isDeadSessionCode(code)) {
        throw new RaccoonError("AUTH", "小浣熊登录已失效", { status: res.status, upstream: text });
      }
      if (isRateLimited(res.status, text)) {
        throw new RaccoonError("RATE_LIMIT", "小浣熊限流", { status: res.status, upstream: text });
      }
      if (res.status === 413) {
        throw new RaccoonError("INVALID_REQUEST", "请求体太大（HTTP 413）", { status: 413, upstream: text });
      }
      if (res.status >= 500) {
        throw new RaccoonError("SERVER", `小浣熊上游返回 HTTP ${res.status}`, { status: res.status, upstream: text });
      }
      throw new RaccoonError("INVALID_REQUEST", `小浣熊拒绝了请求（HTTP ${res.status}）`, {
        status: res.status,
        upstream: text,
      });
    }

    const stream = res.body;
    if (stream === null) {
      clearTimer();
      throw new RaccoonError("SERVER", "小浣熊返回了空响应体");
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstByteSeen) {
          firstByteSeen = true;
          armIdleTimer();
        } else {
          armIdleTimer();
        }

        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件；逐行处理更稳（上游一个 chunk 可能含多行）
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const frame = parseFrame(line);
          if (frame !== null) {
            if (frame.error !== undefined) {
              if (frame.error.rateLimited) {
                throw new RaccoonError("RATE_LIMIT", "小浣熊限流", { upstream: frame.error.message });
              }
              throw new RaccoonError("SERVER", frame.error.message, {
                upstream: String(frame.error.code ?? ""),
              });
            }
            onFrame(frame);
          }
          nl = buffer.indexOf("\n");
        }
      }
      // 尾部的半行也可能是完整帧
      if (buffer.trim() !== "") {
        const frame = parseFrame(buffer);
        if (frame !== null && frame.error === undefined) onFrame(frame);
      }
    } catch (err) {
      if (err instanceof RaccoonError) throw err;
      if (timedOut) {
        throw new RaccoonError("TIMEOUT", "回复中断：小浣熊长时间没有推送新内容", { cause: err });
      }
      if (options.signal?.aborted === true) throw new RaccoonError("ABORTED", "已取消", { cause: err });
      throw toRaccoonError(err, "SERVER");
    } finally {
      clearTimer();
      reader.releaseLock();
    }
  } finally {
    clearTimer();
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
