/**
 * 插件入口。
 *
 * 这个文件只做三件事：声明元数据、等两个服务到齐、把 `RaccoonHost` 接上去。
 * 任何一行业务逻辑都不该出现在这里 —— 它是最难测的一层（要真宿主才跑得起来）。
 *
 * ## 为什么是 `ctx.inject` 而不是 `inject = ["llm", "settings", "webServer"]`
 *
 * `inject` 里的服务是**硬依赖**：少一个，插件整体不加载。而这三个的可用性不一样：
 *
 * - `llm` 必须有，否则注册 provider 无从谈起 → 放进 `inject`。
 * - `settings` 必须有（要存开关），但它由 `dsh-settings` 提供，在无头宿主里
 *   也可能存在 → 放进第一个 `ctx.inject`，等它。
 * - `webServer` 只有桌面 / web 宿主才有。把它写进 `inject` 会让插件在 CLI
 *   宿主里彻底不加载 —— 而 CLI 里 provider 一样有用（只是没有设置卡）。
 *   → 放进嵌套的 `ctx.inject`，没有它就不挂路由。
 *
 * 这个分层是照 `dsh-connect-workbuddy` 的 `lib/index.js:13583` 与
 * `dsh-connect-minimaxcode` 的 `lib/index.js:2383` 的做法抄的：
 * 两个参考实现都不把 `webServer` 写进顶层 `inject`。
 *
 * @module index
 */

import { BUILD, VERSION } from "./build.js";
import { RaccoonHost } from "./host/index.js";
import { createLogger } from "./host/log.js";
import { registerSettings, type RawSettingsService, type SettingsHandle } from "./host/settings.js";

/** 包名。cordis 里显示的名字，也是 `cordis.patch.yml` 里 `name:` 的值。 */
export const name = "dsh-raccoon-web";

/** 硬依赖：没有 llm 服务就没有这个插件的意义。 */
export const inject = ["llm"];

/** 宿主上下文里我们用到的那一小块（内核没有 .d.ts，只能自己声明）。 */
interface PluginContext {
  llm: { registerAdapter(providers: readonly string[], adapter: unknown): AdapterHandleLike };
  logger?: {
    debug?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
  };
  get?: (service: string, strict?: boolean) => unknown;
  effect?: (factory: () => (() => void) | void, label?: string) => void;
  inject?: (deps: readonly string[], callback: (sub: PluginContext) => void) => void;
  fiber?: unknown;
  settings?: unknown;
  webServer?: unknown;
}

interface AdapterHandleLike {
  (): void;
  replace?(next: { providers: readonly string[]; adapter: unknown }): AdapterHandleLike;
}

/**
 * 装配插件。
 *
 * **必须同步返回。** cordis 不等 `apply` 的返回值，所以任何 `await` 都得包进
 * `void (async () => {})()`；写成 `async function apply` 会让插件在初始化
 * 完成前就被认为"已就绪"，后续的 `ctx.effect` 注册也会落在错误的 fiber 上。
 */
export function apply(ctx: PluginContext): void {
  const logger = createLogger(ctx.logger);

  logger.info("apply", { version: VERSION, build: BUILD });

  if (ctx.inject === undefined) {
    // 理论上不可能：cordis 的 Context 一定有 inject。真出现了就只能放弃，
    // 因为没有 settings 就没有开关。
    logger.error("apply/no-inject", { message: "宿主上下文缺少 inject()，插件无法继续初始化" });
    return;
  }

  ctx.inject(["settings"], (sub) => {
    let settings: SettingsHandle;
    try {
      settings = registerSettings(sub.settings as RawSettingsService);
    } catch (error) {
      logger.error("apply/settings-failed", { message: error instanceof Error ? error.message : String(error) });
      return;
    }

    logger.setDebug(settings.get().debugLog);

    const host = new RaccoonHost({
      logger,
      settings,
      llm: (sub.llm ?? ctx.llm) as never,
      version: VERSION,
      build: BUILD,
      ...(ctx.get === undefined ? {} : { get: (service) => ctx.get?.(service) }),
    });

    // 设置变化要立刻生效：改名册（contextCap）走重注册，改 debug 走日志器。
    const unwatch = settings.watch((next, prev) => {
      if (next.debugLog !== prev.debugLog) logger.setDebug(next.debugLog);
      if (next.enabled !== prev.enabled || next.reasoning !== prev.reasoning || next.contextCap !== prev.contextCap) {
        logger.info("settings/changed", {
          enabled: next.enabled,
          reasoning: next.reasoning,
          contextCap: next.contextCap,
        });
        // 名册里的 contextWindow / maxTokens 依赖 contextCap，必须重新装配。
        void host.runAction("refresh-catalog", { force: true }).catch(() => undefined);
      }
    });

    sub.effect?.(() => () => {
      unwatch();
      host.dispose();
    }, `${name}: host`);

    // provider 先注册，路由后挂 —— 这样即使 webServer 迟迟不到，
    // 模型选择器里也已经能选到小浣熊。
    void host.bootstrap();

    sub.inject?.(["webServer"], (web) => {
      web.effect?.(() => host.mount(web.webServer as never), `${name}: routes`);
      logger.info("mount/routes");
    });
  });
}
