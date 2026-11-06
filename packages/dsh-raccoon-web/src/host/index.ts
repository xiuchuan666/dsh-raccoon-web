/**
 * 宿主半身的装配点：把 store / settings / login-flow / publish / routes 接成一个东西。
 *
 * ## 为什么要有这一层
 *
 * 下面这些模块彼此都知道得很有限：`LoginFlow` 不知道自己会触发 provider 注册，
 * `Publisher` 不知道 token 从哪来，`routes` 不知道 action 背后的语义。
 * 这个文件是唯一同时看见它们的地方 —— 也是唯一允许"做决定"的地方。
 * 它不做 IO 细节（那些在 store / protocol 里），也不做路由细节（在 routes 里）。
 *
 * ## 冷启动
 *
 * `apply()` 必须同步返回，所以真正的初始化走 `void bootstrap()`。
 * 顺序是：读 token → 读探测结果 → 建 caches → 拉一次目录（不阻塞）→ 同步发布器。
 * 目录拉失败不影响插件可用性：此时 provider 用 fallback 名册注册，
 * 用户在设置页能看到"目录未就绪"和原因。
 *
 * @module host/index
 */

import type { LlmRegistrar } from "./publish.js";
import type { Logger } from "./log.js";
import type { AuthSource, SettingsHandle } from "./settings.js";
import type { StatusDesktopAuth, StatusModel, StatusQuota, StatusSnapshot } from "./status.js";
import type { ActionResult, WebServerLike } from "./routes.js";

import { buildDiagnostics } from "./status.js";
import { loginBlock, registerRoutes } from "./routes.js";
import { createTtlCache } from "./cache.js";
import { LoginFlow } from "./login-flow.js";
import { tokenTag } from "./log.js";
import { Publisher, rosterSignature } from "./publish.js";
import { PROBE_PNG_BASE64 } from "./solid-png.js";
import { clearToken, readProbes, readToken, recordProbe, saveToken, type StoredToken } from "./store.js";
import { toDescriptors, type ModelDescriptor } from "../provider/roster.js";
import { FALLBACK_MODELS } from "../provider/fallback-roster.js";
import { fetchCatalog, flattenCatalog } from "../protocol/catalog.js";
import { readDesktopAuth, type DesktopAuth } from "../protocol/desktop-auth.js";
import { fetchBalance, fetchBills, todayGranted } from "../protocol/points.js";
import { applyThinking, chatStream, sessionIdFor } from "../protocol/chat.js";
import { renderQrSvg } from "../protocol/qr.js";
import { CATALOG_TTL_MS, DEFAULT_CONTEXT_CAP, PROVIDER_ID, QUOTA_TTL_MS } from "../protocol/consts.js";
import { RaccoonError } from "../protocol/errors.js";
import type { RaccoonModel } from "../protocol/catalog.js";

/** 宿主装配参数。 */
export interface HostOptions {
  logger: Logger;
  settings: SettingsHandle;
  /** DSH 的 llm 服务（只用到 registerAdapter）。 */
  llm: LlmRegistrar;
  /** 服务访问器，透传给 provider 装配。 */
  get?: (service: string) => unknown;
  /** 插件版本，来自 package.json。 */
  version: string;
  /** 构建标记，透给浏览器半身做缓存判定。 */
  build: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * 桌面端凭据的搜索根目录。默认 `os.homedir()`。
   *
   * 只给测试用：把临时目录当"用户主目录"，这样冒烟脚本不会读到开发者
   * 自己机器上真实登录着的客户端凭据（否则"未登录"这条断言永远失败）。
   */
  desktopHome?: string;
}

/** 把 fallback 名册转成与目录同形状的对象，供"未登录时也要有列表"使用。 */
function fallbackAsModels(): RaccoonModel[] {
  return FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    vision: m.vision,
    ...(m.multiplier === undefined ? {} : { multiplier: m.multiplier }),
    ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
    ...(m.maxOutput === undefined ? {} : { maxOutput: m.maxOutput }),
    raw: {},
  }));
}

/** 一次目录装载的结果。 */
interface CatalogState {
  models: RaccoonModel[];
  descriptors: ModelDescriptor[];
  ready: boolean;
  error?: string;
}

/** 一次余额装载的结果。 */
interface QuotaState {
  quota: StatusQuota;
}

/**
 * 小浣熊的宿主控制器。
 *
 * 一个实例对应一个插件实例。所有异步操作都是"最后一次赢"：
 * 快速连点两次刷新，第二次的结果会覆盖第一次的，中间态用户看不到。
 */
export class RaccoonHost {
  private readonly options: HostOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  private readonly loginFlow: LoginFlow;
  private readonly publisher: Publisher;
  private readonly catalogCache: ReturnType<typeof createTtlCache<CatalogState>>;
  private readonly quotaCache: ReturnType<typeof createTtlCache<QuotaState>>;

  private token: StoredToken | undefined;
  /** 我们自己落盘的 token（扫码得来）。 */
  private storedToken: StoredToken | undefined;
  /** 从官方桌面客户端读到的 token（只读，不落盘）。 */
  private desktopAuth: DesktopAuth | undefined;
  /** 桌面端凭据的探测结果，给 UI 看。 */
  private desktopStatus: StatusDesktopAuth = { found: false, reason: "尚未探测" };
  /**
   * 用户在本次会话里主动"退出登录"且当时用的是桌面端凭据时置 true。
   *
   * 桌面端凭据我们只读不写，所以"退出登录"没法真的让客户端登出；
   * 能做的是**本会话内不再自动使用它**，避免用户点了退出又被自动读回来。
   * 恢复方式：改设置里的来源、或重启插件（或点"重新读取客户端登录态"）。
   */
  private desktopIgnored = false;
  private probes = new Map<string, boolean>();
  private catalog: CatalogState = { models: [], descriptors: [], ready: false };
  private quota: StatusQuota = {
    available: undefined,
    permanent: undefined,
    daily: undefined,
    dailyGranted: null,
    at: 0,
  };
  private unsubscribeRoutes: (() => void) | undefined;
  private disposed = false;

  constructor(options: HostOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.publisher = new Publisher({
      llm: options.llm,
      logger: options.logger,
      ...(options.get === undefined ? {} : { get: options.get }),
    });

    this.loginFlow = new LoginFlow({
      logger: options.logger,
      renderQr: (content) => renderQrSvg(content),
      qrProtocol: () => options.settings.get().qrProtocol,
      onReady: async (token) => {
        // 扫码拿到的 token 会覆盖桌面端凭据：用户刚刚明确选择了"用这个账号"。
        this.storedToken = token;
        this.token = token;
        this.desktopIgnored = true;
        this.logger.info("login/ready", { kind: token.kind });
        // 登录成功立刻：清掉旧的目录/余额（都属于上一个账号），拉新目录，注册 provider。
        this.catalogCache.clear();
        this.quotaCache.clear();
        await this.refreshCatalog({ force: true });
        this.syncPublisher();
      },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    this.catalogCache = createTtlCache<CatalogState>(CATALOG_TTL_MS, () => this.loadCatalog(), this.now);
    this.quotaCache = createTtlCache<QuotaState>(QUOTA_TTL_MS, () => this.loadQuota(), this.now);
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * 冷启动。由 `apply()` 里 `void host.bootstrap()` 调用。
   *
   * **不抛。** 任何一步失败都只记日志 —— 插件必须能起来，
   * 否则用户在设置页连"为什么坏了"都看不到（设置卡是插件渲染的）。
   *
   * token 解析顺序见 `resolveToken()`（ADR-0008）。
   */
  async bootstrap(): Promise<void> {
    try {
      this.storedToken = await readToken();
      this.probes = await this.readProbesSafely();
      await this.resolveToken("bootstrap");
      // 先同步一次发布器。**没有 token 时它不会注册 provider**（三元门控，
      // 见 docs/02-design/01-module-map.md 的 createPublisher）：注册了也调不通，
      // 只会让用户在模型选择器里选到一个必然报错的项。用户先在插件页扫码，
      // 登录完成时 `onReady` 会再调一次，那时才真正注册。
      this.syncPublisher();
      if (this.token !== undefined) {
        await this.refreshCatalog({ force: false });
        // 余额也在这里拉一次，而且 **await**。
        // 之前在 `snapshot()` 里 `void refreshQuota()` 火后不管，导致用户第一次
        // 打开设置卡看到的是"余额未知"，要等下一次 20s 轮询才出现。桌面端路线
        // 启动时就有 token，没有任何理由让首屏空着（2026-11-06 冒烟暴露）。
        await this.refreshQuota({ force: false });
        this.syncPublisher();
      }
    } catch (error) {
      this.logger.error("bootstrap/failed", { message: messageOf(error) });
    }
  }

  /**
   * 决定这次用哪个 token，并同步登录相位。
   *
   * 三条路（ADR-0008）：
   * 1. 设置里 `authSource === "desktop"` → 只读桌面端凭据。读不到就是未登录。
   * 2. `authSource === "qr"` → 只用我们自己落盘的 token（扫码）。
   * 3. `auto`（默认）→ 桌面端凭据优先，读不到再退回扫码 token。
   *
   * **为什么桌面端优先**：装了官方客户端的用户本来就已经登录了，
   * 再让他扫一次码是纯粹的多余步骤；而且桌面端 token 是官方客户端在维护的，
   * 客户端换号/登出后我们下一次启动就读到新的（或读不到）——
   * 这个"跟着客户端走"的性质比我们自己的 token 更不容易过期。
   *
   * 读不到桌面端凭据**不算错误**：`auto` 下安静地退回扫码路线，
   * 用户在设置卡里能看到"未读到桌面端登录态 + 原因"（`desktopAuth` 字段）。
   */
  private async resolveToken(reason: string): Promise<void> {
    const source: AuthSource = this.options.settings.get().authSource;
    const wantDesktop = source !== "qr" && !this.desktopIgnored;

    if (wantDesktop) {
      const auth = await readDesktopAuth({
        now: this.now,
        ...(this.options.desktopHome === undefined ? {} : { home: this.options.desktopHome }),
      }).catch(() => undefined);
      if (auth !== undefined) {
        const expired = auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= this.now();
        this.desktopAuth = auth;
        this.desktopStatus = {
          found: !expired,
          path: auth.source,
          ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
          ...(expired ? { reason: "客户端凭据已过期，请打开官方客户端刷新" } : {}),
        };
        if (!expired) {
          this.token = {
            schemaVersion: 1,
            token: auth.token,
            kind: auth.kind,
            savedAt: this.now(),
            ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
            ...(auth.principal === undefined ? {} : { principal: auth.principal }),
            source: "desktop",
          };
          this.loginFlow.markReady();
          this.logger.info("token/desktop", {
            token: tokenTag(auth.token),
            path: auth.source,
            exp: auth.expiresAt === undefined ? "-" : auth.expiresAt,
            reason,
          });
          return;
        }
        this.logger.warn("token/desktop-expired", { path: auth.source, reason });
        // 过期不等于"没有"：如果扫码 token 还有，auto 模式该用它。
      } else {
        this.desktopAuth = undefined;
        this.desktopStatus = {
          found: false,
          reason: source === "desktop" ? "未找到桌面客户端登录态" : "未找到桌面客户端登录态，已回退到扫码",
        };
        this.logger.info("token/desktop-missing", { reason });
      }
    }

    if (source === "desktop") {
      // 只用桌面端：扫码 token 即便存在也不许用。
      this.token = undefined;
      return;
    }

    if (this.storedToken !== undefined) {
      this.token = this.storedToken;
      this.loginFlow.markReady();
      this.logger.info("token/qr", {
        token: tokenTag(this.storedToken.token),
        kind: this.storedToken.kind,
        reason,
      });
      return;
    }

    this.token = undefined;
  }

  /** 挂 web 路由。返回注销函数，调用方负责挂到 `ctx.effect`。 */
  mount(webServer: WebServerLike): () => void {
    this.unsubscribeRoutes = registerRoutes(webServer, {
      logger: this.logger,
      snapshot: () => this.snapshot(),
      runAction: (action, body) => this.runAction(action, body),
    });
    return () => this.dispose();
  }

  /** 卸载：注销路由、注销 provider、停掉轮询。可重复调。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRoutes?.();
    this.unsubscribeRoutes = undefined;
    this.loginFlow.dispose();
    this.publisher.dispose("unload");
    this.catalogCache.clear();
    this.quotaCache.clear();
  }

  // ------------------------------------------------------------------ actions

  /**
   * 八个 action 的入口。
   *
   * 任何一个 action 都不该让宿主进程崩 —— 全部包在 try 里，错误变成
   * `{ok:false, error}`。UI 直接把 error 显示出来。
   */
  async runAction(action: string, body: Record<string, unknown>): Promise<ActionResult> {
    try {
      switch (action) {
        case "login-start":
          return await this.actionLoginStart();
        case "login-poll":
          return { ok: true, login: this.loginFlow.snapshot() };
        case "login-cancel":
          this.loginFlow.cancel();
          return { ok: true, login: this.loginFlow.snapshot() };
        case "logout":
          return await this.actionLogout();
        case "refresh-auth":
          return await this.actionRefreshAuth();
        case "refresh-catalog": {
          // 未登录时点"刷新"要有明确答复。静默返回空列表会让用户以为
          // 目录真的空了 —— 而真实原因是"还没登录"。
          if (this.token === undefined) return { ok: false, error: "未登录小浣熊，请先扫码。" };
          await this.refreshCatalog({ force: true });
          // **必须重新发布一次名册。** 目录变了（上游上下线模型、或 contextCap
          // 改了导致 contextWindow/maxTokens 重算），`this.catalog.descriptors`
          // 已经换了一份新数组，但 `syncPublisher()` 不会自己知道 ——
          // 早先这里漏了这一行，表现是：设置卡里上下文显示 64000，
          // 而模型选择器背后注册的还是 128000 那份（2026-11-06 冒烟暴露）。
          this.syncPublisher();
          const failed = this.catalog.error;
          return failed === undefined
            ? { ok: true, models: this.statusModels() }
            : { ok: false, error: failed, models: this.statusModels() };
        }
        case "refresh-quota":
          this.quotaCache.clear();
          await this.refreshQuota({ force: true });
          return { ok: true, quota: this.quota };
        case "probe-vision":
          return await this.actionProbeVision(body);
        case "set-setting":
        case "set-enabled":
          return await this.actionSetSetting(action, body);
        default:
          return { ok: false, error: `未知的 action: ${action}` };
      }
    } catch (error) {
      const text = messageOf(error);
      this.logger.warn("action/failed", { action, message: text });
      return { ok: false, error: text };
    }
  }

  private async actionLoginStart(): Promise<ActionResult> {
    const snapshot = await this.loginFlow.start();
    this.logger.info("login/start", { phase: snapshot.phase });
    return { ok: true, login: snapshot };
  }

  private async actionLogout(): Promise<ActionResult> {
    await clearToken();
    this.storedToken = undefined;
    this.token = undefined;
    // 桌面端凭据只读不写，"退出登录"在本会话内不再自动用它。
    // 这是唯一能表达"我现在不想用这个账号"的方式，且可逆（改来源/重启/重读）。
    if (this.desktopAuth !== undefined) this.desktopIgnored = true;
    this.catalogCache.clear();
    this.quotaCache.clear();
    this.catalog = { models: [], descriptors: [], ready: false };
    this.quota = { available: undefined, permanent: undefined, daily: undefined, dailyGranted: null, at: 0 };
    const snapshot = await this.loginFlow.logout();
    this.publisher.dispose("not-configured");
    this.logger.info("logout", { desktopIgnored: this.desktopIgnored });
    return { ok: true, login: snapshot };
  }

  /**
   * 重新读取登录态。
   *
   * 用户在官方客户端里刚登录/换了账号、或者刚在设置里改了来源时用。
   * 会清掉本会话的"不要用桌面端凭据"标记，然后重跑一遍解析。
   */
  private async actionRefreshAuth(): Promise<ActionResult> {
    this.desktopIgnored = false;
    await this.resolveToken("refresh-auth");
    if (this.token === undefined) {
      this.publisher.dispose("not-configured");
      return {
        ok: false,
        error:
          this.options.settings.get().authSource === "qr"
            ? "当前设置只允许扫码登录，请先扫码。"
            : "没读到可用的登录态：先登录官方小浣熊客户端，或在下面扫码。",
        login: this.loginFlow.snapshot(),
      };
    }
    this.catalogCache.clear();
    this.quotaCache.clear();
    await this.refreshCatalog({ force: true });
    this.syncPublisher();
    return { ok: true, login: this.loginFlow.snapshot(), desktopAuth: this.desktopStatus };
  }

  /**
   * 探一个模型到底能不能读图（ADR-0006）。
   *
   * 用 3×3 纯红 PNG 问颜色。判据刻意宽松：
   * - 提到"红"就算支持
   * - 提到"看不到/无法"就算不支持
   * - 其它一律 `supported: null`（不写结论）
   *
   * 之所以不用带文字的图：那会把"OCR 不行"误判成"看不到图"。
   */
  private async actionProbeVision(body: Record<string, unknown>): Promise<ActionResult> {
    const modelId = typeof body["model"] === "string" ? body["model"] : "";
    if (modelId.length === 0) return { ok: false, error: "缺少 model 参数" };

    const token = this.token?.token;
    if (token === undefined) return { ok: false, error: "未登录小浣熊" };

    const requestBody: Record<string, unknown> = {
      model: modelId,
      stream: true,
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "这张图片是什么颜色？只回答一个词。" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG_BASE64}` } },
          ],
        },
      ],
    };
    applyThinking(requestBody, "off");

    let answer = "";
    await chatStream(token, requestBody, (frame) => {
      if (frame.text !== undefined) answer += frame.text;
      if (frame.reasoning !== undefined) answer += frame.reasoning;
    }, { fetchImpl: this.fetchImpl });

    const verdict = judgeVision(answer);
    if (verdict !== null) {
      this.probes.set(modelId, verdict);
      await recordProbe({ modelId, supported: verdict, at: this.now(), note: answer.slice(0, 40) });
      this.syncPublisher();
    }
    this.logger.info("probe/vision", { model: modelId, verdict: verdict === null ? "unknown" : verdict ? "yes" : "no" });
    return { ok: true, model: modelId, supported: verdict, answer: answer.slice(0, 120) };
  }

  private async actionSetSetting(action: string, body: Record<string, unknown>): Promise<ActionResult> {
    const key = action === "set-enabled" ? "enabled" : typeof body["key"] === "string" ? body["key"] : "";
    const value = body["value"];
    if (key.length === 0) return { ok: false, error: "缺少 key 参数" };
    await this.options.settings.update({ [key]: value });
    const next = this.options.settings.get();
    this.logger.setDebug(next.debugLog);
    if (key === "enabled" || key === "reasoning") this.syncPublisher();
    // 改来源等于换了一套"去哪找 token"的规则，必须重跑一遍解析：
    // 从 qr 切到 desktop 时要读文件，从 desktop 切到 qr 时要把桌面端 token 放下。
    if (key === "authSource") return await this.actionRefreshAuth();
    return { ok: true, settings: next };
  }

  // -------------------------------------------------------------------- state

  /** 状态快照。浏览器半身唯一的数据来源。 */
  async snapshot(): Promise<StatusSnapshot> {
    const settings = this.options.settings.get();

    // 余额是"看一眼"的东西：不阻塞快照，命中缓存就带上，否则返回上次结果。
    void this.refreshQuota({ force: false }).catch(() => undefined);

    const login = loginBlock(this.loginFlow.snapshot(), this.token);
    const base: Omit<StatusSnapshot, "diagnostics"> = {
      build: this.options.build,
      version: this.options.version,
      login,
      publish: this.publisher.state(),
      catalogReady: this.catalog.ready,
      models: this.statusModels(),
      quota: this.quota,
      settings: {
        enabled: settings.enabled,
        reasoning: settings.reasoning,
        visionProbeOverride: settings.visionProbeOverride,
        contextCap: settings.contextCap,
        debugLog: settings.debugLog,
        authSource: settings.authSource,
        qrProtocol: settings.qrProtocol,
      },
      desktopAuth: this.desktopStatus,
      ...(this.catalog.error === undefined ? {} : { catalogError: this.catalog.error }),
    };
    return { ...base, diagnostics: buildDiagnostics({ build: base.build, version: base.version, snapshot: base }) };
  }

  /**
   * 展示用的模型列表。
   *
   * 目录没到手时（未登录、或第一次拉目录还没回来）退回 fallback 名册 ——
   * 否则设置卡在用户第一次打开时是一张空表，用户会以为插件坏了。
   * 注意 **展示** 与 **注册 provider** 是两件事：没有 token 时不注册
   * provider（Publisher 的三元门控），但列表照样有内容可看。
   */
  private statusModels(): StatusModel[] {
    const source: RaccoonModel[] = this.catalog.models.length > 0 ? this.catalog.models : fallbackAsModels();
    const cap = this.options.settings.get().contextCap;
    return source.map((model) => {
      const probed = this.probes.get(model.id);
      // **必须按 contextCap 截断**，与 `provider/roster.ts` 的 `toDescriptor`
      // 用同一套算法。否则设置卡里显示 "1M 上下文"，实际发给模型的是 128000，
      // 用户会以为截断没生效（2026-11-06 冒烟暴露）。
      const contextWindow = Math.min(model.contextWindow ?? DEFAULT_CONTEXT_CAP, cap);
      return {
        id: model.id,
        name: model.name,
        vision: probed ?? model.vision,
        multiplier: model.multiplier,
        contextWindow,
        maxTokens: Math.min(model.maxOutput ?? 8192, Math.floor(contextWindow / 2)),
        ...(probed === undefined ? {} : { probed: true }),
      };
    });
  }

  // --------------------------------------------------------------- data loads

  /** 拉目录。失败不抛，写进 `catalog.error`。 */
  private async refreshCatalog(input: { force: boolean }): Promise<void> {
    const token = this.token?.token;
    if (token === undefined) {
      this.catalog = { models: [], descriptors: this.fallbackDescriptors(), ready: false };
      return;
    }
    try {
      const state = input.force ? await this.catalogCache.get(true) : await this.catalogCache.get();
      this.catalog = state;
      this.logger.info("catalog/loaded", { models: state.models.length });
    } catch (error) {
      const kind = error instanceof RaccoonError ? error.kind : "SERVER";
      const text = messageOf(error);
      this.catalog = { models: this.catalog.models, descriptors: this.fallbackDescriptors(), ready: false, error: text };
      this.logger.warn("catalog/failed", { kind, message: text });
      // 登录态明确失效：把 token 标记成死的，但**不删** ——
      // 本地时钟不准是常态，删了会让"其实还活着"的 token 白丢。
      // 真删只发生在用户点退出登录时。
      if (kind === "AUTH") {
        this.loginFlow.markDead("登录已失效，请重新扫码。");
      }
    }
  }

  private async loadCatalog(): Promise<CatalogState> {
    const token = this.token?.token;
    if (token === undefined) throw new RaccoonError("AUTH", "未登录小浣熊");
    const groups = await fetchCatalog(token, this.fetchImpl);
    const models = flattenCatalog(groups);
    if (models.length === 0) throw new RaccoonError("SERVER", "小浣熊返回的模型目录为空");
    return {
      models,
      descriptors: toDescriptors(models, {
        contextCap: this.options.settings.get().contextCap,
        visionProbe: this.probes,
        sessionIdFor: (modelId) => this.sessionIdForPublish(modelId),
      }),
      ready: true,
    };
  }

  private async refreshQuota(input: { force: boolean }): Promise<void> {
    const token = this.token?.token;
    if (token === undefined) return;
    try {
      const state = input.force ? await this.quotaCache.get(true) : await this.quotaCache.get();
      this.quota = state.quota;
    } catch (error) {
      this.quota = { ...this.quota, at: this.now(), error: messageOf(error) };
      this.logger.warn("quota/failed", { message: messageOf(error) });
    }
  }

  private async loadQuota(): Promise<QuotaState> {
    const token = this.token?.token;
    if (token === undefined) throw new RaccoonError("AUTH", "未登录小浣熊");
    const balance = await fetchBalance(token, this.fetchImpl);
    let dailyGranted: boolean | null = null;
    try {
      const bills = await fetchBills(token, this.fetchImpl, 50);
      dailyGranted = todayGranted(bills, new Date(this.now())) !== undefined;
    } catch {
      // 流水拿不到不影响余额展示。
      dailyGranted = null;
    }
    return {
      quota: {
        available: balance.available,
        permanent: balance.permanent,
        daily: balance.daily,
        dailyGranted,
        at: this.now(),
      },
    };
  }

  // ------------------------------------------------------------------ publish

  /**
   * 同步 provider 注册。
   *
   * 名册来源优先目录，目录没到手时用 fallback —— 这样"没登录也能在
   * 模型选择器里看到小浣熊"，点进去才提示登录。这个选择有代价：
   * fallback 名册里的模型可能与真实目录不一致，用户可能选到一个实际
   * 不存在的模型。但这比"整个插件在模型列表里消失"好，后者用户根本
   * 找不到入口。
   */
  private syncPublisher(): void {
    if (this.disposed) return;
    const settings = this.options.settings.get();
    const models = this.catalog.descriptors.length > 0 ? this.catalog.descriptors : this.fallbackDescriptors();
    this.publisher.sync(
      {
        enabled: settings.enabled,
        reasoningEnabled: settings.reasoning,
        models,
        token: this.token?.token,
      },
      async () => this.token?.token,
    );
  }

  private fallbackDescriptors(): ModelDescriptor[] {
    const settings = this.options.settings.get();
    return toDescriptors(
      fallbackAsModels(),
      {
        contextCap: settings.contextCap,
        visionProbe: this.probes,
        sessionIdFor: (modelId) => this.sessionIdForPublish(modelId),
      },
    );
  }

  /**
   * 会话 id。
   *
   * **按模型定型**：同一个账号 + 同一个模型永远得到同一个 `sess-0-xxxxxxxx`。
   * 理由是官方客户端的行为：26 分钟 125 次调用都用同一个 id（见
   * docs/01-research/03-raccoon-protocol.md §3.2）。每次请求新 id 会让网关
   * 看到"一个账号几分钟内开了几百个会话"，那是它反感的东西。
   */
  private sessionIdForPublish(modelId: string): string {
    const principal = this.token?.principal ?? "anonymous";
    return sessionIdFor(principal, modelId);
  }

  private async readProbesSafely(): Promise<Map<string, boolean>> {
    try {
      const stored = await readProbes();
      const out = new Map<string, boolean>();
      for (const [id, probe] of stored) out.set(id, probe.supported);
      return out;
    } catch {
      return new Map();
    }
  }

  /** 供测试断言：当前名册签名。 */
  signature(): string {
    const models = this.catalog.descriptors.length > 0 ? this.catalog.descriptors : this.fallbackDescriptors();
    return rosterSignature(models);
  }

  /** 供测试断言：当前 token（只在宿主内部转手用）。 */
  currentToken(): StoredToken | undefined {
    return this.token;
  }

  /** 供 action 之外的地方（比如 probe 完成后）把 token 换掉。 */
  setToken(token: StoredToken | undefined): void {
    this.token = token;
    if (token === undefined) {
      this.storedToken = undefined;
      return;
    }
    if (token.source === "desktop") {
      // 桌面端凭据**不落盘**（ADR-0008 的三条边界）。
      return;
    }
    this.storedToken = token;
    void saveToken(token).catch(() => undefined);
  }

  /** 桌面端凭据探测结果（诊断/UI 用）。 */
  desktopAuthStatus(): StatusDesktopAuth {
    return this.desktopStatus;
  }

  /** 当前 provider id。UI 与测试都要它。 */
  get providerId(): string {
    return PROVIDER_ID;
  }
}

/**
 * 从模型的回答里判识图能力。
 *
 * 三态：true / false / null（看不出结论就不写，见 ADR-0006 的"错报代价不对称"）。
 */
export function judgeVision(answer: string): boolean | null {
  const text = answer.trim();
  if (text.length === 0) return null;
  if (/红|red|#?(ed1c24|ff0000)/i.test(text)) return true;
  if (/看不到|看不见|无法|不能|cannot|can't|no image|not able/i.test(text)) return false;
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof RaccoonError) return error.userText;
  return error instanceof Error ? error.message : String(error);
}
