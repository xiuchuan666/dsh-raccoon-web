/**
 * 插件设置。
 *
 * 走内核的 `settings.register(ns, schema)`（`@deepseek-ai/dsh-settings`），
 * 持久化到 `$DSH_HOME/profiles/<profile>/settings-legacy.yaml` 的
 * `dsh-raccoon-web:` 段下。用户在设置页改的开关重启后还在，不需要自己的
 * 状态文件。
 *
 * ## 为什么 `schema` 是一个手写函数
 *
 * `settings.register()` 把 `schema` 当**普通函数**调用
 * （`dsh-settings/lib/index.js:371-391`：`plainConfig(schema(mergeLayers(base, user)))`），
 * 它接受的不是 JSON Schema。参考插件用 `@deepseek-ai/schemastery` 的
 * `Schema.object({...})` 来造这个函数，但 schemastery 是宿主依赖、不在我们的
 * `dependencies` 里，引它等于把插件绑死在宿主内部的某个包上。
 *
 * 这里写一个 30 行的归一化函数就够：五个字段、全部有默认值、非法值回落默认。
 * `validate` 也留空 —— `register` 的 `options.validate` 抛错会让整个注册失败，
 * 而设置项填错不该让插件加载不起来。
 *
 * @module host/settings
 */

/** 设置命名空间。必须匹配 `/^[a-z][a-z0-9-]*$/`（dsh-settings 的硬校验）。 */
export const SETTINGS_NS = "dsh-raccoon-web";

/** 设置形状。 */
export interface RaccoonSettings {
  /** 是否在模型选择器里注册本 provider。关掉 = 完全不出现。 */
  enabled: boolean;
  /** 是否允许思考。关掉后每个请求都带 `thinking.type=disabled`。 */
  reasoning: boolean;
  /** 是否用实测结论覆盖目录的 vision 标签（ADR-0006）。 */
  visionProbeOverride: boolean;
  /** 上下文上限。默认 128k，比目录给的 1M 小很多 —— 见下面注释。 */
  contextCap: number;
  /** 打 debug 日志。默认关。 */
  debugLog: boolean;
  /**
   * token 从哪来。
   *
   * - `auto`（默认）：先试官方桌面客户端的 `auth.json`，没有再回落到本插件
   *   扫码得到的 token。绝大多数用户应该用这个 —— 装了官方客户端就已登录，
   *   不用再扫一次。
   * - `desktop`：只用桌面端凭据。适合"公司统一装了客户端"的场景，
   *   也是最接近 workbuddy 那种"直接接本地登录态"的行为。
   * - `qr`：只用本插件扫码。适合没装官方客户端、或者不想让插件读
   *   那个文件的人。
   *
   * 见 docs/02-design/adr/0008-desktop-credential-reuse.md。
   */
  authSource: AuthSource;
  /**
   * 扫码用哪一套协议。
   *
   * - `web`（默认）：官方桌面端当前用的 Web auth 码 —— code 本地生成、
   *   appname 写「小浣熊官网」、打 `/api/web/auth/v1/login_with_qrcode_code`。
   *   少一个取码请求，也少一个失败模式。
   * - `iam`：微信小程序码 —— `/api/iam/v1/auth/mp/qrcode` 取码、
   *   appname 写「商汤小浣熊」、打 `/api/iam/v1/auth/mp/qrcode/login`。
   *   只有这一种码能被微信里的小程序识别。
   *
   * 两套是**不同命名空间**，code 互相喂会失败（E-030）。见 `protocol/web-auth.ts` 的表。
   */
  qrProtocol: QrProtocol;
}

/** 扫码协议。 */
export type QrProtocol = "web" | "iam";

/** token 来源策略。 */
export type AuthSource = "auto" | "desktop" | "qr";

/** 默认值。**每个字段都要有**，否则 `mergeLayers` 之后可能是 `undefined`。 */
export const DEFAULT_SETTINGS: RaccoonSettings = {
  enabled: true,
  reasoning: true,
  visionProbeOverride: false,
  /**
   * 128000 而不是目录给的 1000000。
   *
   * 浣熊的限流是按**账号的 token 速率**算的，不是按每分钟请求数。
   * 一轮对话带的上下文越大越快撞到，撞到之后额度按吞吐缓慢回血、上游也不给
   * 恢复时间。所以默认把窗口压到 128k：这是主动降级换"能用"，
   * 想要 1M 的用户可以自己在设置里改回去（见 docs/03-plan/04-risks.md R6）。
   */
  contextCap: 128_000,
  debugLog: false,
  /**
   * 默认 `auto`。
   *
   * 理由：官方桌面客户端装在 `C:\Program Files\@raccoonoffice-desktop\`，
   * 它的登录态在 `~/.office-raccoon/agent/config/auth.json`（实测 2026-11-06，
   * E-030）。用户装过、登录过，就该直接用，不必再扫一次码。
   * 没装的人 `auto` 会安静地回落到扫码路线，不会有额外摩擦。
   */
  authSource: "auto",
  /**
   * 默认 `web`。
   *
   * 官方桌面端就是这条路（`createAccountQrHost` 里 `appname='小浣熊官网'`），
   * 而且它不需要先向服务端申请一个 code —— 少一次网络往返就是少一个
   * "取码失败，请重试"的现场。IAM 码的唯一优势是能在微信小程序里识别，
   * 而这条路的用户是用微信扫的，两种都能扫出来（页面是同一个 `/login/mp`）。
   */
  qrProtocol: "web",
};

const AUTH_SOURCES: readonly AuthSource[] = ["auto", "desktop", "qr"];
const QR_PROTOCOLS: readonly QrProtocol[] = ["web", "iam"];

/** contextCap 的合法区间。 */
const CONTEXT_CAP_MIN = 8_192;
const CONTEXT_CAP_MAX = 2_000_000;

/**
 * 归一化。**永不抛** —— 任何非法输入都退回落默认值。
 *
 * 这就是传给 `settings.register()` 的 `schema`。它必须容忍 `{}`（首次运行
 * 时 yaml 里没有这一段）、容忍多出来的字段（用户手改了 yaml）、
 * 容忍字符串形式的布尔与数字（yaml 会把 `128000` 读成数字，但 `"128000"`
 * 也不是不可能 —— 用户手编时就会写引号）。
 */
export function normalizeSettings(input: unknown): RaccoonSettings {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  const bool = (value: unknown, fallback: boolean): boolean => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  };

  const num = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < CONTEXT_CAP_MIN || parsed > CONTEXT_CAP_MAX) return fallback;
    return Math.floor(parsed);
  };

  const authSource = (value: unknown): AuthSource => {
    if (typeof value !== "string") return DEFAULT_SETTINGS.authSource;
    const lowered = value.trim().toLowerCase();
    return (AUTH_SOURCES as readonly string[]).includes(lowered) ? (lowered as AuthSource) : DEFAULT_SETTINGS.authSource;
  };

  const qrProtocol = (value: unknown): QrProtocol => {
    if (typeof value !== "string") return DEFAULT_SETTINGS.qrProtocol;
    const lowered = value.trim().toLowerCase();
    return (QR_PROTOCOLS as readonly string[]).includes(lowered) ? (lowered as QrProtocol) : DEFAULT_SETTINGS.qrProtocol;
  };

  return {
    enabled: bool(raw["enabled"], DEFAULT_SETTINGS.enabled),
    reasoning: bool(raw["reasoning"], DEFAULT_SETTINGS.reasoning),
    visionProbeOverride: bool(raw["visionProbeOverride"], DEFAULT_SETTINGS.visionProbeOverride),
    contextCap: num(raw["contextCap"], DEFAULT_SETTINGS.contextCap),
    debugLog: bool(raw["debugLog"], DEFAULT_SETTINGS.debugLog),
    authSource: authSource(raw["authSource"]),
    qrProtocol: qrProtocol(raw["qrProtocol"]),
  };
}

/**
 * 设置句柄。形状与 `settings.register()` 的返回值一致，但 `watch` 的回调
 * 参数已经归一化过（内核给的是 `plainConfig` 之后的原始对象）。
 */
export interface SettingsHandle {
  get(): RaccoonSettings;
  watch(callback: (next: RaccoonSettings, prev: RaccoonSettings) => void): () => void;
  update(patch: Partial<RaccoonSettings>): Promise<void>;
  replace(section: RaccoonSettings): Promise<void>;
}

/** 内核的 settings 服务只用到这三个方法。 */
export interface RawSettingsService {
  register(
    ns: string,
    schema: (input: unknown) => unknown,
    options?: { base?: unknown; applies?: "live" | "restart"; validate?: (value: unknown) => void },
  ): {
    get(): unknown;
    watch(cb: (next: unknown, prev: unknown) => void): () => void;
    update(patch: unknown): Promise<void>;
    replace(section: unknown): Promise<void>;
  };
}

/**
 * 注册并包一层归一化。
 *
 * 注意 `get()` 每次都从内核的 `resolved` 读 —— 内核在 `update()` 之后会换掉
 * 那个对象，所以**不要**在这里缓存成闭包变量，否则设置页改完开关，
 * 正在跑的请求还用旧值。
 */
export function registerSettings(settings: RawSettingsService): SettingsHandle {
  const raw = settings.register(SETTINGS_NS, normalizeSettings, { applies: "live" });
  return {
    get: () => normalizeSettings(raw.get()),
    watch: (callback) =>
      raw.watch((next, prev) => {
        callback(normalizeSettings(next), normalizeSettings(prev));
      }),
    update: (patch) => raw.update(patch),
    replace: (section) => raw.replace(section),
  };
}
