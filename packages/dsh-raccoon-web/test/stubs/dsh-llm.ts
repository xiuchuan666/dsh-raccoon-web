/**
 * 内核包测试桩：`@deepseek-ai/dsh-llm`。
 *
 * 为什么需要：内核包**只能从 DSH 安装目录解析**（E-008），
 * 从 profile 或仓库里 import 都是 ERR_MODULE_NOT_FOUND。
 * 宿主层单测因此必须给这几个包提供替身。
 *
 * 替身只实现"我们真正会调用的那一小部分"，形状照抄内核实现
 * （`dsh-llm/lib/index.js`），但行为简化到可断言。
 *
 * @module test/stubs/dsh-llm
 */

/** 重试策略形状（照抄 dsh-llm/lib/index.js:247-347）。 */
export interface RetryPolicyLike {
  mode: "normal" | "always";
  maxRetries?: number;
  retryableCodes?: readonly string[];
  backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number };
}

/** `resolveRetryPolicy` 的最小实现：只做校验 + 补默认值。 */
export function resolveRetryPolicy(config?: RetryPolicyLike, path = "retryPolicy") {
  const defaults: Required<Omit<RetryPolicyLike, "backoff">> & { backoff: Required<NonNullable<RetryPolicyLike["backoff"]>> } = {
    mode: "normal",
    maxRetries: 5,
    retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
    backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
  };
  if (config === undefined) return defaults;
  if (config.mode !== "normal" && config.mode !== "always") {
    throw new Error(`${path}.mode must be "normal" or "always"`);
  }
  return {
    mode: config.mode,
    maxRetries: config.maxRetries ?? defaults.maxRetries,
    retryableCodes: config.retryableCodes ?? defaults.retryableCodes,
    backoff: { ...defaults.backoff, ...(config.backoff ?? {}) },
  };
}

/** `resolveImageAttachmentAccess` 的最小实现：只把 ref 交回去。 */
export function resolveImageAttachmentAccess(
  _attachments: unknown,
  resolveHostPath: (path: string) => string,
  ref: { path?: string },
) {
  const path = resolveHostPath(ref?.path ?? "");
  return { ref, path };
}

/** 基类，只用来让 `extends` 能编译。 */
export class LlmAdapter {}

/** 错误类型。 */
export class LlmError extends Error {
  declare code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

/** 未使用的导出，只为形状完整。 */
export function assertUsableApiKey(): boolean {
  return true;
}
