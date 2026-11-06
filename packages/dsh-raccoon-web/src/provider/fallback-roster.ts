/**
 * 内置回退名册。
 *
 * 为什么要有一份硬编码名册：`model_catalog` 需要 token 才能读。而模型选择器在
 * **没登录时也要能打开**，否则用户看到的是一个空白的插件设置页，不知道下一步该干什么。
 * 所以未登录或目录请求失败时，用这份快照顶上，让 UI 至少有东西可显示。
 *
 * 数据来源：2026-11-06 从 dsh-llm-adapters 与 dsh-raccoon-connect 两个包里交叉比对出的
 * 上游模型 id 与倍率（见 docs/01-research/02-prior-raccoon-plugins.md）。
 * **这份表会过期**，它的唯一作用是在没有 token 时给出一个非空的形状；
 * 一旦有了 token，`fetchCatalog()` 的结果永远优先。
 *
 * 倍率（multiplier）是积分消耗倍数，不是价格 —— 小浣熊按积分扣，不按美元扣。
 */

export interface FallbackModel {
  readonly id: string;
  readonly name: string;
  /** 目录标签的 vision 字段**不可信**，见 ADR-0006；这里只是默认值。 */
  readonly vision: boolean;
  readonly multiplier?: number;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

export const FALLBACK_MODELS: readonly FallbackModel[] = [
  {
    id: "DeepSeek-V4.1-Flash",
    name: "DeepSeek V4.1 Flash",
    // 目录无 vision 标签，但 2026-09-18 实测能读图（ADR-0006 的反例之一）
    vision: true,
    multiplier: 0.25,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
  },
  {
    id: "GLM-5-3",
    name: "GLM 5.3",
    vision: false,
    multiplier: 0.75,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
  },
  {
    id: "GLM-5-3-Flash",
    name: "GLM 5.3 Flash",
    vision: true,
    multiplier: 0.2,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
  },
  {
    id: "Kimi-K3",
    name: "Kimi K3",
    vision: true,
    multiplier: 1,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
  },
  {
    id: "Qwen3.8-Flash",
    name: "Qwen3.8 Flash",
    vision: false,
    multiplier: 0.15,
    contextWindow: 262_144,
    maxOutput: 32_768,
  },
];
