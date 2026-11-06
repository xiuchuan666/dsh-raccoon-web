/**
 * 内核包测试桩：`@deepseek-ai/dsh-llm-pi-ai`。
 *
 * 真实实现在 `dsh-llm-pi-ai/lib/index.js`（2968 行），宿主层单测不需要它 ——
 * 我们只需要一个"接受 options、暴露 providerInfo / providerRetryPolicy"的壳，
 * 用来验证 `Publisher` 怎么调内核。
 *
 * @module test/stubs/dsh-llm-pi-ai
 */

/** 假的 `profiles()` 快照形状（只取我们要断言的字段）。 */
interface ProfileLike {
  displayName?: string;
  retryPolicy?: unknown;
}

/** `PiAiAdapter` 构造参数里我们用到的那部分。 */
export interface PiAiAdapterConfigLike {
  profiles: () => Map<string, ProfileLike>;
}

/** 假的 `PiAiAdapter`。只保留宿主会读的那几个方法。 */
export class PiAiAdapter {
  declare config: PiAiAdapterConfigLike;

  constructor(config: PiAiAdapterConfigLike) {
    this.config = config;
  }

  /** 内核在 `prepareRoutes` 里会调它，且要求 `id === provider`。 */
  providerInfo(provider: string) {
    const profile = this.config.profiles().get(provider);
    return { id: provider, name: profile?.displayName ?? provider };
  }

  /** 内核会调它拿重试策略。 */
  providerRetryPolicy(provider: string) {
    return this.config.profiles().get(provider)?.retryPolicy;
  }
}
