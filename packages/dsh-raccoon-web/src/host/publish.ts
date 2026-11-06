/**
 * provider 的注册与注销。**全插件唯一碰 `llm.registerAdapter()` 的地方。**
 *
 * ## 三元门控（照抄 sensenova 的 `createRaccoonPublisher`，见 01-reference-plugins）
 *
 * ```
 * 开关关          → 注销，不注册
 * 开关开 + 无 token → 注销，不注册（不是报错）
 * 开关开 + 有 token → 注册
 * ```
 *
 * 为什么"开但没登录"不能注册一个空名册：DSH 的模型选择器会把 provider 列出来，
 * 用户选了一个然后发消息，报的是"模型不存在"而不是"请先登录"。宁可完全不出现。
 *
 * ## 为什么必须 replace 而不是 register
 *
 * `LlmService.prepareRoutes()` 对重复 provider 抛 `DUPLICATE_ADAPTER`
 * （dsh-llm/lib/index.js:1842 起）。而登录成功、目录刷新、settings 改 contextCap
 * 都会换名册 —— 每次都是"同一个 provider 换一份内容"，必须走 `.replace()`。
 *
 * ## 为什么换名册就要换 adapter 实例
 *
 * `PiAiAdapter.current()` 用 `profiles()` 返回值的**引用**做 memo
 * （dsh-llm-pi-ai/lib/index.js:1830-1982）。同一个 adapter 里把 Map 内容改了，
 * memo 认不出来，模型列表永远停在第一次那份。所以每次都新建 adapter。
 *
 * @module host/publish
 */

import { assembleAdapter } from "../provider/adapter.js";
import type { ModelDescriptor } from "../provider/roster.js";
import type { Logger } from "./log.js";

/**
 * 内核 `registerAdapter` 返回的句柄：可调用（= 注销）+ 带 `replace`。
 *
 * ⚠️ 2026-11-06 实测（`dsh-llm/lib/index.js:1856`，类型声明见
 * `lib/typert.host.js:271-272` 的 `AdapterRegistrationHandle`）：
 *
 *     export interface AdapterRegistrationHandle {
 *         (): void;
 *         replace(providers: string[]): void;
 *     }
 *
 * 两个事实都和直觉相反，且都踩过：
 *
 * 1. `replace` 返回 `void`，**不是**句柄本身。早先写 `this.handle = this.handle.replace(...)`
 *    会在第一次替换后把句柄置成 undefined（真宿主里 `refresh-auth` 报
 *    `providers is not iterable`）。
 * 2. `replace` 只接收一份 **provider 名字列表**，adapter 是注册时闭包捕获的，
 *    换不了。我们要换 adapter 实例，所以根本不用它（见 sync() 里的注释）。
 */
interface AdapterHandle {
  (): void;
  replace(providers: readonly string[]): void;
}

/** 内核 `llm` 服务里我们用到的那一小块。 */
export interface LlmRegistrar {
  registerAdapter(providers: readonly string[], adapter: unknown): AdapterHandle;
}

/** 一次发布的输入。 */
export interface PublishInput {
  /** 开关（settings.enabled）。 */
  enabled: boolean;
  /** 是否允许思考（settings.reasoning）。 */
  reasoningEnabled: boolean;
  /** 名册。空数组 = 还没有目录。 */
  models: readonly ModelDescriptor[];
  /** 当前 token。undefined = 未登录。 */
  token: string | undefined;
}

/** 发布状态。给诊断块用。 */
export type PublishState = "disabled" | "not-configured" | "published";

/**
 * 名册指纹。
 *
 * 只算**会进 descriptor 的**那些字段的稳定摘要。不要用 JSON.stringify 整个
 * descriptor —— 它里面没有函数也没有 Date，但字段顺序依赖对象字面量，
 * 上游加字段时指纹会无意义地变，导致"什么都没改也重新注册一次"。
 * 重新注册本身无害，但会让模型选择器闪一下。
 */
export function rosterSignature(models: readonly ModelDescriptor[]): string {
  return models
    .map((m) => `${m.id}:${m.input.includes("image") ? 1 : 0}:${m.contextWindow}:${m.maxTokens}`)
    .join(",");
}

/**
 * 发布器。
 *
 * 全部方法都是同步的（注册不是 IO），唯一的 await 在 `resolveToken` 里，
 * 而它只在 pi-ai 发请求时才被调。
 */
export class Publisher {
  private readonly llm: LlmRegistrar;
  private readonly logger: Logger;
  private readonly get: ((service: string) => unknown) | undefined;

  private handle: AdapterHandle | undefined;
  private lastSignature = "";
  private lastState: PublishState = "disabled";

  constructor(options: { llm: LlmRegistrar; logger: Logger; get?: (service: string) => unknown }) {
    this.llm = options.llm;
    this.logger = options.logger;
    this.get = options.get;
  }

  /** 当前状态。 */
  state(): PublishState {
    return this.lastState;
  }

  /** 是否已注册。 */
  isPublished(): boolean {
    return this.handle !== undefined;
  }

  /**
   * 按当前输入对齐一次。**幂等** —— 同样的输入调用多次不会重复注册。
   *
   * @param input 开关 / 名册 / token。
   * @param resolveToken 每次请求时读 token 的函数（pi-ai 内部会调）。
   */
  sync(input: PublishInput, resolveToken: () => Promise<string | undefined>): PublishState {
    if (!input.enabled) {
      this.dispose("disabled");
      return this.lastState;
    }
    if (input.token === undefined || input.token.length === 0 || input.models.length === 0) {
      this.dispose("not-configured");
      return this.lastState;
    }

    const signature = `${rosterSignature(input.models)}|${input.reasoningEnabled ? 1 : 0}`;
    if (this.handle !== undefined && signature === this.lastSignature) {
      // 名册与开关都没变：保留现有注册。这是最常见的路径（每次刷新目录都走这里）。
      this.lastState = "published";
      return this.lastState;
    }

    const assembled = assembleAdapter({
      models: input.models,
      displayName: "小浣熊",
      resolveToken,
      reasoningEnabled: input.reasoningEnabled,
      ...(this.get === undefined ? {} : { get: this.get }),
    });

    if (this.handle === undefined) {
      this.handle = this.llm.registerAdapter(assembled.providerIds, assembled.adapter);
      this.logger.info("publish/register", { models: input.models.length });
    } else {
      /**
       * **换名册必须"先释放再重新注册"，不能用 `handle.replace()`。**
       *
       * 2026-11-06 读内核两天才发现（`dsh-llm/lib/index.js:1856`）：
       *
       *     handle.replace = (next) => {
       *       if (released) throw ... REGISTRATION_DISPOSED;
       *       this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
       *     };
       *
       * 它接收的是 `next.providers`（一份 provider 名字列表），而且
       * **`adapter` 是构造时闭包捕获的**，根本换不了实例。我们换名册必须换
       * adapter 实例（`PiAiAdapter.current()` 用 `profiles()` 引用相等做 memo，
       * 见文件头），所以 `replace` 对本插件毫无用处。
       *
       * 早先这里传的是 `{providers, adapter}` 对象，内核把整个对象当数组
       * `for (const provider of providers)` 迭代 → 真宿主里 `refresh-auth`
       * 报 `providers is not iterable`。
       *
       * 释放 + 重注册需要在同一个同步段里完成，中间不能 await —— 否则
       * `llm/adapters-updated` 的监听者会看到 provider 短暂消失（模型选择器闪一下），
       * 更糟的是这段时间别处调 `registerAdapter` 不会被我们占位。
       */
      this.releaseHandle("publish/replace");
      try {
        this.handle = this.llm.registerAdapter(assembled.providerIds, assembled.adapter);
        this.logger.info("publish/replace", { models: input.models.length });
      } catch (error) {
        // 注册失败：上一份已经释放了，只能把状态打回未发布，让下一次 sync 重试。
        this.lastSignature = "";
        this.lastState = "not-configured";
        this.logger.error("publish/replace-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return this.lastState;
      }
    }

    this.lastSignature = signature;
    this.lastState = "published";
    return this.lastState;
  }

  /** 注销。可以重复调。 */
  dispose(reason: "disabled" | "not-configured" | "unload" = "unload"): void {
    this.releaseHandle("publish/dispose");
    this.lastSignature = "";
    this.lastState = reason === "disabled" ? "disabled" : reason === "not-configured" ? "not-configured" : "disabled";
  }

  /** 释放当前句柄（若有）。**不**改状态，给 sync / dispose 各自收尾。 */
  private releaseHandle(reason: string): void {
    if (this.handle === undefined) return;
    try {
      this.handle();
    } catch (error) {
      // 已经 dispose 过（内核对重复 dispose 会抛 REGISTRATION_DISPOSED 一类）。
      this.logger.debug("publish/dispose-threw", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.handle = undefined;
    this.logger.info(reason === "publish/dispose" ? "publish/dispose" : "publish/release", { reason });
  }
}
