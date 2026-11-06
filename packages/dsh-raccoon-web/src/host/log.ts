/**
 * 结构化日志。**全项目唯一的日志出口。**
 *
 * ## 为什么不用 `console.log`
 *
 * 宿主进程的 stdout 在桌面端是不可见的（被 Electron 吞掉），只有 `ctx.logger`
 * 会进 `$DSH_HOME/logs/`。所以所有事件都走这里，再由调用方传入的
 * `ctx.logger` 落盘。
 *
 * ## 两条硬规则
 *
 * 1. **不打自由文本。** 参数只有数字、枚举、id 摘要 —— 不打用户说了什么、
 *    不打模型回了什么、不打请求体。理由见 docs/04-ops/02-observability.md：
 *    "日志里不该有用户说了什么"。
 * 2. **不打 token。** 唯一允许的形态是 `tokenTag()` 的
 *    `sha256(token).slice(0,8)`。用它能在日志里对上"是不是同一个 token"，
 *    但反推不出 token 本身。
 *
 * @module host/log
 */

import { createHash } from "node:crypto";

/** 日志前缀。所有事件都用它，方便 `grep`。 */
const PREFIX = "[raccoon-web]";

/**
 * token 摘要。
 *
 * 8 位十六进制 = 32 bit，对本机上"同一个 token / 不同 token"的区分完全够，
 * 碰撞概率约 2^-32，而**哪怕碰撞也只是两条日志看起来像同一个 token**，
 * 不会泄露任何东西。
 */
export function tokenTag(token: string | undefined): string {
  if (token === undefined || token.length === 0) return "-";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/** 一个日志出口。`ctx.logger` 有 info/warn/error/debug 四档，形状不完全一致。 */
export interface LogSink {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** 可打印的字段值。故意不含 `object` —— 禁止把请求体/响应体直接丢进日志。 */
export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * 拼一行日志。
 *
 * 格式：`[raccoon-web] <event> k=v k=v`。`undefined` 的字段直接略过，
 * 不打 `k=undefined` —— 那会让日志读起来像出了错。
 */
export function formatLine(event: string, fields: LogFields = {}): string {
  const parts: string[] = [PREFIX, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" ");
}

/** 日志器。四档方法都在，`debug` 受 settings 的 `debugLog` 控制。 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** 运行期改 debug 开关（settings 变了会调）。 */
  setDebug(enabled: boolean): void;
}

/**
 * 造一个日志器。
 *
 * `sink` 缺失时（单测、或 `ctx.logger` 不可用）退化成什么都不做 ——
 * **绝不退回 console**，否则桌面端会有一堆看不见的输出，让人误以为"日志没打"。
 */
export function createLogger(sink: LogSink | undefined, debugEnabled = false): Logger {
  let debugOn = debugEnabled;

  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (event: string, fields?: LogFields): void => {
      if (level === "debug" && !debugOn) return;
      const fn = sink?.[level] ?? sink?.info;
      if (fn === undefined) return;
      try {
        fn(formatLine(event, fields));
      } catch {
        // 日志是旁路，打不出去也不能影响主流程。
      }
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    setDebug(enabled: boolean) {
      debugOn = enabled;
    },
  };
}
