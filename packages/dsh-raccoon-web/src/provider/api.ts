/**
 * raccoon-web 的 pi-ai `Api` 实现。
 *
 * ## 为什么不是 ADR-0003 最初设想的样子
 *
 * ADR-0003 写的时候假设 `extra_body.thinking` 必须靠自写 Api 才能发出去，因此
 * 计划复刻一份 SSE 解析。读到 `pi-ai/dist/api/openai-completions.js` 之后，
 * 这个假设被推翻了（实测见 docs/01-research/05-empirical-findings.md）：
 *
 *   1. `buildParams()` 在拼完 params 之后调用 `options.onPayload?.(params, model)`，
 *      返回值会替换 params（openai-completions.js:188-191）。
 *   2. `buildBaseOptions()` 原样透传 `onPayload`（simple-options.js:32）。
 *   3. **但** `PiAiAdapter` 的 `profileOptions()` 不传 `onPayload`（dsh-llm-pi-ai
 *      lib/index.js:1754-1767 只透传 apiKey/reasoning/thinkingBudgets/cacheRetention/
 *      transport/timeoutMs/websocketConnectTimeoutMs），所以我们拿不到
 *      `dsh-llm-pi-ai` 的那条通路。
 *
 * 结论：**不需要重写 SSE 状态机，只需要把 `openAICompletionsApi()` 包一层**，
 * 在调用它之前把自己的 `onPayload` 注入 options。文本 / 思考 / 工具调用 /
 * usage / finish_reason / 错误归一化全部继续由 pi-ai 现成的实现处理 ——
 * 那 400 行是已经跟真实上游对打过的，重写只会引入 bug。
 *
 * 而且 `openai-completions.js` 第 400 行原生读 `delta.reasoning_content`
 * （`reasoningFields = ["reasoning_content","reasoning","reasoning_text"]`），
 * 思考通道根本不需要我们解析。
 *
 * ## 这一层真正负责的事
 *
 * 只有一件：把 DSH 的 `reasoningEffort` 翻译成浣熊网关的私有字段
 * `extra_body: { thinking: { type: "enabled" | "disabled" } }`。
 * 语义见 `applyThinking()`（protocol/chat.ts）。
 */

import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { applyThinking } from "../protocol/chat.js";

type ApiLike = ReturnType<typeof openAICompletionsApi>;

/**
 * 一个请求的 options 里我们关心的字段。类型故意宽松 ——
 * pi-ai 没有 `.d.ts`（E-009），写死形状会在上游微调时假报警。
 */
interface LooseOptions {
  onPayload?: (params: Record<string, unknown>, model: unknown) => unknown;
  reasoningEffort?: string;
  [k: string]: unknown;
}

/**
 * 把思考开关塞进请求体。
 *
 * `extra_body` 不在 OpenAI schema 里，所以它必须是**最后一个**写入的字段，
 * 且不能覆盖上游已经写好的任何东西 —— 这里只做浅合并。
 */
function withExtraBody(
  params: Record<string, unknown>,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...params };
  applyThinking(merged, reasoningEffort);
  return merged;
}

/**
 * 包装 `openAICompletionsApi()`：唯一改动是注入 `onPayload`。
 *
 * 注意 `onPayload` 可能是上游已经设了的（目前 `PiAiAdapter` 不设，但别把
 * 这个假设写死）—— 先让它跑完，再在我们的结果上追加 extra_body。
 */
export function createRaccoonApi(reasoningEffortOf?: (model: unknown) => string | undefined): ApiLike {
  const inner = openAICompletionsApi();

  const wrap =
    (method: "stream" | "streamSimple") =>
    (model: unknown, context: unknown, options: LooseOptions = {}) => {
      const upstreamOnPayload = options.onPayload;
      const effort = options.reasoningEffort ?? reasoningEffortOf?.(model);

      const injected: LooseOptions = {
        ...options,
        onPayload: (params: Record<string, unknown>, m: unknown) => {
          // 先让上游（如果有）改，再在其结果上追加我们的私有字段。
          let base = params;
          if (typeof upstreamOnPayload === "function") {
            const replaced = upstreamOnPayload(params, m);
            if (replaced !== undefined && replaced !== null && typeof replaced === "object") {
              base = replaced as Record<string, unknown>;
            }
          }
          return withExtraBody(base, effort);
        },
      };

      // pi-ai 的 Api 方法必须**同步**返回 AssistantMessageEventStream。
      // 这里不做任何 await —— 一旦变成 async，返回值就成了 Promise，
      // 上层的 `toStreamChunks()` 会拿到一个没有 Symbol.asyncIterator 的对象。
      return (inner[method] as (m: unknown, c: unknown, o: LooseOptions) => unknown)(model, context, injected);
    };

  return {
    stream: wrap("stream"),
    streamSimple: wrap("streamSimple"),
  } as ApiLike;
}
