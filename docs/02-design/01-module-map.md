# 模块地图

最后更新: 2026-11-06（按实现回填，行数为当时实测）
状态: 已定稿

> 一句话：**`protocol/` 不知道 DSH 存在，`provider/` 不知道状态存哪，`host/` 什么都知道。行数超 500 就先想拆不拆。**

---

## 1. 实测行数（2026-11-06）

```
packages/dsh-raccoon-web/
├── src/                                    5862 行
│   ├── build.ts                              23
│   ├── index.ts                             125   插件入口
│   ├── types/
│   │   └── dsh.d.ts                         148   内核类型桩（内核没有 .d.ts）
│   ├── protocol/                           2550
│   │   ├── consts.ts                        100
│   │   ├── errors.ts                        143
│   │   ├── headers.ts                       106
│   │   ├── qr.ts                            484   ← 最大单文件
│   │   ├── iam.ts                           323
│   │   ├── web-auth.ts                      178
│   │   ├── desktop-auth.ts                  203
│   │   ├── catalog.ts                       323
│   │   ├── chat.ts                         470
│   │   └── points.ts                        170
│   ├── provider/                            593
│   │   ├── api.ts                           104
│   │   ├── roster.ts                        163
│   │   ├── adapter.ts                       258
│   │   └── fallback-roster.ts                68
│   └── host/                               2198
│       ├── index.ts                        742   ← 最大单文件
│       ├── routes.ts                        237
│       ├── login-flow.ts                    386
│       ├── publish.ts                       222
│       ├── store.ts                         223
│       ├── settings.ts                      207
│       ├── status.ts                        149
│       ├── cache.ts                          75
│       ├── log.ts                           106
│       └── solid-png.ts                     126
├── client.js                               1127   手写 classic script
└── test/                                   2042
    ├── helpers.ts                           170
    ├── qr.test.ts                           166
    ├── iam.test.ts                          297
    ├── web-auth.test.ts                     198
    ├── catalog.test.ts                      246
    ├── chat.test.ts                          324
    ├── host.test.ts                         416
    └── stubs/{dsh-llm,dsh-llm-pi-ai,pi-ai}.ts  68/40/117
```

---

## 2. `protocol/` —— 只认 HTTP 与字节序

**白名单**：`node:*`、相对路径。**黑名单**：任何 `@deepseek-ai/*`、`@earendil-works/*`。

### consts.ts（100 行）

唯一允许出现 URL / 超时 / 版本号的地方。

```ts
export const ORIGIN = "https://xiaohuanxiong.com";
export const IAM_BASE = `${ORIGIN}/api/iam/v1`;
export const WEB_BASE = `${ORIGIN}/api/web`;
export const LLM_BASE  = `${WEB_BASE}/llm/v2`;
export const POINTS_BASE = `${WEB_BASE}/points`;
export const CLIENT_VERSION = "v1.0.35";
export const QR_APP_NAME = "商汤小浣熊";        // 协议 A
export const CHECKIN_URL = `${ORIGIN}/work/home`;
export const IAM_TIMEOUT_MS = 20_000;
export const CATALOG_TIMEOUT_MS = 15_000;
export const POINTS_TIMEOUT_MS = 10_000;
export const FIRST_BYTE_TIMEOUT_MS = 60_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const CATALOG_TTL_MS = 5 * 60_000;
export const QUOTA_TTL_MS = 60_000;
export const QR_POLL_INTERVAL_MS = 2_000;
export const LOGIN_TIMEOUT_MS = 330_000;
export const IMAGE_PIXEL_BUDGET = 640_000;
export const PROVIDER_ID = "raccoon-web";
export const DISPLAY_NAME = "小浣熊";
export const API_ID = "raccoon-chat";
export const CORDIS_ID = "llm-raccoon-web";
export const DATA_DIR = "raccoon-web";
export const DEFAULT_CONTEXT_CAP = 128_000;
```

**为什么 `PROVIDER_ID` 是 `raccoon-web`**：不能与已有的 `sensenova-raccoon`（sensenova 插件）或 `llm-raccoon`（dsh-raccoon-connect）撞，否则 `registerAdapter` 抛 `DUPLICATE_ADAPTER`。

**为什么 `CORDIS_ID` 与 `PROVIDER_ID` 不同**：前者是 cordis 树节点 id，后者是 LLM provider 名。用户改 `cordis.patch.yml` 时看到的是前者。

### errors.ts（143 行）

```ts
export type RaccoonErrorKind =
  | "AUTH" | "RATE_LIMIT" | "SERVER"
  | "TIMEOUT" | "TRANSPORT" | "INVALID_REQUEST" | "ABORTED";

export class RaccoonError extends Error {
  readonly kind: RaccoonErrorKind;
  readonly status?: number;
  readonly upstream?: string;
  readonly hint: string;
  get userText(): string;   // message + hint + 上游原文（截 240 字）；ABORTED 返回 ""
}

export const RETRYABLE_KINDS = new Set(["SERVER", "TIMEOUT", "TRANSPORT"]);
export const DEAD_SESSION_CODES = new Set([200001, 200003]);
export const RATE_LIMIT_CODES = new Set([429, 200429]);   // ← 200429 是 HTTP 200 里出现的
export const RATE_LIMIT_WORDS = ["user_model_rate_limited", "rate_limit", "频率超限", "too many requests"];
export function isDeadSessionCode(code: unknown): boolean;
export function isRateLimited(status: number | undefined, text: string): boolean;
export function isRateLimitCode(code: unknown): boolean;
export function truncate(text: string, max: number): string;   // 只用于日志与 upstream
export function toRaccoonError(err: unknown, fallback?: RaccoonErrorKind): RaccoonError;
```

**`truncate()` 绝不能用在解析路径上** —— dsh-raccoon-connect 就是栽在"把响应体截到 4096 字符"（`textOf()` 那个 bug），症状是新模型永远显示不出来。

**`RATE_LIMIT_CODES` 里必须有 200429**：上游限流有时是 `HTTP 200 + {"code":200429,"message":"user_model_rate_limited"}`，只看 `status === 429` 会让用户看到"模型突然不说话"。

### headers.ts（106 行）

```ts
export function clientPlatform(): "desktop-windows" | "desktop-macos" | "desktop-linux";
export function iamHeaders(): Record<string, string>;
export function webHeaders(token: string, language?: string): Record<string, string>;
export function chatHeaders(token: string, sessionId: string, language?: string): Record<string, string>;
export function confirmHeaders(token: string): Record<string, string>;
export function chatModelHeaders(sessionId: string, language?: string): Record<string, string>;  // 不含 authorization
```

`chatModelHeaders()` 是**烘进 `model.headers` 的那份**（因为 `x-raccoon-session-id` 是按模型定型的），故意不含 `authorization` —— token 走 pi-ai 的 apiKey 通路，`PiAiAdapter.requestHeaders()` 会剔除同名冲突（E-022）。

> 注：官方 asar 里 `x-raccoon-language` / `x-client-version` / `x-client-platform` **零命中**（E-034），带上是多余特征。但实测带上也不影响，暂时保留。

### qr.ts（484 行）

自实现 QR 编码器（[ADR-0002](./adr/0002-self-contained-qr-encoder.md)）。**只实现 byte 模式 + 纠错 M + 版本 1–10**。

```ts
export interface QrMatrix { size: number; modules: Uint8Array }
export const MAX_VERSION = 10;                    // 213 字节上限
export function pickVersion(byteLength: number): number;   // 超 213 抛错
export function encodeQr(text: string): QrMatrix;
export function renderQrSvg(text: string, opts?: QrSvgOptions): string;
```

内部易错点（每条都有对应单测）：

| 位置 | 坑 |
| --- | --- |
| `pickVersion` | 149 字节 → **版本 8**（v7 只有 122），139 字节也 → **版本 8** |
| `drawVersionBits` | 版本 ≥7 必须在**两处**写 18 bit（BCH(18,6) `0x1F25`），漏了手机扫不出 |
| `addEccAndInterleave` | 版本 ≥5 分块交错，短块要占位跳过 |
| `drawAlignment` | 版本 ≥2 才画，且要跳过与定位图案重叠的三个角 |
| `applyMask` | 8 种掩码按 penalty 选最优（N1=3 / N2=3 / N3=40 含两种 finder-like 模式 / N4=10） |
| `drawFormatBits` | 写两处，M 级 formatBits 是 `0b00`，`^ 21522` |

真解码验证见 `scripts/verify-qr.mjs`：**必须同时用 `cv2.QRCodeDetector` 与 `cv2.QRCodeDetectorAruco`**，只用前者会把真宿主下发的 57×57 符号判成"解不出来"（E-024）。

### iam.ts（323 行，协议 A）

```ts
export interface QrSession { code, scanPath, expiresIn, pollInterval }
export interface QrPoll { status: "pending"|"logging"|"success"|"canceled"|"expired"|"error"; accessToken?, ... }

export function createQr(fetchImpl?: typeof fetch): Promise<QrSession>;     // 服务端下发 code
export function qrContent(session: QrSession): string;                      // appname=商汤小浣熊
export function pollQr(code: string, fetchImpl?: typeof fetch): Promise<QrPoll>;
export function assertScanPath(scanPath: string): string;                    // 防 SSRF / 防协议降级
export function cookieValue(setCookies: string[], matches: (n: string) => boolean): string | undefined;
export function confirmSession(accessToken: string, fetchImpl?): Promise<string | undefined>;   // 永不抛
export function validateToken(token: string, fetchImpl?): Promise<boolean>;
```

三条铁律：

1. **`pollQr` 遇网络错误 / 非 JSON 200 / `TIMEOUT` 一律返回 `pending`**，不抛。网络抖动不能杀掉一次登录。
2. **`confirmSession` 失败不致命** —— 拿不到 `xhx_token` 就继续用 `access_token`，以 `model_catalog` 探测为准。
3. **`validateToken` 要求 `data.categories` 是数组** —— 光 `response.ok` 不够（上游可能回 200 带错误码）。

### web-auth.ts（178 行，协议 B）

```ts
export const WEB_QR_APP_NAME = "小浣熊官网";      // ← 不是「商汤小浣熊」
export const WEB_QR_PATH = "/login/mp";
export interface WebQrSession { code, expiresIn, pollInterval }

export function generateWebCode(now?: number): string;   // `${now}${randomBytes(16).hex}` = 45 字符
export function createWebSession(now?, expiresIn?, pollInterval?): WebQrSession;   // 不发网络请求
export function webQrContent(session, origin?): string;
export function isWebCode(value: unknown): boolean;      // /^\d{13}[a-f0-9]{32}$/
export function pollWebSession(code, fetchImpl?): Promise<WebQrPoll>;
```

**这个端点对任何合法 code 都回 `pending`**（无状态），所以不能靠它判断 code 有效。这也是为什么 `qrProtocol` 是**用户显式选择**而不是自动探测（ADR-0009）。

码用 `randomBytes` 生成而不是 `Math.random` —— 它等同一次性口令。

### desktop-auth.ts（203 行）

只读官方客户端的 `auth.json`。

```ts
export interface DesktopAuth {
  token: string;
  kind: "access_token";
  expiresAt?: number;
  principal?: string;
  officeIdentity?: string;
  source: string;          // 命中的候选路径（给诊断用）
}

export function authCandidates(home?: string): { path: string; why: string }[];
export function readDesktopAuth(opts?: {
  home?: string; candidates?: ...; readFileImpl?: (p: string) => Promise<string>; now?: number;
}): Promise<DesktopAuth | undefined>;      // 永不抛
export function desktopAuthExpired(auth: DesktopAuth, now?: number): boolean;   // 留 60s 余量
```

候选顺序（六个）：

1. `$BOX_AGENT_CONFIG_DIR/auth.json`
2. `$BOX_AGENT_HOME/config/auth.json`
3. `~/.office-raccoon/agent/config/auth.json`   ← **Windows 上实际命中的就是这个**
4. `~/office-raccoon/agent/config/auth.json`
5. `~/.office-raccoon/config/auth.json`
6. `~/.box-agent/config/auth.json`

**边界**：只读、不上传、读不到就明说。不扫全盘、不读浏览器 cookie、不碰凭据管理器、不 attach 内存。

### catalog.ts（323 行）

```ts
export interface RaccoonModel {
  id, name, vision: boolean, visible?: boolean,
  multiplier?: number, contextWindow?: number, maxOutput?: number, raw: unknown
}
export interface CatalogOptions { includeHidden?: boolean }
export function parseCatalog(payload: unknown, options?: CatalogOptions): CatalogGroup[];
export function normalizeModel(raw: unknown, groupKey: string): RaccoonModel | undefined;
export function fetchCatalog(token, fetchImpl?, options?): Promise<CatalogGroup[]>;
export function flattenCatalog(groups): RaccoonModel[];
```

真实形状（E-032）与对应处理：

| 上游字段 | 处理 |
| --- | --- |
| `categories[].type` | groupKey（**没有 `key`/`name`**） |
| `models[].name` / `model_name` | id（两者都是 id） |
| `models[].description` | **显示名**（`"Kimi-K3"`） |
| `models[].display_description` | 长描述，不是名字 |
| `params.context_window` / `params.max_tokens` | **嵌套** → `pickNumberDeep()` 先读顶层再读 `params`/`config`/`limits`/`meta`/`spec` |
| `billing_effective_multiplier` / `billing_multiplier` | 倍率（不是 `multiplier`） |
| `tags[]` 含 `vision` | 识图能力 |
| `visible: false` | 默认过滤 |

**响应体绝不截断**（CAT-3 单测：200 个模型 > 4096 字符，最后一个必须完整）。

### chat.ts（470 行）

```ts
export interface RaccoonFrame {
  text?, reasoning?,
  toolCall?: { index, id?, name?, argumentsDelta? },
  usage?: { input, output, total },
  finishReason?, error?: { message, code?, rateLimited }
}

export function applyThinking(body: Record<string, unknown>, effort: string | undefined): void;
export function buildBody(request: ChatRequest): Record<string, unknown>;
export function sessionIdFor(principal: string, model: string): string;
export function jwtClaims(token: string): Record<string, unknown> | undefined;   // 不验签
export function principalOf(token: string): string;
export function parseFrame(line: string): RaccoonFrame | null;   // 不认识返回 null，绝不抛
export function chatStream(token, body, onFrame, options?): Promise<void>;
```

**`applyThinking` 的实测结论**（E-035）：

| effort | 发出的字段 | 实测效果 |
| --- | --- | --- |
| `"off"` | `extra_body: {thinking:{type:"disabled"}}` | reasoning 260 → 81 字符，正文出来了 |
| `"none"` | 上面 + `reasoning_effort:"none"` | reasoning 82 字符 |
| `"on"` / 其它 | `extra_body: {thinking:{type:"enabled"}}`（`"on"` 不发字面量） | 正常思考 |
| `undefined` | 同 `"on"` | — |

**注意：关了也还有少量 `reasoning_content`**。UI 不能拿"有没有 reasoning"当开关生效的判据。

**`parseFrame` 的三条**：

1. 不认识的帧 / 非法 JSON / `42` / `null` → 返回 `null`，**不抛**（上游可能加新帧类型）
2. `[DONE]` → `{ finishReason: "stop" }`
3. 三种错误形状都要认：顶层 `error`、顶层 `code !== 0`、`choices[0].delta.error`（第三种的 `rateLimited` 用 `isRateLimitCode()` 判）

**`sessionIdFor(principal, model)`** = `sess-0-<sha256(principal + "\0" + model).hex.slice(0,8)>`。只在 chat 请求带 `x-raccoon-session-id`。理由：官方客户端 26 分钟 125 次调用都用同一个会话 id，每次新建会让网关看到"一个账号几分钟开了几百个会话"。

### points.ts（170 行）

```ts
export interface RaccoonBalance { available?, permanent?, daily?, raw }
export interface RaccoonBill { bizType, amount?, at?, raw }

export function fetchBalance(token, fetchImpl?): Promise<RaccoonBalance>;
export function fetchBills(token, fetchImpl?, limit?): Promise<RaccoonBill[]>;
export function raccoonDay(input: string | number | Date): string;   // Asia/Shanghai
export function todayGranted(bills: RaccoonBill[], now?: number): boolean;
```

余额字段候选顺序：`available_points` → `availablePoints` → `total_chargeable_points` → `total` → `balance` → `points`。

**只读，不实现任何领取**。每日积分是"当天首次带登录态打开网页时发放"，重放 `setting_info` 能触发，但那等于未经用户同意改变账号状态。

---

## 3. `provider/` —— 只做 pi-ai 装配

**白名单**：上面 + `@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`。

### api.ts（104 行）

```ts
export function createRaccoonApi(effortOf?: (model: unknown) => string | undefined): {
  stream(model, context, options?): unknown;
  streamSimple(model, context, options?): unknown;
}
```

68 行实质逻辑 + 36 行注释。做的事只有一件：**在 `onPayload` 里调 `applyThinking()`**。SSE / 思考 / 工具 / usage 全交还 pi-ai（[ADR-0007](./adr/0007-wrap-openai-completions-api.md)）。

### roster.ts（163 行）

```ts
export const LLM_CHAT_URL = `${LLM_BASE}/chat/completions`;   // 仅供 probe / 测试断言

export interface ModelDescriptor { id, name, api, provider, baseUrl, input, reasoning, cost, contextWindow, maxTokens, headers, compat }
export interface RosterOptions { contextCap?: number; visionProbe?: ReadonlyMap<string, boolean>; sessionIdFor?: (modelId: string) => string }

export function toDescriptor(model: RaccoonModel, options: RosterOptions): ModelDescriptor;
export function toDescriptors(models, options): ModelDescriptor[];
```

关键字段：

```ts
{
  api: "openai-completions",
  provider: "raccoon-web",
  baseUrl: LLM_BASE,                 // ← 不带 /chat/completions！SDK 自己拼
  input: vision ? ["text", "image"] : ["text"],
  reasoning: true,                    // 不设 thinkingLevelMap → 内核给五档
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Math.min(upstream ?? 128000, contextCap),
  maxTokens: Math.min(maxOutput ?? 8192, Math.floor(contextWindow / 2)),
  headers: sessionId ? chatModelHeaders(sessionId) : {},
  compat: {
    maxTokensField: "max_tokens",       // ← 默认是 max_completion_tokens，必须覆盖
    supportsDeveloperRole: false,        // ← 默认是 true，必须覆盖
    supportsStore: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: "openai",
  },
}
```

`baseUrl` 那个坑：`pi-ai` 的 `createClient()` 把 `model.baseUrl` 原样交给 `new OpenAI({ baseURL })`，SDK 在 `chat.completions.create()` 里自己拼 `/chat/completions`。写全路径会变成 `.../llm/v2/chat/completions/chat/completions` → 404（E-023）。

### adapter.ts（258 行）

```ts
export function assembleAdapter(options: AdapterOptions): { adapter: unknown; providerIds: string[] }
```

内部常量：

```ts
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const IMAGE_BUDGETS = { maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 640_000, requestImageMaxBytes: 1024 * 1024 };
const RETRY_POLICY = {
  mode: "normal",                       // 内核只认 "normal" | "always"
  maxRetries: 2,                        // sensenova 用 8；我们 2，因为共享积分池
  retryableCodes: ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"],   // 故意不含 RATE_LIMIT
  backoff: { initialDelayMs: 1_500, maxDelayMs: 10_000, jitterRatio: 0.25 },
};
```

**为什么 `RATE_LIMIT` 不重试**：小浣熊是按**账号 token 速率**限流，不是每分钟请求数。重试只会延长冷却，而且上游不给 `Retry-After`。

`auth.apiKey.resolve()` 必须**真的返回** `{ auth: { apiKey } }` —— 恒 `undefined` 会被 pi-ai 判成 `Provider is not configured`（已修，见 CHANGELOG）。

### fallback-roster.ts（68 行）

5 条内置名册，唯一作用是**没 token 时 `status.models` 非空**（不然用户第一次打开以为插件坏了）。

```ts
DeepSeek-V4.1-Flash   vision x0.25  1e6 / 65536
GLM-5-3               —     x0.75  1e6 / 65536
GLM-5-3-Flash         vision x0.2   1e6 / 65536
Kimi-K3               vision x1     1e6 / 65536
Qwen3.8-Flash         —     x0.15   262144 / 32768
```

文件头写明"这份表会过期"。**不注册 provider**（三元门控），只用于展示。

---

## 4. `host/` —— 唯一接触 `ctx` 的层

### index.ts（742 行，最大的单文件）

`class RaccoonHost`。一眼看清的字段：

```ts
storedToken: StoredToken | undefined;   // 扫码落盘的
desktopAuth: DesktopAuth | undefined;   // 桌面端读到的（不落盘）
desktopStatus: StatusDesktopAuth;       // 给 UI 的 {found, path?, expiresAt?, reason?}
desktopIgnored: boolean;                // 本会话内不再自动用桌面端凭据
catalog: CatalogState;                  // {models, descriptors, ready, error?}
quota: StatusQuota;
probes: Map<string, boolean>;
loginFlow: LoginFlow;
publisher: Publisher;
catalogCache: TtlCache<CatalogState>;
quotaCache: TtlCache<QuotaState>;
```

方法：

| 方法 | 做什么 |
| --- | --- |
| `bootstrap()` | 读 token → 读 probes → `resolveToken()` → `syncPublisher()` → 有 token 则 `refreshCatalog()` + `refreshQuota()` + 再 sync |
| `resolveToken(reason)` | 按 `authSource` 决定用桌面端还是扫码；过期/读不到时的降级与文案 |
| `mount(webServer)` | 挂 status / action 两条路由，返回 disposer |
| `runAction(action, body)` | 八个 action 的分派 |
| `snapshot()` | 组装 `StatusSnapshot`（含 13 行诊断） |
| `syncPublisher()` | 名册签名变了才重新发布 |
| `statusModels()` | 按 `contextCap` 截断后给 UI 的模型列表 |
| `dispose()` | 幂等，释放 routes / adapter / 定时器 |

**为什么 `bootstrap()` 要在 `refreshCatalog` 之后补 `refreshQuota()`**：早先在 `snapshot()` 里 `void refreshQuota()` 火后不管，用户第一次打开设置卡看到"余额未知"，要等 20s 轮询才出现。桌面端路线启动时就有 token，没有理由让首屏空着。

**为什么 `statusModels()` 也要按 `contextCap` 截断**：与 `roster.ts` 的 `toDescriptor` 用同一套算法。否则设置卡显示"1M 上下文"，实际发 128000，用户以为截断没生效。

### routes.ts（237 行）

```
STATUS_PATH = "/plugins/dsh-raccoon-web/status"     （GET，幂等）
ACTION_PATH = "/plugins/dsh-raccoon-web/action"     （POST only，?action=xxx）
```

| 检查 | 行为 |
| --- | --- |
| `isLoopback(req.headers.host)` 为假 | 403 `{"error":"loopback only"}` |
| action 非 POST | 405 `{"error":"POST only"}` |
| 缺 `?action=` | 400 `{ok:false,error:"缺少 action 参数"}` |
| 请求体 > 64 KB | 截断并忽略 |

响应头带 `Content-Type: application/json; charset=utf-8` 与 `Cache-Control: no-store`。

`isLoopback()` 的实现要点：`[` 开头取方括号内比对 `"::1"`；否则取 `:` 前比对 `"127.0.0.1"` / `"localhost"`；**Host 缺失返回 false**。

### login-flow.ts（386 行）

```ts
type LoginPhase = "none" | "pending" | "logging" | "ready" | "expired" | "error";
```

状态机：

```
none ──start()──→ pending ──扫码──→ logging ──确认──→ ready
  ↑                  │                  │
  └──cancel()────────┴────expired/error┘
                                ↑
                        markDead()  ← catalog 401 时调用（只改状态，不删 token）
                        markReady() ← 桌面端凭据就绪时调用
```

`generation` 自增用来丢弃过期的在途轮询回调。`start()` 每轮重新读 `qrProtocol`，`tick()` 按协议分派，`complete()` **只在 IAM 路径**做 `iam/confirm`。

**`markDead()` 不删 token 文件** —— 401 可能来自临时抖动；重扫会覆盖旧 token。

### publish.ts（222 行）

三元门控：

```
enabled === false              → "disabled"        （释放注册）
token 空 或 models 空           → "not-configured"  （释放注册）
签名变了                       → 先释放再注册 → "published"
签名没变                       → "published"       （不动）
```

`rosterSignature(models)` = `models.map(m => \`${m.id}:${m.image?1:0}:${m.contextWindow}:${m.maxTokens}\`).join(",")`。

**为什么必须"先释放再注册"而不是 `handle.replace()`**（这条踩过）：

1. 内核 `AdapterRegistrationHandle.replace(providers: string[]): void` —— 返回 **void**，不是句柄
2. 它的参数是**一份 provider 名字列表**，不是 `{providers, adapter}` 对象
3. **`adapter` 是构造时闭包捕获的，`replace` 换不了实例** —— 而换名册必须换实例（`PiAiAdapter.current()` 用 `profiles()` 引用相等做 memo）

释放与注册必须在**同一个同步段**完成，中间不能 `await`，否则监听者会看到 provider 短暂消失。

### store.ts（223 行）

```
$DSH_HOME/state/dsh-raccoon-web/token.json            （0600）
$DSH_HOME/state/dsh-raccoon-web/vision-probe.json
```

**用 `$DSH_HOME/state/` 而不是 `<profileHome>/`**：token 属于用户级，换 profile 不该被迫重新登录。

写盘是**原子写**：先写 `.tmp`（后缀带 `pid.now.random8` 防同一 tick 冲突）再 `rename`。

`readToken()` **永不抛**，`schemaVersion !== 1` 返回 `undefined`（不做迁移）。

### settings.ts（207 行）

```ts
export const SETTINGS_NS = "dsh-raccoon-web";   // 必须匹配 /^[a-z][a-z0-9-]*$/

export interface RaccoonSettings {
  enabled: boolean;              // true
  reasoning: boolean;            // true
  visionProbeOverride: boolean;  // false
  contextCap: number;            // 128_000（区间 8192–2_000_000）
  debugLog: boolean;             // false
  authSource: "auto" | "desktop" | "qr";   // auto
  qrProtocol: "web" | "iam";               // web
}

export function registerSettings(service: RawSettingsService): SettingsHandle;
export function normalizeSettings(input: unknown): RaccoonSettings;
```

**`schema` 是手写归一化函数，不是 JSON Schema** —— 内核 `settings.register(ns, schema, options)` 把 `schema` 当普通函数调用（`dsh-settings/lib/index.js:371-391`）。

**不用 schemastery**：它是宿主依赖，不在我们的 `dependencies` 里。

`get()` 每次都从内核读（**不缓存闭包**），否则用户改设置我们要重启才生效。

### status.ts（149 行）

`StatusSnapshot` 顶层十个键：

```ts
{ build, version, login, publish, catalogReady, catalogError?, models, quota, settings, desktopAuth, diagnostics }
```

`buildDiagnostics()` 输出 **13 行** `key: value`，**不含 token**，有单测断言不含 `eyJ`。

### cache.ts（75 行）

```ts
export function createTtlCache<T>(ttlMs: number, load: () => Promise<T>, now?: () => number): TtlCache<T>;
```

四个行为（都有单测）：

1. 命中不重复 `load`
2. `get(true)` 强制重取
3. **并发只发一个请求**（inflight 去重）
4. **失败不进缓存**（`finally` 清 inflight）

### log.ts（106 行）

前缀 `[raccoon-web]`，格式 `[raccoon-web] <event> k=v k=v`。

`tokenTag(token)` = `sha256(token).slice(0, 8)`，空则 `"-"`。

**`sink` 缺失时什么都不做（绝不退回 `console.log`）** —— 宿主 stdout 会被吞，而且 `console.log` 会把日志混进用户的终端。

### solid-png.ts（126 行）

`solidPng(w, h, rgb)` 手工拼 PNG（签名 + IHDR + IDAT(`deflateSync`) + IEND + CRC32 表）。

`PROBE_PNG_BASE64` = 3×3 纯红 `#ed1c24` 的 base64（73 字节）。用于识图探测（[ADR-0006](./adr/0006-vision-detection-by-probe.md)）。

---

## 5. `src/index.ts`（125 行）

```ts
export const name = "dsh-raccoon-web";
export const inject = ["llm"];               // ← 只有 llm！webServer 是可选的
export function apply(ctx: PluginContext): void;
```

`inject` 里**不写 `webServer`** —— 只有桌面 / web 宿主才有，写进去会让 CLI 宿主直接拒载整个插件。`settings` 与 `webServer` 都走嵌套 `ctx.inject([...], sub => ...)`。

`apply` 必须**同步返回**，异步全走 `void host.bootstrap()`。

---

## 6. `client.js`（1127 行，手写）

```
IIFE
├── 常量（BUNDLE_NAME / NAMESPACE / STATUS_PATH / ACTION_PATH / BUILD / PROVIDER_ID / 轮询间隔）
├── 文案字典 zh / en（各 86 键，全内联，不用 locale/*.json）
├── 样式常量（15 组，全部 var(--dsh-*, fallback) 双写）
├── 工具（tFactory / points / compact / clockOf / messageOf）
├── 共享 store（listeners / snapshot / lastError / timer / inflight / nextDelay / load / subscribe）
├── 组件（CreditPill / CreditPillGate / LoginSection / QuotaSection / ModelsSection / SettingsSection / DiagnosticsSection / PluginPage）
└── loader.load({ id, factory }) → { inject: ['slots','locale'], apply(ctx) }
```

**`var React` 与 `var h` 必须声明在 IIFE 作用域**，只在 `factory(require)` 里赋值。写在 factory 内部会让组件里 `h` 未定义（这条踩过）。

**文案内联而不是 `locale/*.json`**：宿主的 locale 加载有异步时序，一旦 key 缺失会显示原始 key 名。内联的最坏情况是显示中文。

**决策：`BUILD` 常量与 `src/build.ts` 必须手改同步**（`verify-install.mjs` 会检查两处一致）。ESM 读 `package.json` 要 import assertion，tsup 打包会把它变形。

---

## 7. 文件大小预算与现状

| 文件 | 预算 | 现状 | 备注 |
| --- | --- | --- | --- |
| `src/index.ts` | ≤120 | 125 | 略超，可接受 |
| `protocol/qr.ts` | ≤500 | 484 | 编码器本身就是长 |
| `protocol/chat.ts` | ≤250 | 470 | **超标**，帧解析 + thinking + stream 三块可以拆（但拆了会增加理解成本，暂不动） |
| `host/index.ts` | ≤400 | 742 | **超标**，`runAction` 的八个分支可以拆成 `host/actions.ts` |
| `host/routes.ts` | ≤200 | 237 | 略超 |
| `client.js` | ≤800 | 1127 | **超标**，但 classic script 拆文件要靠额外的 loader，不划算 |

**不强行拆的理由**：`chat.ts` 与 `host/index.ts` 的超标都是"同一件事的连续逻辑"，拆开会让"改一个行为要跳三个文件"。等真正需要复用（比如第二个协议）再拆。

---

## 8. 依赖方向自检

```bash
cd packages/dsh-raccoon-web

# protocol 不能碰内核
grep -rn "@deepseek-ai\|@earendil-works" src/protocol/    # 期望：零命中

# provider 不能碰 host
grep -rn 'from "\.\./host\|from "\./host' src/provider/   # 期望：零命中

# host 可以碰一切（不检查）

# token 不能出现在日志与诊断
grep -rn "console\.log" src/ client.js                    # 期望：零命中
```

`scripts/verify-install.mjs` 会跑第 3 条的等价检查（client.js 里 `console.log` 必须为 0）。

---

## 9. 相关文档

- 为什么这么分：[ADR-0004](./adr/0004-protocol-adapter-split.md)
- 时序：[02-data-flow](./02-data-flow.md)
- 存储：[03-state-and-storage](./03-state-and-storage.md)
- 界面：[04-ui-surfaces](./04-ui-surfaces.md)
- 编码约定：[06-coding-conventions](./06-coding-conventions.md)
