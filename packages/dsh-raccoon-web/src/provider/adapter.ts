/**
 * 把名册、pi-ai provider、`PiAiAdapter` 三者装成一个 DSH 能注册的适配器。
 *
 * ## 这段装配是从哪儿抄的
 *
 * 形状照抄 `dsh-connect-sensenova-token-plan/lib/llm-adapter-core.js:465-512`
 * 的 `assemblePiAiAdapter()`（见 docs/01-research/01-reference-plugins.md）。
 * 四个参考插件全都走这条路，没有一个直接继承 `LlmAdapter` —— 理由见 ADR-0005。
 *
 * ## 三个必须照抄的细节
 *
 * 1. `profiles` 传的是 **函数** `() => profiles`，不是 Map 本身。
 *    `PiAiAdapter.current()` 用引用相等做 memo（`if (this.snapshot?.profiles === profiles) return`），
 *    所以**换一份 Map 就是换一次快照**。我们每次换名册都新建 Map。
 * 2. `getModels: () => models` 是闭包，不是快照。
 * 3. `auth: INERT_AUTH` —— pi-ai 自己的凭据生命周期必须回答"什么都没存"，
 *    真正的 token 走 `resolveApiKey()`。否则 pi-ai 会试着写一份凭据到内核的
 *    credential store 里，而那个 store 归 DSH 管，我们无权写入。
 *
 * ## 与 sensenova 的两处不同
 *
 * - **`api` 用我们自己的 `createRaccoonApi()`**，不是 `openAICompletionsApi()`。
 *   差别只有一个：它会往请求体里塞 `extra_body.thinking`（ADR-0003）。
 * - **`maxRetries` 从 8 降到 2**，且 `RATE_LIMIT` 不在可重试列表里（见 host/publish.ts
 *   与 docs/02-design/05-error-model.md 的差异表）。
 *
 * @module provider/adapter
 */

import { createProvider } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";

import { PROVIDER_ID } from "../protocol/consts.js";
import { createRaccoonApi } from "./api.js";
import type { ModelDescriptor } from "./roster.js";

/**
 * pi-ai 的 auth 平面。全部回答"没有"。
 *
 * 这不是占位符 —— 是**必须**的行为：`PiAiAdapter` 会在解析 apiKey 时
 * 先问 `auth`，问不到才用 `resolveApiKey()`。如果 `auth` 能答出东西，
 * 就会出现两条获取 token 的路径，而其中一条（credential store）
 * 由 DSH 内核管理，我们的 rotate / logout 管不到它 → 退出登录之后
 * 请求还带着一个旧 token。
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      return undefined;
    },
    async delete() {
      return undefined;
    },
  },
  authContext: {
    async env() {
      return undefined;
    },
    async fileExists() {
      return false;
    },
  },
} as const;

/**
 * 图片预算。
 *
 * 三项来自 sensenova 的 `imageBudgets()`（llm-adapter-core.js:383-389），
 * 数值原样保留：
 * - `maxRequestImageBytes: 20MB` —— 单个请求里图片的总字节预算（**内核侧预检**，
 *   在我们自己发出去之前就把图压小）。
 * - `requestImagePixelBudget: 640000` —— 约 800×800。E-019 实测网关请求体硬上限约
 *   **3.0001 MiB**，这个像素数单张压缩后 200 KB~1.5 MB，两张以内安全。
 * - `requestImageMaxBytes: 1MB` —— 单张图。
 *
 * ⚠️ 别把 `maxRequestImageBytes` 当成"网关上限"：它是内核自己的预检值，比网关宽松得多。
 * 网关超限回的是 **400 `inference request is invalid`，不是 413**（E-019），
 * 那条判定在 `src/protocol/chat.ts` 里做。
 */
const IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 640_000,
  requestImageMaxBytes: 1024 * 1024,
} as const;

/**
 * 空闲超时交给 `PiAiAdapter` 自己的看门狗。
 *
 * 300_000 是 sensenova 的选择。我们另外在 `chatStream()` 里做**首字节** 60s
 * —— 两者不冲突：这里管"发出去了但半天没吐字"，那里管"连第一个字节都没有"。
 * 后者是浣熊最典型的失败模式（高峰时段 60s+ 无响应，见 05-empirical-findings）。
 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * 重试策略。
 *
 * 与 sensenova 的 `buildRetryPolicyConfig()` 有三处不同，都是刻意的：
 *
 * | 项 | sensenova | 这里 | 为什么 |
 * | --- | --- | --- | --- |
 * | maxRetries | 8 | 2 | 积分池共享，重试 8 次等于烧 8 次积分 |
 * | maxDelayMs | 20000 | 10000 | 上游没有 Retry-After，长等待只是让用户干等 |
 * | RATE_LIMIT 在列表里 | 是 | **否** | 限流是按账号 token 速率算的，重试只会延长冷却 |
 *
 * `mode` 只能是 `"normal"` / `"always"`（dsh-llm/lib/index.js:247-347 的 switch）。
 */
const RETRY_POLICY = {
  mode: "normal" as const,
  maxRetries: 2,
  retryableCodes: ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 10_000, jitterRatio: 0.25 },
};

/** 装配所需的外部依赖。全部由 host 层注入，这里不碰 fs / settings。 */
export interface AdapterOptions {
  /** 每次请求都读一次 —— token 会在登录 / 退出 / 过期时变。 */
  resolveToken: () => Promise<string | undefined>;
  /**
   * 号池路径（ADR-0010）：一次解析出「用哪个账号」+「它的设备身份」。
   *
   * 与 `resolveToken` 二选一 —— 传了它就优先用它。号池关着的时候 host 不传，
   * 走的还是老路径，行为与之前完全一致。
   */
  resolveAccount?: () => Promise<{ token: string; deviceId: string } | undefined>;
  /** 一次请求结束时的 HTTP 状态（来自 pi-ai 的 `onResponse`）。用于记测量。 */
  onResponse?: (status: number) => void;
  /** 模型名册。换名册要换整个 adapter 实例（见 publish.ts）。 */
  models: readonly ModelDescriptor[];
  /** DSH 的服务访问器（`resolveAttachments` / `resolveImageAccess` 要它）。 */
  get?: (service: string) => unknown;
  /** 显示名。目前固定"小浣熊"。 */
  displayName: string;
  /** 是否允许思考。默认 true；关掉时 applyThinking 会发 disabled。 */
  reasoningEnabled: boolean;
}

/** 装配结果。`adapter` 直接交给 `llm.registerAdapter()`。 */
export interface AssembledAdapter {
  adapter: unknown;
  providerIds: string[];
}

/**
 * 装配一个 provider。
 *
 * 注意这个函数**不做 IO**：`resolveToken` 是懒的，名册是传进来的。
 * 所以它可以在 `apply()` 里同步调用，不需要 await。
 */
export function assembleAdapter(options: AdapterOptions): AssembledAdapter {
  const { models, displayName, resolveToken, resolveAccount, onResponse, get, reasoningEnabled } = options;

  /**
   * 号池路径下"这次用哪个账号"由 `resolveAccount()` 决定；老路径用 `resolveToken()`。
   *
   * **为什么设备身份不在这里注入。** 设备头 `x-client-device-id` 属于
   * `model.headers`（roster 建 descriptor 时写死），而 pi-ai 的
   * `profileOptions()` 不透传 `options.headers`（只传 apiKey/reasoning/
   * thinkingBudgets/cacheRetention/transport/timeoutMs/websocketConnectTimeoutMs）。
   * 所以每请求改头这条路走不通 —— 改成"换号就重建名册"：
   * `rosterSignature()` 末尾带 `|dev:<deviceId>`，换号 → 指纹变 → Publisher
   * 释放再注册，新 descriptor 带着新设备头。见 docs/02-design/07-account-pool.md。
   */
  const resolveKey = async (): Promise<string | undefined> => {
    if (resolveAccount === undefined) return await resolveToken();
    const account = await resolveAccount();
    return account?.token;
  };

  /**
   * `api` 传的是**单个 Api 对象**，不是 `{[apiId]: Api}` 映射。
   * `createProvider()` 两条路都支持（dist/models.js:527-590 的
   * `const single = input.api && typeof input.api.stream === "function" ? input.api : undefined`），
   * 单对象更简单 —— 因为名册里所有模型都用同一个 `API_ID`。
   *
   * `reasoningEffortOf` 是给"没走 options 那条路"的兜底：
   * 正常情况下 DSH 会把 effort 放进 `options.reasoningEffort`，但 `streamSimple()`
   * 的路径会把 effort 先一步翻译成 `thinkingBudgets` 再传，那时 `options.reasoningEffort`
   * 可能已经是 `undefined`。这时退回 settings 的开关（开 → "on"，关 → "off"）。
   */
  const api = createRaccoonApi(
    () => (reasoningEnabled ? "on" : "off"),
    onResponse === undefined ? undefined : (status: number) => onResponse(status),
  );

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: displayName,
      auth: {
        apiKey: {
          name: "小浣熊登录令牌",
          /**
           * **必须把 credential 里的 key 交回去，不能返回 `undefined`。**
           *
           * 这里踩过一个"装好了、模型也在、一发消息就失败"的坑（2026-11-06
           * 真链路冒烟 `scripts/smoke-chat-live.mjs` 暴露）：
           *
           * - `PiAiAdapter.streamWithSnapshot()` 先 `await this.config.resolveApiKey(...)`
           *   拿到 token，再经 `profileOptions()` 塞成 pi-ai 的 `options.apiKey`；
           * - pi-ai 的 `Models.applyAuth()` → `resolveProviderAuth()` 看到
           *   `overrides.apiKey !== undefined`，于是走**第一条分支**：
           *   `resolveApiKey(ctx, provider.auth.apiKey, provider.id, {type:"api_key", key: overrides.apiKey}, signal)`；
           * - 也就是 `credential.key` 就是我们要的那个 token；
           * - 如果这里返回 `undefined`，`getAuth()` 得到 falsy，
           *   `applyAuth()` 直接抛 `Provider is not configured: raccoon-web`
           *   （`pi-ai/dist/models.js:429`），而这一抛在 `toStreamChunks` 里被
           *   归成 `PI_AI_ERROR` —— 界面上只说"出错了"，完全看不出是认证没接上。
           *
           * 形状照抄 sensenova 的 `assemblePiAiAdapter()`（`lib/llm-adapter-core.js:470-484`）：
           * `{auth: {apiKey: key}, source: displayName}`。
           * 多出来的 `await resolveToken()` 兜底是为了"DP 层没给 options.apiKey"的情况
           * （例如 `streamSimple()` 的某些分支）—— 那时 credential 是 undefined，
           * 直接读一次真实 token，而不是让请求裸奔。
           */
          async resolve(input?: { credential?: { key?: string } }) {
            const fromCredential = input?.credential?.key;
            const key =
              fromCredential !== undefined && fromCredential.length > 0
                ? fromCredential
                : await resolveKey();
            if (key === undefined || key.length === 0) return undefined;
            return { auth: { apiKey: key }, source: displayName };
          },
        },
      },
      models: models as unknown[],
      api,
    }),
    /**
     * 闭包不是快照。`createProvider()` 内部已经有一份 `getModels`，
     * 这里再覆盖一次是因为我们传的 `models` 是 readonly 数组，
     * 而 pi-ai 期望 `getModels()` 每次返回当前全量（它自己会 filter chat 类型）。
     */
    getModels: () => models as unknown[],
  };

  const profiles = new Map([
    [
      PROVIDER_ID,
      {
        provider: PROVIDER_ID,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(RETRY_POLICY, `dsh-raccoon-web.${PROVIDER_ID}.retryPolicy`),
        /** DSH 侧的 maxTokens 覆盖表。我们不用 —— 上限由 descriptor 决定。 */
        configuredMaxTokens: new Map<string, number>(),
        /** 单模型的目录错误。我们整批换名册，不用逐模型报错。 */
        modelErrors: new Map<string, string>(),
        ...IMAGE_BUDGETS,
        piProvider: provider,
      },
    ],
  ]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => {
      const token = await resolveKey();
      if (token === undefined || token.length === 0) {
        /**
         * 这里抛的错会被 `PiAiAdapter` 归成 `MISSING_CREDENTIAL`，
         * 而它在 `listModels()` 里遇到这个码会**返回空列表而不是抛**
         * （lib/index.js:1830-1982）。所以未登录时模型选择器里没有小浣熊，
         * 但整个 provider 不会消失到让设置页报错 —— 这正是我们要的。
         */
        /**
         * 文案同时给两条路，因为这里不知道用户手上有哪种凭据：
         * 装过官方客户端的人**不需要**扫码（ADR-0008 会自动读它的 `auth.json`），
         * 只让他去扫码等于把首选路线藏起来。
         */
        throw new Error(
          "未登录小浣熊：装过官方客户端的话直接打开它登录即可；没有客户端就在设置 → 插件 → 小浣熊 里扫码登录。",
        );
      }
      return token;
    },
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments: unknown, ref: unknown) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath: string) =>
          (get?.("fs") as { processPathFromHostPath?: (p: string) => string } | undefined)
            ?.processPathFromHostPath?.(hostPath),
        ref,
      ),
  });

  return { adapter, providerIds: [PROVIDER_ID] };
}
