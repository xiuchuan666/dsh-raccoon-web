/**
 * 错误模型。
 *
 * 三条规矩（docs/02-design/05-error-model.md）：
 *   ① 每个错误有 `kind`（程序看）和 `hint`（人看）。
 *   ② 决定"重不重试"的只有 `kind`，不看 HTTP 状态码。
 *   ③ 用户看到的文案必须包含**下一步做什么**。
 *
 * 这一层不 import 任何 DSH 包 —— 协议层要能脱离宿主单测（ADR-0004）。
 *
 * @module protocol/errors
 */

/** 七种类别。映射到 pi-ai 的 error code 时是一对一。 */
export type RaccoonErrorKind =
  | "AUTH"
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT"
  | "INVALID_REQUEST"
  | "ABORTED";

/** 每种 kind 的用户可见文案。`hint` 必须是可执行动作。 */
export const HINTS: Record<RaccoonErrorKind, string> = {
  AUTH: "小浣熊登录已失效，请在设置 → 插件 → 小浣熊 里重新扫码。",
  RATE_LIMIT:
    "小浣熊账号的模型吞吐已达上限（不是每分钟请求数，而是按账号的 token 速率）。" +
    "一轮对话带的上下文越大越快撞到，撞到后额度按吞吐缓慢回血，上游也没有给恢复时间。" +
    "稍等一会儿再发；把该模型的上下文窗口调小，同一会话能撑得更久。",
  SERVER: "小浣熊上游返回了错误。这通常是临时的，已经自动重试。如果持续出现，请把诊断信息反馈。",
  TIMEOUT: "小浣熊没有在预期时间内返回内容。高峰期常见，已自动重试；如果反复出现，换一个模型试试。",
  TRANSPORT: "连不上小浣熊（网络错误）。检查网络或代理设置后重试。",
  INVALID_REQUEST: "这次请求小浣熊不接受。通常是请求体太大或参数不被支持。",
  ABORTED: "",
};

/**
 * 协议层唯一抛出的错误类型。
 *
 * 不继承任何 DSH 的 `LlmError` —— 那会让协议层依赖内核。
 * 翻译发生在 `provider/api.ts`。
 */
export class RaccoonError extends Error {
  readonly kind: RaccoonErrorKind;
  /** HTTP 状态码，没有就是 undefined。 */
  readonly status: number | undefined;
  /** 上游原文。**进日志不进 UI**，且日志里也截断到 512 字符。 */
  readonly upstream: string | undefined;
  /** 给用户看的下一步。默认取 HINTS[kind]，特殊情况可覆盖。 */
  readonly hint: string;

  constructor(
    kind: RaccoonErrorKind,
    message: string,
    options: { status?: number; upstream?: string; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RaccoonError";
    this.kind = kind;
    this.status = options.status;
    this.upstream = options.upstream;
    this.hint = options.hint ?? HINTS[kind];
  }

  /** 用户最终看到的一句话：message + hint。 */
  get userText(): string {
    if (this.kind === "ABORTED") return "";
    const hint = this.hint;
    const upstream = this.upstream;
    const tail = upstream === undefined ? "" : ` 上游原文：${truncate(upstream, 240)}`;
    return hint === "" ? `${this.message}${tail}` : `${this.message}\n\n${hint}${tail}`;
  }
}

/** 哪些 kind 允许自动重试。RATE_LIMIT 与 AUTH **不在**里面，见 05-error-model.md §3.3。 */
export const RETRYABLE_KINDS: ReadonlySet<RaccoonErrorKind> = new Set<RaccoonErrorKind>([
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

/** 会话死亡码。`200003` 是 E-005 实测的 `authorization_verify_error`。 */
export const DEAD_SESSION_CODES: ReadonlySet<number> = new Set([200001, 200003]);

/** 判断一个上游 `code` 是否意味着"这个 token 已经不能用了"。 */
export function isDeadSessionCode(code: unknown): boolean {
  return typeof code === "number" && DEAD_SESSION_CODES.has(code);
}

/**
 * 限流关键词。
 *
 * 三个都来自实测/参考实现的观察：`user_model_rate_limited` 是 sensenova 抓到的
 * 上游 code；`rate_limit` 是通用兜底；`频率超限` 是中文文案兜底。
 */
const RATE_LIMIT_WORDS = ["user_model_rate_limited", "rate_limit", "频率超限", "too many requests"];

/**
 * 上游限流用的**业务码**（不是 HTTP 状态）。
 *
 * `200429` 来自 dsh-llm-adapters 对 sensenova 网关的抓包观察，
 * 形状是 `{"code": 200429, "message": "user_model_rate_limited"}` 且 HTTP 是 200。
 * 只看 `status === 429` 会漏掉这类响应 —— 用户看到的就是"模型突然不说话"。
 */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, 200429]);

/** 这个上游 `code` 是不是限流。 */
export function isRateLimitCode(code: unknown): boolean {
  return typeof code === "number" && RATE_LIMIT_CODES.has(code);
}

/** 限流判定。HTTP 429 / 业务码 200429 / 响应体里出现关键词。 */
export function isRateLimited(status: number | undefined, text: string): boolean {
  if (status !== undefined && RATE_LIMIT_CODES.has(status)) return true;
  const lower = text.toLowerCase();
  return RATE_LIMIT_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

/**
 * 日志截断。
 *
 * **只用于日志与 upstream 字段。解析路径上绝不截断** ——
 * `dsh-raccoon-connect@0.2.2` 就是因为把响应体截到 4096 字符，
 * 导致新模型的 JSON 解析失败，UI 里显示 `[object Object]`。
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(${s.length - max} more)`;
}

/** 把任意 thrown 值归一成 RaccoonError。协议层边界上一个就够。 */
export function toRaccoonError(err: unknown, fallbackKind: RaccoonErrorKind = "SERVER"): RaccoonError {
  if (err instanceof RaccoonError) return err;
  if (err instanceof Error) {
    // AbortError 有两个来源：用户取消 / 我们的超时定时器。
    // 这里统一当 ABORTED，由调用方决定要不要覆盖成 TIMEOUT。
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new RaccoonError("ABORTED", "请求已取消", { cause: err });
    }
    return new RaccoonError(fallbackKind, err.message, { cause: err });
  }
  return new RaccoonError(fallbackKind, String(err));
}
