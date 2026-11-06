/**
 * 模型名册 → pi-ai 模型描述符。
 *
 * ## 这份文件里每个字段都是踩出来的
 *
 * - `api: "raccoon-chat"` 必须与 `createRaccoonApi` 注册的 api id 一致，
 *   否则 `createProvider` 的 `dispatch` 找不到实现，请求会在
 *   `ModelsError("stream", "Provider ... has no API implementation for ...")` 处炸掉。
 * - `compat.maxTokensField: "max_tokens"` **必须显式写**。pi-ai 的
 *   `detectCompat()` 按 provider 名与 baseUrl 子串识别（dist/api/openai-completions.js:1225-1265），
 *   `raccoon-web` 与 `xiaohuanxiong.com` 都不在任何白名单里，于是
 *   `useMaxTokens` 为 false，默认发 `max_completion_tokens` —— 浣熊网关不认这个字段，
 *   `max_tokens` 会静默失效，导致输出被默认上限截断。
 * - `compat.supportsDeveloperRole: false`：浣熊网关只认 `system`，`developer` 角色会被拒。
 * - `compat.supportsStore: false`：网关没有 `/responses` 语义，别发 store。
 * - `reasoning: true` 但**不设** `thinkingLevelMap`：见下面的注释。
 */

import { API_ID, DEFAULT_CONTEXT_CAP, LLM_BASE, PROVIDER_ID } from "../protocol/consts.js";
import { chatModelHeaders } from "../protocol/headers.js";
import type { RaccoonModel } from "../protocol/catalog.js";

/**
 * 真正的对话地址，独立导出让测试与 probe 脚本能直接断言。
 *
 * **注意 baseUrl 不能写这个。** pi-ai 的 `createClient()` 把 `model.baseUrl`
 * 原样交给 OpenAI SDK 的 `baseURL`（dist/api/openai-completions.js:559），
 * 而 SDK 在 `client.chat.completions.create()` 里自己拼 `/chat/completions`。
 * 所以 `baseUrl` 必须是 `LLM_BASE`，写全路径会变成
 * `.../llm/v2/chat/completions/chat/completions` → 404。
 */
export const LLM_CHAT_URL = `${LLM_BASE}/chat/completions`;


/** pi-ai 的 model descriptor（内核无 .d.ts，手工形状）。 */
export interface ModelDescriptor {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers: Record<string, string>;
  compat: Record<string, unknown>;
}

/**
 * 浣熊按积分计费，不按美元。pi-ai 的 `calculateCost()` 会用这个 cost 表算钱，
 * 全填 0 就不会在 UI 上显示一个假的金额。真实消耗用积分块单独展示。
 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * 传给 `createProvider()` 的 `models` 数组。请求头**不在这里** ——
 * header 里要带 `authorization: Bearer <token>` 与随模型变化的
 * `x-raccoon-session-id`，而 token 会变。所以 headers 留空，
 * 由 `resolveApiKey` + `requestHeaders()`（dsh-llm-pi-ai 的 profile.headers）承担。
 *
 * 注意 `PiAiAdapter` 会调用 `requestHeaders(profile.headers)`，它把 attribution
 * 头（`User-Agent` 之类）拼上去，**并剔除同名冲突**（lib/index.js:1817-1824）。
 * 所以认证头不能走 profile.headers，要走 pi-ai 自己的 apiKey 通路。
 */
export interface RosterOptions {
  /** 覆盖目录给的 contextWindow（settings 的 contextCap）。 */
  contextCap?: number;
  /** 识图实测覆盖：model id → 是否支持。见 ADR-0006。 */
  visionProbe?: ReadonlyMap<string, boolean>;
  /**
   * 给某个模型算 `x-raccoon-session-id`。
   *
   * 由 host 层用 `sessionIdFor(principalOf(token), modelId)` 注入。
   * 不传时 descriptor 的 headers 里就没有会话头 —— 只在无 token
   * 的占位名册（fallback）路径下会发生，那条路径本来也发不出请求。
   */
  sessionIdFor?: (modelId: string) => string;
}

/**
 * 显示名带上倍率后缀。
 *
 * 为什么拼在 name 里而不是另开字段：DSH 的模型选择器只渲染 `name`，
 * 没有地方放自定义 badge。倍率是用户决定"用哪个模型"的关键信息
 * （x0.2 与 x1 差 5 倍积分），藏起来等于让用户在不知情的情况下烧积分。
 */
function displayName(model: RaccoonModel): string {
  if (model.multiplier === undefined) return model.name;
  return `${model.name} · x${model.multiplier.toFixed(2)}`;
}

/** 把一条目录模型转成 pi-ai 能吃的 descriptor。 */
export function toDescriptor(model: RaccoonModel, options: RosterOptions = {}): ModelDescriptor {
  const probed = options.visionProbe?.get(model.id);
  // 实测优先于标签：ADR-0006 记录了 5 个模型里错 2 个的两个方向。
  const vision = probed ?? model.vision;

  const contextWindow = Math.min(
    model.contextWindow ?? DEFAULT_CONTEXT_CAP,
    options.contextCap ?? Number.POSITIVE_INFINITY,
  );
  const maxTokens = Math.min(model.maxOutput ?? 8_192, Math.floor(contextWindow / 2));

  const sessionId = options.sessionIdFor?.(model.id);

  return {
    id: model.id,
    name: displayName(model),
    api: API_ID,
    provider: PROVIDER_ID,
    /**
     * `baseUrl` 是 **SDK baseURL**，不是完整端点。
     *
     * OpenAI SDK 在 `client.chat.completions.create()` 里自己拼
     * `/chat/completions`（见 createClient，dist/api/openai-completions.js:531-565）。
     * 这里写成 `LLM_CHAT_URL` 会得到 `.../v2/chat/completions/chat/completions` → 404。
     */
    baseUrl: LLM_BASE,
    input: vision ? ["text", "image"] : ["text"],
    // 上游有思考通道（extra_body.thinking），但要拿到它必须靠我们自己注入。
    // 这里设 true 让 DSH 显示思考档位选择器；`thinkingLevelMap` 故意不设，
    // 于是 getSupportedThinkingLevels() 返回全部七档（off..max），
    // 我们的 applyThinking() 只区分"开/关 + 档位字符串"，多出来的档位会原样透传。
    reasoning: true,
    cost: NO_COST,
    contextWindow,
    maxTokens,
    headers: sessionId === undefined ? {} : chatModelHeaders(sessionId),
    compat: {
      // ── 必须显式覆盖的三项，理由见文件头 ──
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsStore: false,
      // ── 下面几项与网关行为对齐 ──
      supportsReasoningEffort: false, // 走 extra_body，不发顶层 reasoning_effort
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      // 浣熊是 OpenAI 兼容网关，thinking 由我们自己注入，所以这里设 openai 走默认分支
      // （默认分支只在 supportsReasoningEffort 为真时才写 reasoning_effort，我们设了 false，不会写）。
      thinkingFormat: "openai",
    },
  };
}

/** 批量转换，按 id 去重（同 id 保留先出现的）。 */
export function toDescriptors(
  models: readonly RaccoonModel[],
  options: RosterOptions = {},
): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(toDescriptor(model, options));
  }
  return out;
}
