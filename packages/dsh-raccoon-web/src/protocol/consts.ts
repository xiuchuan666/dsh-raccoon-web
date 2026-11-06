/**
 * 网关常量。**这是唯一允许出现 URL / 超时 / 版本号的地方。**
 *
 * 所有值都有实测来源，见 docs/01-research/05-empirical-findings.md。
 * 改这里的任何一个值，都要先跑 `node scripts/probe-gateway.mjs`。
 *
 * @module protocol/consts
 */

/** 网关根。E-001 实测可达。 */
export const ORIGIN = "https://xiaohuanxiong.com";

/** IAM（登录）前缀。E-001 / E-002 实测。 */
export const IAM_BASE = `${ORIGIN}/api/iam/v1`;

/** 业务前缀。E-004 实测 401 code=200001。 */
export const WEB_BASE = `${ORIGIN}/api/web`;

/** 模型目录 + 对话。 */
export const LLM_BASE = `${WEB_BASE}/llm/v2`;

/** 积分（v1 余额 / v2 流水）。 */
export const POINTS_BASE = `${WEB_BASE}/points`;

/**
 * 客户端版本号。
 *
 * 上游是否校验它未实测（Q7）。但官方客户端就是带这个值，
 * 复刻它比不带更安全 —— 不带等于告诉网关"我不是客户端"。
 */
export const CLIENT_VERSION = "v1.0.35";

/** 二维码里 appname 参数的值。原样中文，上游会做 URL 编码。 */
export const QR_APP_NAME = "商汤小浣熊";

/** 每日积分说明页。只用于给用户一个"去这儿看"的链接，不代领。 */
export const CHECKIN_URL = `${ORIGIN}/work/home`;

/** IAM 请求超时。取二维码 / 轮询都用它。 */
export const IAM_TIMEOUT_MS = 20_000;

/** 目录请求超时。比 IAM 短，因为它只是读。 */
export const CATALOG_TIMEOUT_MS = 15_000;

/** 非流式请求（积分）超时。 */
export const POINTS_TIMEOUT_MS = 10_000;

/**
 * 首字节超时。
 *
 * `dsh-raccoon-connect@0.2.4` 加这个是因为实测"高峰有 60s+ 无响应"，
 * 不加的话用户看到十分钟空转。60s 是它的默认值，我们沿用。
 */
export const FIRST_BYTE_TIMEOUT_MS = 60_000;

/** 流中两帧之间允许的最大间隔。超过就是断了。 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** 目录缓存。5 分钟 —— 目录变化不频繁，但用户换账号后要能较快反应过来。 */
export const CATALOG_TTL_MS = 5 * 60_000;

/** 积分缓存。60 秒 —— 药丸 20s 轮询，缓存挡住重复请求。 */
export const QUOTA_TTL_MS = 60_000;

/** 登录轮询的兜底间隔（上游会返回 poll_interval，以它为准）。 */
export const QR_POLL_INTERVAL_MS = 2_000;

/** 单次登录流程的总时限。上游给 expires_in=300，留 30s 余量。 */
export const LOGIN_TIMEOUT_MS = 330_000;

/**
 * 单请求图片像素预算。
 *
 * 网关单请求体上限约 10MB（超了 HTTP 413）。sensenova 用 640 000，
 * 这个数字是它实测调出来的，沿用。
 */
export const IMAGE_PIXEL_BUDGET = 640_000;

/**
 * provider id。
 *
 * **不能**与 `sensenova-raccoon`（sensenova 插件）或 `llm-raccoon`
 * （dsh-raccoon-connect）重复 —— 宿主 `registerAdapter` 会抛 DUPLICATE_ADAPTER。
 */
export const PROVIDER_ID = "raccoon-web";

/** provider 显示名。出现在模型选择器的分组标题上。 */
export const DISPLAY_NAME = "小浣熊";

/** pi-ai Api id。自定义 Api 的标识，不要与 `openai-completions` 撞。 */
export const API_ID = "raccoon-chat";

/** cordis 节点 id（cordis.patch.yml 里的 `id:`），不要与 PROVIDER_ID 混淆。 */
export const CORDIS_ID = "llm-raccoon-web";

/** 磁盘数据目录名（在 profile.home 下）。 */
export const DATA_DIR = "raccoon-web";

/** 默认上下文上限。见 docs/02-design/03-state-and-storage.md §5。 */
export const DEFAULT_CONTEXT_CAP = 128_000;
