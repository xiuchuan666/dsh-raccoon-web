/**
 * 内核包测试桩：`@earendil-works/pi-ai` 与 `@earendil-works/pi-ai/api/openai-completions.lazy`。
 *
 * 真 pi-ai 的 `openAICompletionsApi()` 会去 `import("./openai-completions.js")`
 * 并从 `openai` 包里拉 SDK —— 单测不需要这一整条链，只需要一个"能同步返回
 * 一个 EventStream 形状对象"的替身。
 *
 * @module test/stubs/pi-ai
 */

/**
 * 假的 `createProvider`：把 input 原样挂到返回对象上，并补 `getModels`。
 * 内核真正会读的是 `id` / `name` / `getModels`。
 */
export function createProvider(input: {
  id: string;
  name?: string;
  baseUrl?: string;
  auth?: unknown;
  models: unknown[];
  api: unknown;
}) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    auth: input.auth,
    api: input.api,
    getModels: () => input.models,
  };
}

/** 一个最小的 EventStream 替身。 */
export interface PiAiEvent {
  type: string;
  [key: string]: unknown;
}

export class AssistantMessageEventStream {
  declare events: PiAiEvent[];
  declare ended: boolean;

  constructor() {
    this.events = [];
    this.ended = false;
  }

  push(event: PiAiEvent) {
    if (this.ended) return;
    this.events.push(event);
    if (event.type === "done" || event.type === "error") this.ended = true;
  }

  end() {
    this.ended = true;
  }

  result() {
    return Promise.resolve(this.events.at(-1));
  }
}

/** 工厂。 */
export function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}

/** 假的 lazyApi。返回的 `stream` 同步给一个"空回复"事件流。 */
export function lazyApi(load: () => Promise<{ stream: (...args: unknown[]) => AsyncIterable<PiAiEvent> }>) {
  const stream = (model: unknown, context: unknown, options: unknown) => {
    const out = new AssistantMessageEventStream();
    void (async () => {
      try {
        const api = await load();
        const inner = api.stream(model, context, options);
        for await (const event of inner) out.push(event);
        out.end();
      } catch (error) {
        out.push({ type: "error", reason: "error", error });
        out.end();
      }
    })();
    return out;
  };
  return { stream, streamSimple: stream };
}

/**
 * 假 `openAICompletionsApi()`。
 *
 * 真实现是 `lazyApi(() => import("./openai-completions.js"))`，会在第一次
 * 调用时才去加载 `openai` SDK。测试不需要那条链：这里返回一个把请求体
 * 原样记下来的空流，宿主层要断言的是"有没有把 extra_body 塞进 payload"。
 */
export const openAICompletionsApi = () => {
  const payloads: Record<string, unknown>[] = [];
  const stream = (model: { id: string; provider?: string }, _context: unknown, options?: {
    payloadSeed?: Record<string, unknown>;
    onPayload?: (payload: Record<string, unknown>, model: unknown) => Record<string, unknown> | undefined;
  }) => {
    const out = new AssistantMessageEventStream();
    const payload = { model: model.id, messages: [], ...(options?.payloadSeed ?? {}) };
    payloads.push(payload);
    // 走一遍上游的 onPayload，让包装层有机会注入 extra_body
    const next = options?.onPayload?.(payload, model);
    if (next !== undefined) payloads[payloads.length - 1] = next;
    out.push({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: [], provider: model.provider, model: model.id },
    });
    out.end();
    return out;
  };
  const api = { stream, streamSimple: stream, payloads };
  return api;
};
