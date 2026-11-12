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
import type { StatusBrowser, StatusDesktopAuth, StatusModel, StatusPool, StatusPoolAccount, StatusQuota, StatusSnapshot } from "./status.js";
import type { ActionResult, WebServerLike } from "./routes.js";

import { buildDiagnostics } from "./status.js";
import { loginBlock, registerRoutes } from "./routes.js";
import { createTtlCache } from "./cache.js";
import { LoginFlow, type LoginMode } from "./login-flow.js";
import { tokenTag } from "./log.js";
import { Publisher, rosterSignature, type PublishAccountResolver } from "./publish.js";
import { PROBE_PNG_BASE64 } from "./solid-png.js";
import { clearToken, readProbes, readToken, recordProbe, saveToken, type StoredToken } from "./store.js";
import {
  classifyMeasure,
  isCooling,
  mergePools,
  readPool,
  shouldPersistMeasure,
  sortForUse,
  upsertAccount,
  writePool,
  type PoolAccount,
  type PoolQuota,
  type PoolSource,
} from "./pool.js";
import { toDescriptors, type ModelDescriptor } from "../provider/roster.js";
import { FALLBACK_MODELS } from "../provider/fallback-roster.js";
import { fetchCatalog, flattenCatalog } from "../protocol/catalog.js";
import { readDesktopAuth, type DesktopAuth } from "../protocol/desktop-auth.js";
import { fetchBalance, fetchBills, grantDaily, todayGranted } from "../protocol/points.js";
import { applyThinking, chatStream, jwtClaims, principalOf, sessionIdFor } from "../protocol/chat.js";
import { renderQrSvg } from "../protocol/qr.js";
import { validateToken } from "../protocol/iam.js";
import {
  exchangeCode,
  startLoopback,
  type LoopbackResult,
  type LoopbackSession,
} from "../protocol/loopback.js";
import { CATALOG_TTL_MS, DEFAULT_CONTEXT_CAP, PROVIDER_ID, QUOTA_TTL_MS } from "../protocol/consts.js";
import { RaccoonError, type RaccoonErrorKind } from "../protocol/errors.js";
import type { RaccoonModel } from "../protocol/catalog.js";

/**
 * `RaccoonErrorKind` → `MeasureInput.kind` 的映射。
 *
 * 两套词表刻意不同：错误分类面向"这次请求发生了什么"，测量分类面向"这个账号
 * 现在能不能用"。`INVALID_REQUEST` 与 `ABORTED` 在后者里没有对应项 —— 它们
 * 说明请求本身不成立，换一个号也一样失败，记成冷却只会白躺一个好号。
 */
const ACCOUNT_KINDS: Partial<Record<RaccoonErrorKind, "AUTH" | "RATE_LIMIT" | "SERVER" | "TIMEOUT" | "TRANSPORT">> = {
  AUTH: "AUTH",
  RATE_LIMIT: "RATE_LIMIT",
  SERVER: "SERVER",
  TIMEOUT: "TIMEOUT",
  TRANSPORT: "TRANSPORT",
};

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
  /**
   * 号池（ADR-0010）。
   *
   * 空数组 ≠ "没有号池"：`accounts` 是**用户显式勾选过的成员**，池空就是不换号。
   * 与 `poolEnabled` 是两件事 —— 关掉开关只停止自动换号，账号列表与签到/测试
   * 仍然可用（workbuddy 把按钮挂在开关上，导致关掉后再也没法签到）。
   */
  private accounts: PoolAccount[] = [];
  /** 号池成员最近一次的余额读数。**不落盘**：它是测量，不是配置。 */
  private poolQuota = new Map<string, PoolQuota>();
  /** 当前在服务的池成员 id。`poolEnabled` 关掉时恒 undefined。 */
  private poolActiveId: string | undefined;
  /**
   * 在途的浏览器 loopback 登录（ADR-0012）。
   *
   * 只有一份：同一时刻只允许一个"浏览器登录"在等回调。理由与 `LoginFlow`
   * 的 `generation` 相同 —— 两个回调服务同时开着，用户不知道哪个页面在等，
   * 而结果会写进同一个地方。再点一次就先关掉旧的。
   *
   * `mode` 决定结果去哪：`primary` = 换当前账号（写 `token.json`），
   * `pool` = 往号池加一个成员（不动当前账号，ADR-0010 §4）。
   */
  private browserLogin:
    | { session: LoopbackSession; close: () => void; startedAt: number; mode: LoginMode }
    | undefined;
  /** 浏览器登录给用户看的一句话（成功/失败/取消）。 */
  private browserNote: string | undefined;
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
      onReady: async (token, mode) => {
        // 号池模式：只加成员，不碰"当前账号"（ADR-0010 §4）。
        if (mode === "pool") {
          await this.addPoolAccount(token, "qr");
          return;
        }
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
      // 号池在 token 解析之前读：`resolveToken()` 之后要决定"这次谁服务"，
      // 而号池里的活跃成员可能压根不是 `token.json` 那个账号。
      this.accounts = await readPool().catch(() => []);
      await this.resolveToken("bootstrap");
      // 先同步一次发布器。**没有 token 时它不会注册 provider**（三元门控，
      // 见 docs/02-design/01-module-map.md 的 createPublisher）：注册了也调不通，
      // 只会让用户在模型选择器里选到一个必然报错的项。用户先在插件页扫码，
      // 登录完成时 `onReady` 会再调一次，那时才真正注册。
      this.syncPublisher();
      // 判据是 `activeToken()` 而不是 `this.token`：号池开着的时候真正在服务的
      // 是池成员，`this.token`（当前账号）可能恰好是空的 —— 那种情况下
      // 用 `this.token` 判会让首屏永远是"目录未就绪 / 余额未知"。
      if (this.activeToken() !== undefined) {
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
    // 在途的浏览器回调服务必须收掉：它是真的在监听一个端口，
    // 插件卸载后还开着就是一个孤立的监听者（也是端口泄漏）。
    this.closeBrowserLogin("插件已卸载。");
    this.loginFlow.dispose();
    this.publisher.dispose("unload");
    this.catalogCache.clear();
    this.quotaCache.clear();
  }

  // ------------------------------------------------------------------ actions

  /**
   * 全部 action 的唯一入口。
   *
   * 十八个 `case`、十六个 action 名（`set-setting` 与 `set-enabled` 同体）。
   * 任何一个 action 都不该让宿主进程崩 —— 全部包在 try 里，错误变成
   * `{ok:false, error}`。UI 直接把 error 显示出来。
   *
   * **新增 action 必须同时改三处**：这里的 switch、`client.js` 里发起它的按钮、
   * 以及 `docs/02-design/07-account-pool.md` §5 的动作表 —— 少改一处就会留下
   * "界面上有按钮但宿主不认"或"宿主支持但没人调"的死代码。
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
          //
          // 判据必须是 `activeToken()` 而不是 `this.token`：号池开着的时候
          // 真正在服务的可能是池里的号，而 `this.token`（当前账号）可能恰好
          // 是空的（比如只导入过池成员、没扫过码）。用 `this.token` 判会让
          // 这种用户点"刷新"得到"未登录"—— 但他明明能用。
          if (this.activeToken() === undefined) {
            return {
              ok: false,
              error: "未登录小浣熊：装过官方客户端的话打开它登录即可；没有客户端就扫码登录。",
            };
          }
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
        case "pool-add-start":
          return await this.actionPoolAddStart();
        case "pool-add-browser":
          return await this.actionPoolAddBrowser();
        case "pool-add-browser-cancel":
          return this.actionPoolAddBrowserCancel();
        case "pool-import-desktop":
          return await this.actionPoolImportDesktop();
        case "pool-toggle":
          return await this.actionPoolToggle(body);
        case "pool-remove":
          return await this.actionPoolRemove(body);
        case "pool-checkin":
          return await this.actionPoolCheckin();
        case "pool-test":
          return await this.actionPoolTest(body);
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
    // 同 `refresh-catalog`：号池里可能有可用成员，而当前账号是空的。
    // 只看 `this.token` 会让"只用号池"的用户被判成未登录。
    if (this.activeToken() === undefined) {
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

    // 与其它发请求的路径一致：号池开着时该用池成员探，而不是当前账号。
    // 探图要花一次真实对话额度，用错号会让用户以为"这个号支持/不支持"。
    const token = this.activeToken();
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
    // 号池开关直接影响"谁服务 + 带哪个设备身份"，必须重新发布名册。
    // 关掉时要立刻退回当前账号，否则用户关了开关发现还在用池里的号。
    if (key === "poolEnabled") {
      this.poolActiveId = undefined;
      this.syncPublisher();
    }
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

    const login = loginBlock(this.loginFlow.snapshot(), this.displayToken());
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
        poolEnabled: settings.poolEnabled,
      },
      desktopAuth: this.desktopStatus,
      pool: this.poolSnapshot(),
      browser: this.browserSnapshot(),
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
    const token = this.activeToken();
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
      //
      // **两个前提条件，2026-11-11 补**：
      //
      // 1. 号池在服务时，坏掉的是**池成员**的凭据，不是当前账号的登录态。
      //    `recordMeasure()` 已经把那个号标成 `dead` 并在下一次请求换号 ——
      //    这里再把主登录相位改成 `expired`，用户会看到"登录已失效，请重新扫码"，
      //    而他的当前账号其实是好的（典型现场：装过客户端 + 池里另有一个过期号）。
      // 2. 桌面端凭据过期时不能叫他"重新扫码" —— 他从来没扫过码，
      //    该做的是打开官方客户端刷新（ADR-0008 只读、不代持，我们续不了）。
      if (kind === "AUTH" && this.peekPoolAccount() === undefined) {
        // **判死之前先重读一次桌面端凭据**（2026-11-12 补）。
        //
        // 现场：用户在官方客户端里退出账号 A、登录账号 B，然后回到 DSH 发消息。
        // 我们内存里的 `this.token` 还是 A 的（只在上次 `resolveToken()` 时读过），
        // 于是 401 → 直接 `markDead("客户端凭据已失效…")`，让用户去重登客户端 ——
        // 可他明明刚登完。更糟的是这个 `expired` 相位会一直挂着。
        //
        // 重读一次几乎零成本（读一个本地小文件），而且能把"客户端换了号"
        // 与"客户端凭据真失效"这两件事分开。
        const reread = await this.rereadDesktopAuth();
        if (reread) {
          this.logger.info("catalog/auth-recovered", { reason: "desktop credential changed" });
          return;
        }
        this.loginFlow.markDead(
          this.token?.source === "desktop"
            ? "客户端凭据已失效，请打开官方客户端重新登录。"
            : "登录已失效，请重新扫码。",
        );
      }
    }
  }

  /**
   * 401 之后重读桌面端凭据。**读到且与内存里不同才算"救回来了"。**
   *
   * 与 `resolveToken()` 的区别：
   * - `resolveToken()` 是启动/主动刷新时走的完整三态决策，会改 `desktopIgnored`
   *   之类的字段、会打 `token/desktop` 日志、会 `markReady()`。
   * - 这里是**一条窄路**：只问"客户端换号了吗"。换了就把新 token 换上、
   *   重建名册；没换就返回 `false`，让调用方按原来的逻辑判死。
   *
   * 判断"换了"的判据是 token 字符串本身不相等，不是 principal —— 同一个账号
   * 重新登录也会拿到新 token（旧的可能被服务端拉黑了），这种情况也该重试一次。
   */
  private async rereadDesktopAuth(): Promise<boolean> {
    if (this.options.settings.get().authSource === "qr") return false;
    const auth = await readDesktopAuth({
      now: this.now,
      ...(this.options.desktopHome === undefined ? {} : { home: this.options.desktopHome }),
    }).catch(() => undefined);
    if (auth === undefined) return false;
    const expired = auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= this.now();
    if (expired) return false;
    if (auth.token === this.token?.token) return false;

    this.desktopAuth = auth;
    this.desktopStatus = {
      found: true,
      path: auth.source,
      ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
    };
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
    this.logger.info("token/desktop-reread", {
      token: tokenTag(auth.token),
      path: auth.source,
      principal: auth.principal ?? "-",
    });
    // 名册里的 session id 是按 principal 算的，换了号必须重建。
    this.syncPublisher();
    return true;
  }

  private async loadCatalog(): Promise<CatalogState> {
    const token = this.activeToken();
    if (token === undefined) throw new RaccoonError("AUTH", "未登录小浣熊");
    const groups = await fetchCatalog(token, this.fetchImpl);
    const models = flattenCatalog(groups);
    if (models.length === 0) throw new RaccoonError("SERVER", "小浣熊返回的模型目录为空");
    const deviceId = this.activeDeviceId();
    return {
      models,
      descriptors: toDescriptors(models, {
        contextCap: this.options.settings.get().contextCap,
        visionProbe: this.probes,
        sessionIdFor: (modelId) => this.sessionIdForPublish(modelId),
        ...(deviceId === undefined ? {} : { deviceId }),
      }),
      ready: true,
    };
  }

  private async refreshQuota(input: { force: boolean }): Promise<void> {
    const token = this.activeToken();
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
    const token = this.activeToken();
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
    // 池成员顺手更新读数：`sortForUse()` 的排序要靠它，而请求路径不能为排序
    // 去打上游（ADR-0010 §6），所以只能在这里攒。
    const pooled = this.resolvePoolAccount();
    if (pooled !== undefined) {
      this.poolQuota.set(pooled.id, {
        ...(balance.available === undefined ? {} : { available: balance.available }),
        ...(balance.daily === undefined ? {} : { daily: balance.daily }),
        ...(balance.permanent === undefined ? {} : { permanent: balance.permanent }),
        at: this.now(),
      });
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

  // --------------------------------------------------------------------- pool

  /**
   * 把一个刚拿到（扫码 / 导入）的凭据加进号池。
   *
   * **不加进"当前账号"。** 加池只是"这个号以后可以被我用来顶班"，
   * 真正用它服务要等 `poolEnabled` 打开且它被 `sortForUse()` 选中。
   * 新成员一律 `enabled: false` —— 见 ADR-0010 §3：本机登录着不等于
   * 用户同意拿它去花积分，必须由用户勾选一次。
   */
  /**
   * 落盘号池。**先与磁盘合并，再整表写。**
   *
   * `writePool()` 是整表原子写，而 `this.accounts` 是内存快照。两者可能不同步
   * （插件重启后别处写过、上一次写入失败只更新了内存、用户手改过文件）。
   * 直接写内存那份，磁盘上多出来的账号就被抹掉了 —— 用户看到的现象是
   * "导入第二个账号，第一个账号没了"。账号没被删，是被一张过期的整表覆盖了。
   *
   * 合并之后再更新 `this.accounts`，让内存与磁盘对齐（否则界面上看不到
   * 磁盘里那个号，下次写入又把它抹掉）。
   */
  private async savePool(): Promise<void> {
    const disk = await readPool().catch(() => [] as PoolAccount[]);
    this.accounts = mergePools(this.accounts, disk);
    await writePool(this.accounts);
  }

  private async addPoolAccount(token: StoredToken, source: PoolSource): Promise<void> {
    const principal = token.principal ?? "";
    if (principal.length === 0) {
      this.logger.warn("pool/add-no-principal", { source });
      return;
    }
    // 先把磁盘上的号并进来再 upsert：`this.accounts` 可能比磁盘旧，
    // 直接 upsert 一份旧表再整表写，就会把磁盘上别的账号抹掉（"导入第二个号，
    // 第一个号消失"就是这么来的）。
    const disk = await readPool().catch(() => [] as PoolAccount[]);
    this.accounts = upsertAccount(mergePools(this.accounts, disk), {
      token: token.token,
      kind: token.kind,
      principal,
      ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      source,
      now: this.now(),
    });
    await this.savePool().catch((error: unknown) => {
      this.logger.error("pool/write-failed", { message: messageOf(error) });
    });
    const added = this.accounts.find((a) => a.principal === principal);
    this.logger.info("pool/add", {
      id: added?.id.slice(0, 8) ?? "-",
      source,
      total: this.accounts.length,
      enabled: added?.enabled === true,
    });
    // 池成员变了，谁服务可能变（比如原来池空、现在有号但没启用 → 不变）。
    this.syncPublisher();
  }

  /**
   * 纯函数版选号：给定当前状态，算出"该用谁"。**不改任何字段、不打日志。**
   *
   * 返回 undefined 有五种情况，UI 需要能区分（`pool.note`）：
   * 池关、池空、一个都没启用、全部在冷却、全部凭据已死。
   *
   * 为什么要拆出纯函数：`snapshot()` 每 20 秒被前端轮询一次（`status` 端点），
   * 它要展示"当前用的是哪个号"。如果展示路径直接调会写状态的版本，就等于
   * **只读路径带副作用** —— 状态字段被一次"看一眼"改写、日志被轮询节奏驱动。
   * 拆开之后 `snapshot()` 是纯的，写状态只发生在真正要发请求的那条路径上。
   */
  private selectPoolAccount(): PoolAccount | undefined {
    if (!this.options.settings.get().poolEnabled) return undefined;
    const enabled = this.accounts.filter((a) => a.enabled);
    if (enabled.length === 0) return undefined;
    // 已经选定的那个还可用就继续用它。
    //
    // 为什么需要"粘住"：`sortForUse()` 的输入里有余额读数，而读数会在一轮对话
    // 中途被刷新。不粘住的话，用户正在聊的这轮可能中途换到另一个号 ——
    // 会话 id 与设备身份都跟着变，上游看到的是"一个人在两台设备上接力说话"。
    // 只有"它不可用了"（冷却 / 被取消勾选 / 被删）才重新选。
    const pinned = this.poolActiveId === undefined ? undefined : enabled.find((a) => a.id === this.poolActiveId);
    if (pinned !== undefined && !isCooling(pinned, this.now())) return pinned;

    const ordered = sortForUse(enabled, this.poolQuota, this.now());
    const pick = ordered[0];
    if (pick === undefined || isCooling(pick, this.now())) return undefined;
    return pick;
  }

  /** 只读地看"现在该用谁"。展示路径（status / 诊断 / 设置卡）走这条。 */
  private peekPoolAccount(): PoolAccount | undefined {
    return this.selectPoolAccount();
  }

  /**
   * 把"现在该用谁"定下来：粘住 + 记一次日志。**发请求的路径走这条。**
   *
   * 与 `peekPoolAccount()` 用同一个纯函数，所以两者结果永远一致 —— 界面显示的
   * 当前号就是真正在发请求的那个号。
   */
  private resolvePoolAccount(): PoolAccount | undefined {
    const pick = this.selectPoolAccount();
    if (pick === undefined) {
      this.poolActiveId = undefined;
      return undefined;
    }
    if (this.poolActiveId !== pick.id) {
      this.poolActiveId = pick.id;
      this.logger.info("pool/pick", {
        id: pick.id.slice(0, 8),
        candidates: this.accounts.filter((a) => a.enabled).length,
      });
    }
    return pick;
  }

  /** 当前该用哪个 token：号池优先，退回单账号路径。 */
  private activeToken(): string | undefined {
    const pooled = this.resolvePoolAccount();
    if (pooled !== undefined) return pooled.token;
    return this.token?.token;
  }

  /** 当前该带哪个设备身份。单账号路径不带（ADR-0010 §7）。 */
  private activeDeviceId(): string | undefined {
    return this.resolvePoolAccount()?.deviceId;
  }

  /**
   * 展示用的"当前账号"。**只读，不选号。**
   *
   * `loginBlock()` 要的是 `principal` / `kind` / `expiresAt` / `source` 四个字段，
   * 而真正在服务的那份凭据可能是号池里的成员（`this.token` 可能是空的）。
   * 早先这里直接传 `this.token`，后果是：只用号池的用户，设置卡上"账号"那一行
   * 永远是 `—`，看起来像没登录成功。
   *
   * 走 `peekPoolAccount()` 而不是 `resolvePoolAccount()` —— 展示路径不能写状态
   * （`snapshot()` 每 20 秒被轮询一次）。
   */
  private displayToken():
    | { principal?: string; kind?: "access_token" | "xhx_token"; expiresAt?: number; source?: "qr" | "desktop" | "browser" }
    | undefined {
    const pooled = this.peekPoolAccount();
    if (pooled !== undefined) {
      return {
        principal: pooled.principal,
        kind: pooled.kind,
        ...(pooled.expiresAt === undefined ? {} : { expiresAt: pooled.expiresAt }),
        source: pooled.source,
      };
    }
    return this.token;
  }

  /** 记一次测量。**只对池成员记**，非成员不记（否则会白白闲置好号）。 */
  private recordMeasure(status: number, bodyText?: string): void {
    const pooled = this.resolvePoolAccount();
    if (pooled === undefined) return;
    const measure = classifyMeasure({
      status,
      ...(bodyText === undefined ? {} : { bodyText }),
      now: this.now(),
    });
    // `undefined` = 这次失败与账号无关（典型是 HTTP 400）。记下来会让一个好号
    // 白躺 30 分钟，比不记更糟。
    if (measure === undefined) return;
    // **连续成功不重复落盘**（`shouldPersistMeasure()` 里有完整理由）：
    // `onResponse` 每次请求都会调到这里，而 `writePool()` 是整表原子写
    // （含明文 token）。每发一轮对话就重写一遍 accounts.json，既费 IO 又把
    // 日志刷成 `pool/measure ok` 的海洋。
    if (!shouldPersistMeasure(pooled.measure, measure)) return;
    this.accounts = this.accounts.map((a) => (a.id === pooled.id ? { ...a, measure } : a));
    // 这里**刻意**用裸 `writePool()` 而不是 `savePool()`：这条路径挂在每个
    // 响应上，合并要先读一次磁盘，等于每次对话多一次读。而它只改 `measure`
    // 一个字段 —— 内存表比磁盘旧的风险在这个字段上无害（冷却记录会过期）。
    void writePool(this.accounts).catch(() => undefined);
    this.logger.info("pool/measure", { id: pooled.id.slice(0, 8), state: measure.state, status });
    // 这个号刚被判死/冷却：换下一个，并且让名册换实例（设备身份要跟着换）。
    if (measure.state !== "ok") {
      this.poolActiveId = undefined;
      this.syncPublisher();
    }
  }

  /** 号池的展示快照。**不含 token**（`status.ts` 硬规则第 1 条）。 */
  private poolSnapshot(): StatusPool {
    const settings = this.options.settings.get();
    // 只读路径：`status` 每 20 秒被轮询一次，这里绝不能写 `poolActiveId` 或打日志。
    const active = this.peekPoolAccount();
    const enabledCount = this.accounts.filter((a) => a.enabled).length;
    const accounts: StatusPoolAccount[] = this.accounts.map((account) => ({
      id: account.id,
      ...(account.label === undefined ? {} : { label: account.label }),
      principal: account.principal.slice(0, 8),
      ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
      addedAt: account.addedAt,
      enabled: account.enabled,
      // 只给 8 位十六进制，**不带 `raccoon-` 前缀** —— 前缀占满 8 个字符时
      // 界面上会显示成 `raccoon-`，看起来像"设备标识是空的"。
      device: account.deviceId.replace(/^raccoon-/, "").slice(0, 8),
      source: account.source,
      ...(account.measure === undefined
        ? {}
        : {
            measure: {
              state: account.measure.state,
              at: account.measure.at,
              ...(account.measure.until === undefined ? {} : { until: account.measure.until }),
              ...(account.measure.note === undefined ? {} : { note: account.measure.note }),
            },
          }),
      active: active !== undefined && active.id === account.id,
    }));

    const base: StatusPool = {
      enabled: settings.poolEnabled,
      ready: this.accounts.length > 0,
      total: this.accounts.length,
      enabledCount,
      ...(active === undefined ? {} : { activeId: active.id }),
      accounts,
    };

    // 只在"开了但没人能服务"时给 note：正常工作时多一行说明只是噪音。
    if (settings.poolEnabled && active === undefined) {
      if (this.accounts.length === 0) base.note = "池是空的。先加一个账号。";
      else if (enabledCount === 0) base.note = "有账号但一个都没勾选启用，所以还是用当前账号。";
      else base.note = "启用的账号都在冷却或凭据已失效，暂时退回当前账号。";
    }
    return base;
  }

  /** 加一个池成员（扫码）。 */
  private async actionPoolAddStart(): Promise<ActionResult> {
    const snapshot = await this.loginFlow.start("pool");
    this.logger.info("pool/add-start", { phase: snapshot.phase });
    return { ok: true, login: snapshot, pool: this.poolSnapshot() };
  }

  /**
   * 加一个池成员（浏览器 loopback，ADR-0012）。
   *
   * 这条路 2026-11-12 起是"加号"的主路线：扫码那条（`/login/mp`）在服务端
   * 侧已经 404，用户微信扫出来的只有"二维码已过期或已被使用"。
   *
   * 流程：本机起一次性回调服务 → 把 `/authorize?...&redirect=http://127.0.0.1:<port>/auth/callback&state=...`
   * 交给用户 → 用户在浏览器里正常登录 → 浏览器重定向回本机 → 我们拿 `code`
   * 调 `login_with_authorization_code` 换 token → 加进池。
   *
   * 三条纪律：
   * 1. **不阻塞**：`wait` 是后台跑的，action 立刻返回 `browser.url` 让界面能显示。
   * 2. **只有一份**：再点一次先关掉上一轮（否则两个回调服务同时等，用户不知道哪个页面在等）。
   * 3. **失败要落到界面上**：结果写进 `browserSnapshot().message`，用户回来能看到原因。
   */
  private async actionPoolAddBrowser(mode: LoginMode = "pool"): Promise<ActionResult> {
    this.closeBrowserLogin("已重新发起浏览器登录。");

    let started: Awaited<ReturnType<typeof startLoopback>>;
    try {
      started = await startLoopback({
        exchange: (code) => exchangeCode(code, this.fetchImpl),
        now: this.now,
      });
    } catch (error) {
      const message = messageOf(error);
      this.logger.error("pool/browser-listen-failed", { message });
      this.browserNote = `无法在本机起登录回调服务：${message}`;
      return { ok: false, error: this.browserNote, browser: this.browserSnapshot() };
    }

    const { session, wait, close } = started;
    this.browserLogin = { session, close, startedAt: this.now(), mode };
    this.browserNote = "已打开浏览器授权页，请在浏览器里完成登录。";
    this.logger.info("pool/browser-start", { port: session.port, mode });

    // 后台等结果。`void` + 自己的 catch：`wait` 本身不会 reject，
    // 但 `handleBrowserResult` 里会写盘，写盘可能失败。
    void wait
      .then(async (result) => {
        await this.handleBrowserResult(session, result);
      })
      .catch((error: unknown) => {
        this.logger.error("pool/browser-failed", { message: messageOf(error) });
        this.browserNote = `浏览器登录失败：${messageOf(error)}`;
        this.browserLogin = undefined;
      });

    return { ok: true, browser: this.browserSnapshot(), pool: this.poolSnapshot() };
  }

  /** 用户点了取消。 */
  private actionPoolAddBrowserCancel(): ActionResult {
    if (this.browserLogin === undefined) {
      return { ok: false, error: "当前没有在等待浏览器登录。", browser: this.browserSnapshot() };
    }
    this.closeBrowserLogin("已取消浏览器登录。");
    this.logger.info("pool/browser-cancel");
    return { ok: true, browser: this.browserSnapshot(), pool: this.poolSnapshot() };
  }

  /** 关掉在途的浏览器登录（若在）。`note` 会显示在界面上。 */
  private closeBrowserLogin(note: string): void {
    const current = this.browserLogin;
    if (current === undefined) return;
    this.browserLogin = undefined;
    this.browserNote = note;
    try {
      current.close();
    } catch {
      // `close()` 只是收摊，失败不影响任何状态。
    }
  }

  /**
   * 浏览器回调到齐之后的收尾。
   *
   * 判据与 `LoginFlow.complete()` 一致：**`validateToken()` 是唯一权威**。
   * 换到 token 不等于能用 —— IAM 发的 JWT 与业务网关认的 token 不完全等价，
   * 直接加进池会让用户在这个号被选中时才发现 401。
   */
  private async handleBrowserResult(session: LoopbackSession, result: LoopbackResult): Promise<void> {
    // 这一轮已经不是"当前这一轮"了（用户又点了一次 / 取消了）：结果丢弃。
    if (this.browserLogin?.session.state !== session.state) return;
    this.browserLogin = undefined;

    if (result.status !== "success" || result.accessToken === undefined) {
      this.browserNote = result.message ?? "浏览器登录未完成。";
      this.logger.info("pool/browser-result", { status: result.status });
      return;
    }

    const valid = await validateToken(result.accessToken, this.fetchImpl).catch(() => false);
    if (!valid) {
      this.browserNote = "账号已授权，但模型网关拒绝了这次登录令牌。请重试；若持续出现，请稍后再试。";
      this.logger.warn("pool/browser-invalid-token");
      return;
    }

    const claims = jwtClaims(result.accessToken);
    const exp = typeof claims?.["exp"] === "number" ? (claims["exp"] as number) * 1000 : undefined;
    const principal = principalOf(result.accessToken);
    if (principal === undefined || principal.length === 0) {
      this.browserNote = "登录成功，但令牌里没有账号标识，无法加入号池。";
      this.logger.warn("pool/browser-no-principal");
      return;
    }

    await this.addPoolAccount(
      {
        schemaVersion: 1,
        token: result.accessToken,
        kind: "access_token",
        savedAt: this.now(),
        ...(exp === undefined ? {} : { expiresAt: exp }),
        principal,
        source: "browser",
      },
      "browser",
    );
    this.browserNote = `已加入账号池（${principal.slice(0, 8)}）。新加的号默认未启用，勾上才会拿去发请求。`;
    this.logger.info("pool/browser-added", { principal: principal.slice(0, 8) });
  }

  /** 浏览器登录状态（给 status / action 返回用）。**不含 code、不含 token。** */
  private browserSnapshot(): StatusBrowser {
    const current = this.browserLogin;
    if (current === undefined) {
      return { active: false, ...(this.browserNote === undefined ? {} : { message: this.browserNote }) };
    }
    return {
      active: true,
      url: current.session.url,
      port: current.session.port,
      startedAt: current.startedAt,
      ...(this.browserNote === undefined ? {} : { message: this.browserNote }),
    };
  }

  /** 把官方桌面客户端的凭据加进池（用户明确点了"导入"才走这条）。 */
  private async actionPoolImportDesktop(): Promise<ActionResult> {
    const auth = await readDesktopAuth({
      now: this.now,
      ...(this.options.desktopHome === undefined ? {} : { home: this.options.desktopHome }),
    }).catch(() => undefined);
    if (auth === undefined) {
      return { ok: false, error: "没读到官方客户端登录态：先打开小浣熊客户端登录一次。", pool: this.poolSnapshot() };
    }
    if (auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= this.now()) {
      return { ok: false, error: "客户端凭据已过期，请打开官方客户端刷新后再导入。", pool: this.poolSnapshot() };
    }
    if (auth.principal === undefined) {
      return { ok: false, error: "客户端凭据里没有账号标识，无法导入。", pool: this.poolSnapshot() };
    }
    await this.addPoolAccount(
      {
        schemaVersion: 1,
        token: auth.token,
        kind: auth.kind,
        savedAt: this.now(),
        ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
        principal: auth.principal,
        source: "desktop",
      },
      "desktop",
    );
    return { ok: true, pool: this.poolSnapshot() };
  }

  /** 勾选/取消勾选一个池成员。即时生效（不做草稿，勾选本身就是意图）。 */
  private async actionPoolToggle(body: Record<string, unknown>): Promise<ActionResult> {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    if (id.length === 0) return { ok: false, error: "缺少 id 参数" };
    const enabled = body["enabled"] === true;
    const before = this.accounts;
    const next = this.accounts.map((a) => (a.id === id ? { ...a, enabled } : a));
    if (next.every((a, i) => a.enabled === before[i]?.enabled)) {
      return { ok: false, error: "没有这个账号", pool: this.poolSnapshot() };
    }
    this.accounts = next;
    try {
      await this.savePool();
    } catch (error) {
      // 落盘失败要把内存回滚：否则界面显示已启用、重启后又变回未启用，
      // 用户会以为是插件在随机忘事。
      this.accounts = before;
      return { ok: false, error: `保存失败：${messageOf(error)}`, pool: this.poolSnapshot() };
    }
    this.logger.info("pool/toggle", { id: id.slice(0, 8), enabled });
    this.syncPublisher();
    return { ok: true, pool: this.poolSnapshot() };
  }

  /** 删一个池成员。只删池里的，不动 `token.json`。 */
  private async actionPoolRemove(body: Record<string, unknown>): Promise<ActionResult> {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    if (id.length === 0) return { ok: false, error: "缺少 id 参数" };
    // 先并表再过滤：如果内存比磁盘旧，直接过滤内存那份再整表写，
    // 会把磁盘上**别的**账号一起抹掉（同 addPoolAccount 的理由）。
    // 注意这里**不能**用 `savePool()` —— 它会把磁盘并回来，删掉的号又活了。
    const disk = await readPool().catch(() => [] as PoolAccount[]);
    const merged = mergePools(this.accounts, disk);
    const next = merged.filter((a) => a.id !== id);
    if (next.length === merged.length) {
      // 内存里没有、磁盘上也没有 —— 可能是别人已经删过了。
      this.accounts = merged;
      return { ok: false, error: "没有这个账号", pool: this.poolSnapshot() };
    }
    this.accounts = next;
    this.poolQuota.delete(id);
    await writePool(this.accounts).catch((error: unknown) => {
      this.logger.error("pool/write-failed", { message: messageOf(error) });
    });
    this.logger.info("pool/remove", { id: id.slice(0, 8), total: this.accounts.length });
    this.syncPublisher();
    return { ok: true, pool: this.poolSnapshot() };
  }

  /**
   * 一键签到：所有池成员（**含未启用的**）。
   *
   * 为什么含未启用的：签到是"把这个号今天该拿的拿到"，与"要不要拿它去服务"
   * 是两件事。用户把号加进池就是想管它。
   *
   * 三条纪律（照 workbuddy 的教训）：
   * 1. **先查后写**：`granted:false` 幂等是上游行为不是契约，能不打就不打。
   * 2. **单个失败不中断整批**：一个号挂了不能让后面的号签不到。
   * 3. **与 `poolEnabled` 无关**：关掉自动换号不等于不让签到。
   */
  private async actionPoolCheckin(): Promise<ActionResult> {
    if (this.accounts.length === 0) {
      return { ok: false, error: "池里还没有账号。", pool: this.poolSnapshot(), results: [] };
    }
    const results: Array<{ id: string; result: "already" | "granted" | "error"; message?: string }> = [];
    let touched = false;
    // 这一轮要不要把测量结果落盘。签到是**用户主动**发起的、每天一次的动作，
    // 它拿到的失败信号比对话中途的 `onResponse` 更可信（后者可能是上游抖动）：
    // 一个号的凭据真的废了，用户点完签到就该在卡片上看到「凭据失效」，
    // 而不是继续显示上次的「可用」并继续被选去服务。
    let measured = false;
    for (const account of this.accounts) {
      const id = account.id;
      try {
        let already = false;
        try {
          const bills = await fetchBills(account.token, this.fetchImpl, 20);
          already = todayGranted(bills, new Date(this.now())) !== undefined;
        } catch {
          // 流水拿不到不算"已签"，继续走写接口 —— 宁可多打一次也别漏签。
          already = false;
        }
        if (already) {
          results.push({ id, result: "already" });
          continue;
        }
        const grant = await grantDaily(account.token, this.fetchImpl);
        touched = true;
        results.push({ id, result: grant.granted ? "granted" : "already" });
        // 领到了就刷新这个号的余额读数，下次选号排序用得上。
        const balance = await fetchBalance(account.token, this.fetchImpl).catch(() => undefined);
        if (balance !== undefined) {
          this.poolQuota.set(id, {
            ...(balance.available === undefined ? {} : { available: balance.available }),
            ...(balance.daily === undefined ? {} : { daily: balance.daily }),
            ...(balance.permanent === undefined ? {} : { permanent: balance.permanent }),
            at: this.now(),
          });
        }
      } catch (error) {
        const text = messageOf(error);
        results.push({ id, result: "error", message: text });
        // 把失败翻译成测量状态。`classifyMeasure()` 只认「与账号有关」的失败：
        // 网络抖动 → `flaky`（30 分钟后自动回池）、凭据失效 → `dead`（要靠
        // 手动「测试」或重新登录才能回池）、余额不足 → `empty`（到北京零点）。
        // HTTP 400 之类与账号无关的会返回 `undefined`，那种情况不改状态。
        // `MeasureInput.kind` 只收与账号有关的几种（见 `pool.ts` 的
        // `MeasureInput`）。`INVALID_REQUEST` / `ABORTED` 说的是"这次请求本身
        // 不成立"，与这个号能不能用无关 —— 归到 `undefined`，只留 status 参与判断。
        const kind = error instanceof RaccoonError ? ACCOUNT_KINDS[error.kind] : undefined;
        const measure = classifyMeasure({
          ...(kind === undefined ? {} : { kind }),
          status: error instanceof RaccoonError && error.status !== undefined ? error.status : 0,
          bodyText: text,
          now: this.now(),
        });
        if (measure !== undefined && shouldPersistMeasure(account.measure, measure)) {
          this.accounts = this.accounts.map((a) => (a.id === id ? { ...a, measure } : a));
          measured = true;
        }
      }
    }
    this.logger.info("pool/checkin", {
      total: results.length,
      granted: results.filter((r) => r.result === "granted").length,
      already: results.filter((r) => r.result === "already").length,
      failed: results.filter((r) => r.result === "error").length,
    });
    if (measured) {
      // 合并后写盘：签到是低频动作，多读一次盘换来"不抹掉别的号"是划算的
      // （与 `actionPoolTest()` 同一理由）。写失败不影响结果展示。
      await this.savePool().catch(() => undefined);
    }
    if (touched || measured) {
      // 当前账号的余额也可能被这轮改到了（如果它就是池成员）。
      this.quotaCache.clear();
      void this.refreshQuota({ force: false }).catch(() => undefined);
      // 有号被判死/冷却 → 当前选中的那个可能已经不能用了，必须让名册重建。
      this.syncPublisher();
    }
    return { ok: true, pool: this.poolSnapshot(), results };
  }

  /**
   * 测一个池成员还活着没。
   *
   * **打 `model_catalog` 而不是发真对话**：目录端点要鉴权、要限流、要过设备头，
   * 已经足够判定"这个号还能不能用"，成本却是 0 token。workbuddy 用 25k 输入的
   * 真实探测，是因为它没有这种"零成本但同样需要鉴权"的端点可用。
   */
  private async actionPoolTest(body: Record<string, unknown>): Promise<ActionResult> {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    const account = id.length === 0 ? undefined : this.accounts.find((a) => a.id === id);
    if (account === undefined) return { ok: false, error: "没有这个账号", pool: this.poolSnapshot() };

    let status = 0;
    let ok = false;
    let message: string | undefined;
    try {
      const groups = await fetchCatalog(account.token, this.fetchImpl, { deviceId: account.deviceId });
      ok = groups.length > 0;
      status = 200;
      if (!ok) message = "目录是空的";
    } catch (error) {
      message = messageOf(error);
      status =
        error instanceof RaccoonError && error.status !== undefined
          ? error.status
          : error instanceof RaccoonError && error.kind === "AUTH"
            ? 401
            : 0;
    }

    const measure = classifyMeasure({ status, ...(message === undefined ? {} : { bodyText: message }), now: this.now() });
    this.accounts = this.accounts.map((a) => (a.id === id ? { ...a, ...(measure === undefined ? {} : { measure }) } : a));
    // 手动点「测试」是一次用户动作，多一次读盘换"不抹掉别的账号"是划算的。
    await this.savePool().catch(() => undefined);
    this.logger.info("pool/test", {
      id: id.slice(0, 8),
      ok,
      status,
      state: measure?.state ?? "-",
    });
    if (measure?.state === "ok" || measure?.state === "limited") {
      // 手动测试是唯一能让 `dead` 回池的路径（ADR-0010 §5）。
      const balance = await fetchBalance(account.token, this.fetchImpl).catch(() => undefined);
      if (balance !== undefined) {
        this.poolQuota.set(id, {
          ...(balance.available === undefined ? {} : { available: balance.available }),
          ...(balance.daily === undefined ? {} : { daily: balance.daily }),
          ...(balance.permanent === undefined ? {} : { permanent: balance.permanent }),
          at: this.now(),
        });
      }
    }
    this.syncPublisher();
    return {
      ok: true,
      tested: id,
      healthy: ok,
      ...(message === undefined ? {} : { message }),
      pool: this.poolSnapshot(),
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
    const models = this.catalog.models.length > 0 ? this.catalog.models : fallbackAsModels();
    const deviceId = this.activeDeviceId();
    // **名册每次重建**，不复用 `catalog.descriptors`：设备身份是名册级属性
    // （`profileOptions()` 不透传请求头，见 adapter.ts 的注释），换号就必须换
    // 一份带新 `x-client-device-id` 的 descriptor，否则请求还带着上一个号的身份。
    const descriptors = toDescriptors(models, {
      contextCap: settings.contextCap,
      visionProbe: this.probes,
      sessionIdFor: (modelId) => this.sessionIdForPublish(modelId),
      ...(deviceId === undefined ? {} : { deviceId }),
    });
    const resolve = async (): Promise<string | undefined> => this.activeToken();
    const input = {
      enabled: settings.enabled,
      reasoningEnabled: settings.reasoning,
      models: descriptors,
      token: this.activeToken(),
      ...(deviceId === undefined ? {} : { deviceId }),
    };
    if (deviceId === undefined) {
      // 单账号路径：不传 account，行为与 ADR-0008 时期完全一致。
      this.publisher.sync(input, resolve);
      return;
    }
    const account: PublishAccountResolver = {
      resolve: async () => {
        const pooled = this.resolvePoolAccount();
        return pooled === undefined ? undefined : { token: pooled.token, deviceId: pooled.deviceId };
      },
      onResponse: (status: number) => {
        this.recordMeasure(status);
      },
    };
    this.publisher.sync(input, resolve, account);
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
    // 号池里每个号必须有**自己的** session id：它按 principal 定型，换了号
    // 还用上一个号的会话 id，网关那边看到的是"同一个会话换了个人在说话"。
    const pooled = this.resolvePoolAccount();
    const principal = pooled?.principal ?? this.token?.principal ?? "anonymous";
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
