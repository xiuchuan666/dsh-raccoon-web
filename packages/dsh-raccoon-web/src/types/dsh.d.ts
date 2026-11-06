/**
 * DSH 内核包的最小类型声明。
 *
 * 为什么手写：
 *   DSH 0.2.1-rc.5 的 194 个 `@deepseek-ai/dsh-*` 包，`*.d.ts` 数量为 0
 *   （见 docs/01-research/05-empirical-findings.md E-009），但每个包的
 *   `package.json.types` 都指向不存在的 `lib/types/index.d.ts`。
 *   所以编辑器里这些模块全是隐式 any，且会报"找不到声明文件"。
 *
 * 这份文件同时是**"我们依赖了内核什么"的清单** —— 升级 DSH 时对着它逐条核。
 * 只声明用到的符号，不要照着 .js 抄全量。
 */

declare module "@deepseek-ai/dsh-llm" {
  export interface ProviderModelDescriptor {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl?: string;
    input?: readonly ("text" | "image")[];
    reasoning?: boolean;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow?: number;
    maxTokens?: number;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
  }

  export interface AssistantStreamEvent {
    type: string;
    [k: string]: unknown;
  }

  export interface AssistantMessageEventStream {
    [Symbol.asyncIterator](): AsyncIterator<AssistantStreamEvent>;
  }

  /**
   * 实测 dsh-llm/lib/index.js:316-347 `resolveRetryPolicy`：
   * `config.mode` 只接受 `"normal"` 与 `"always"`（不是 "never"/"aggressive"），
   * 其余走 `default:` 抛 `path.mode must be "normal" or "always"`。
   * `mode:"normal"` 时 `maxRetries` 必须是安全非负整数，
   * `retryableCodes` 必须非空、无重复、全为非空字符串。
   */
  export interface RetryPolicy {
    mode: "normal" | "always";
    maxRetries?: number;
    retryableCodes?: string[];
    backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number };
  }

  export function resolveRetryPolicy(
    config: unknown,
    fallback?: unknown,
  ): RetryPolicy;

  export function resolveImageAttachmentAccess(
    attachments: unknown,
    resolveHostPath: (p: string) => string | undefined,
    ref: unknown,
  ): unknown;

  /** 适配器基类 —— 本项目不用它，但内核会据此判断，保留声明以防误用。 */
  export class LlmAdapter {
    providerInfo(provider: string): { id: string; name: string };
  }

  export class LlmError extends Error {
    constructor(code: string, message: string, options?: unknown);
    code: string;
  }

  export function assertUsableApiKey(key: string | undefined, name: string): void;
}

declare module "@deepseek-ai/dsh-llm-pi-ai" {
  import type { RetryPolicy } from "@deepseek-ai/dsh-llm";

  export interface PiAiProfile {
    provider: unknown;
    displayName: string;
    streamIdleTimeoutMs: number;
    retryPolicy: RetryPolicy;
    configuredMaxTokens: Map<string, number>;
    modelErrors: Map<string, unknown>;
    piProvider: unknown;
    [k: string]: unknown;
  }

  export interface PiAiAdapterOptions {
    profiles: () => Map<string, PiAiProfile>;
    auth: unknown;
    resolveApiKey: () => Promise<string>;
    resolveAttachments: () => unknown;
    resolveImageAccess: (attachments: unknown, ref: unknown) => unknown;
  }

  export class PiAiAdapter {
    constructor(options: PiAiAdapterOptions);
    providerInfo(provider: string): { id: string; name: string };
    providerRetryPolicy(provider: string): RetryPolicy | undefined;
  }
}

/**
 * pi-ai 的 openai-completions Api 工厂。
 *
 * 为什么单独声明：`@earendil-works/pi-ai` 的 `dist/` 下**一个 .d.ts 都没有**
 * （E-009 / E-010），且它只从 DSH 安装目录可解析（E-008），
 * 工作区里既拿不到类型也拿不到包。所以这里手写最小形状。
 *
 * 真实形状来自 `dist/api/lazy.js`：
 *   lazyApi(load) → { stream, streamSimple }
 *   两个方法都**同步**返回 AssistantMessageEventStream。
 */
declare module "@earendil-works/pi-ai/api/openai-completions.lazy" {
  export interface PiAiApi {
    stream(model: unknown, context: unknown, options?: Record<string, unknown>): unknown;
    streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>): unknown;
  }
  export function openAICompletionsApi(): PiAiApi;
}

declare module "@earendil-works/pi-ai" {
  export interface PiAiProviderConfig {
    id: string;
    name?: string;
    baseUrl?: string;
    auth?: unknown;
    models: readonly unknown[];
    api: unknown;
  }

  /**
   * `createProvider()` 返回的 provider 对象。
   * 实测 dist/models.js:527-590 —— 缺省 `getModels` 时 pi-ai 用内部
   * `currentModels()`；`assemblePiAiAdapter` 会覆盖成闭包，保证 descriptor 变了立刻生效。
   */
  export interface PiAiProvider {
    id: string;
    name: string;
    getModels(): readonly unknown[];
    [k: string]: unknown;
  }

  export function createProvider(input: PiAiProviderConfig): PiAiProvider;
}
