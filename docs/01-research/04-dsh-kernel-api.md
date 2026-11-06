# DSH 内核 API 契约（0.2.1-rc.5）

最后更新: 2026-11-06（按真宿主实测回填；`registerAdapter` 三处签名已纠正）
状态: 已定稿

> 一句话：**这些契约没有类型声明兜底，抄错了不会有编译错误，只会在运行时炸。**

内核包一个 `.d.ts` 都没有（E-009），`package.json` 里的 `types` 指向不存在的路径。所以本文的每条都是**读 `.js` 实现 + 真宿主实测**得出的，不是查文档得到的。

---

## 0. 怎么读内核源码

内核包只在一个地方能解析到（E-008）：

```
C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\
```

从 `~/.dsh/profiles/desktop` 里 `import('@deepseek-ai/dsh-llm')` 会 `ERR_MODULE_NOT_FOUND` —— 因为 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm` 是个指向已删除目录的**悬空符号链接**。

**工作区里为了跑冒烟脚本建了三条 junction**（`node_modules/@deepseek-ai/dsh-llm`、`dsh-llm-pi-ai`、`@earendil-works/pi-ai`）。单测不用它们 —— 单测走 `scripts/test-resolve.mjs` 里的桩映射。

---

## 1. 插件入口

```ts
export const name = "dsh-raccoon-web";
export const inject = ["llm"];
export function apply(ctx, config) { /* 必须同步返回 */ }
```

**`apply` 必须同步返回。** 里面要做异步初始化（读凭据、拉目录）就 `void bootstrap()`，不能 `async apply`。

`name` 要和 `package.json` 的 `name` 一致 —— 宿主按它算 cordis 节点 id。

三个参考插件形状完全一致（workbuddy / trae / minimaxcode / sensenova）。

### 1.1 `inject` 只列 `llm`

`webServer` **不写进顶层 `inject`**：

```ts
// 错：这个插件会因为没有 webServer 而整个不加载
export const inject = ["llm", "webServer"];

// 对：可选依赖用嵌套 inject
export const inject = ["llm"];
export function apply(ctx) {
  ctx.inject(["settings"], (sub) => { ... });
  ctx.inject(["settings"], (sub) => {
    sub.inject(["webServer"], (web) => { ... });
  });
}
```

理由：宿主有 desktop / web / market 三种 profile，只有前两种有 `webServer` 服务。写进顶层 `inject` 会让 CLI 场景下整个插件装不上。

### 1.2 `ctx.inject(names, callback)` 的语义

`inject` 在服务**可用时**调 callback，服务消失了就 dispose 掉 callback 里注册的东西。callback 拿到的 `sub` 是子上下文（`Object.create(ctx)` 那种），在里面注册的资源归 callback 的生命周期管。

---

## 2. `LlmService.registerAdapter` —— 三处必须记住的契约

这是本项目踩坑最多的地方。

### 2.1 真实签名

```ts
// dsh-llm/lib/typert.host.js:271-272
export interface AdapterRegistrationHandle {
    (): void;                        // 调用即注销
    replace(providers: string[]): void;   // ← 返回 void，参数是 string[]
}

registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
```

### 2.2 三处纠正（都是我们真实踩过的）

**纠正 1：`replace` 返回 `void`，不返回句柄。**

```js
// dsh-llm/lib/index.js:1856-1860
handle.replace = (next) => {
    if (released) throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED');
    this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
};
```

写成 `this.handle = this.handle.replace(...)` 的话，第一次替换后 `this.handle` 就变 `undefined`，第二次 sync 直接炸。

**纠正 2：`replace` 的参数是 `string[]`，不是 `{ providers, adapter }`。**

传对象进去，内核 `for (const provider of providers)` 迭代一个对象 → 真宿主报 `providers is not iterable`。

**纠正 3：`adapter` 是 `registerAdapter` 闭包捕获的，`replace` 换不了实例。**

```js
prepareRoutes(providers, adapter, owned)   // ← adapter 是外面传进来的那个
```

而本插件换名册**必须换 adapter 实例**，因为 `PiAiAdapter.current()` 用 `profiles()` 的引用相等做 memo：

```js
// dsh-llm-pi-ai/lib/index.js:1856-1871
if (this.snapshot?.profiles === profiles) return this.snapshot;
```

（见 §3.3）

→ **`replace` 对本插件完全无用。** 正确做法是**先释放再注册**：

```ts
// packages/dsh-raccoon-web/src/host/publish.ts
this.releaseHandle("publish/replace");
this.handle = this.llm.registerAdapter(assembled.providerIds, assembled.adapter);
```

释放与注册**必须在同一个同步段**，中间不能 `await` —— 否则监听者会看到 provider 短暂消失。

sensenova 的做法相同（`swapRegistration`，`dsh-connect-sensenova-token-plan/lib/index.js:4931-4968`）。

### 2.3 注册校验

`prepareRoutes` 会检查：

| 检查 | 失败码 |
| --- | --- |
| provider 名非空 | `INVALID_ADAPTER` |
| 同一 provider 不重复注册 | `DUPLICATE_ADAPTER` |
| `adapter.providerInfo(provider)` 返回 `{ id === provider, name: 非空 string }` | `INVALID_ADAPTER` |
| 已 dispose 的 handle 再 `replace` | `REGISTRATION_DISPOSED` |

`providerRetryPolicy(provider)` 可选，返回 `RetryPolicy`。

每次 `commitRoutes` 都会 `emitAdaptersUpdated()` 派发 `llm/adapters-updated`。

### 2.4 相关方法

```ts
registerConfigurableProviders(entries: {provider, displayName, settingsNs, settingsPath[]}[]): handle
listConfigurableProviders(): DetachedDirectoryEntry[]
registerModelDiscovery(settingsNs: string, discover: () => Promise<...>): handle
```

`registerConfigurableProviders` 的 entry 四字段**全有或全无**，否则 `INVALID_DIRECTORY`；重复 → `DUPLICATE_DIRECTORY`。

---

## 3. `PiAiAdapter`（`@deepseek-ai/dsh-llm-pi-ai`）

### 3.1 包结构

```
node_modules/@deepseek-ai/dsh-llm-pi-ai/
├── lib/index.js          2968 行，唯一实现文件
├── locale/
├── README.md / README.zh.md
└── package.json          exports: ".", "./src/*", "./package.json", "./locale/*.json"
```

导出：`Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols`。

`recordKeyFor(providerId)` = `credentialKey("llm-pi-ai", providerId)`，`RECORD_SCOPE = "llm-pi-ai"`。

### 3.2 构造参数

```ts
new PiAiAdapter({
  profiles: () => Map<string, PiAiProfile>,
  auth: InertAuth,
  resolveApiKey: (provider: string, signal?) => Promise<string>,
  resolveAttachments: () => AttachmentsService | undefined,
  resolveImageAccess: (attachments, ref) => ...,
})
```

`PiAiProfile`：

```ts
{
  provider: string,              // provider id
  displayName: string,
  streamIdleTimeoutMs: number,
  retryPolicy: RetryPolicy,
  configuredMaxTokens: Map<string, number>,
  modelErrors: Map<string, LlmError>,
  piProvider: PiAiProvider,      // createProvider() 的返回值
  // 图片预算（可选）
  maxRequestImageBytes?: number,
  requestImagePixelBudget?: number,
  requestImageMaxBytes?: number,
}
```

### 3.3 `profiles` 必须是函数形式

```ts
profiles: () => profiles      // ✅ 每次调用重新读
profiles: profiles            // ❌ 快照，之后改 Map 内容看不到
```

`current()` 的实现：

```js
// lib/index.js:1856-1871
current() {
  const profiles = this.config.profiles();
  if (this.snapshot?.profiles === profiles) return this.snapshot;
  // ... 重建 snapshot
}
```

用**引用相等**做 memo。所以：

- 改 Map **内容**（`map.set(...)`）→ 引用没变 → **快照不刷新**
- 换 Map **实例** → 引用变了 → 刷新

这也是"换名册必须换 adapter 实例"的根因（§2.2 纠正 3）。

### 3.4 `auth.apiKey.resolve()` 必须真返回东西

```ts
// ✅ 正确
auth: {
  apiKey: {
    name: "小浣熊登录令牌",
    async resolve(input) {
      const key = input?.credential?.key || await resolveToken();
      if (!key) return undefined;
      return { auth: { apiKey: key }, source: displayName };
    },
  },
}
```

```ts
// ❌ 恒返回 undefined
auth: { apiKey: { async resolve() {} } }
```

后者会让 `applyAuth()` → `resolveProviderAuth()` 拿不到 key，然后：

```js
// pi-ai/dist/models.js:429
throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
```

这条错误被 `toStreamChunks` 归成 `PI_AI_ERROR`，界面上只说"出错了"，看不出是认证问题。

**这个坑的成因**：sensenova 的实现里 `resolve` 确实有返回值，照抄形状时漏了。

### 3.5 其它调用约定

| 方法 | 签名 | 注意 |
| --- | --- | --- |
| `providerInfo(provider)` | → `{ id, name }` | `name` 不能空，否则 `INVALID_ADAPTER` |
| `providerRetryPolicy(provider)` | → `RetryPolicy` | — |
| `listModels(provider)` | → `{provider, id, name, inputModalities}[]` | **不含 `contextWindow`** |
| `modelInfo(snapshot, provider, model)` | 内部三参数 | 外部别直接调，用 `resolveModel(provider, model, signal)` |
| `resolveModel(provider, model, signal)` | → `{provider, id, name, inputModalities, context: {contextWindow}, defaultMaxTokens?, reasoning?, ...}` | — |

`listModels` 里如果 `resolveApiKey` 抛 `MISSING_CREDENTIAL`，会**返回 `[]` 而不是抛** —— 这样未登录时模型选择器只是空，不是崩。

`streamWithSnapshot` 用 `idleWatchdog(upstream, profile.streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT")` 包住迭代，超时抛 `LlmError("pi-ai stream idle timeout after <ms>ms", "TIMEOUT")`；caller abort 抛 `LlmError("pi-ai request aborted by caller", "ABORTED")`。

---

## 4. 错误分类：完全由 errorMessage 文本正则决定

这是本项目的**隐藏约束**：我们写的中文文案会进 `classifyPiAiError()` 的正则匹配。

```js
// dsh-llm-pi-ai/lib/index.js:1448-1459
/\b(?:401|403)\b/                                              → "AUTH"
isQuotaExceededError(message)                                  → QUOTA_EXCEEDED
/\b429\b|rate.?limit/i                                         → "RATE_LIMIT"
/\b413\b|failed to buffer the request body:...|payload too large/i → "INVALID_REQUEST"
/\b400\b|invalid.?request/i                                     → "INVALID_REQUEST"
/\b5\d\d\b/                                                    → "SERVER"
/\btime(?:d)?\s*out\b|timeout/i                                → "TIMEOUT"
/stream ended (?:before|without)\b/i                           → "TRANSPORT"
/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i      → "TRANSPORT"
/\bterminated\b|premature close/i                              → "TRANSPORT"
否则                                                            → "PI_AI_ERROR"
```

**规矩**：我们写的 `RaccoonError.message` 里不能出现 `400`、`timeout`、`rate limit`、`5xx` 这类词，否则会被重新分类。

例：「上游 60 秒没有返回第一个字节」 ✅（不含 `timeout`）比「first byte timeout after 60s」 ❌ 安全。

### 4.1 `mapStopReason`

```js
stop + content.length === 0  → {kind:"error", failure:{code: EMPTY_RESPONSE}}
length                       → {kind:"max-tokens"}
toolUse                      → {kind:"tool-calls"}
pending / deferred           → PI_AI_ERROR
aborted                      → {kind:"aborted"}
error                        → {kind:"error", failure:{message, code: classifyPiAiError(text)}}
上下文溢出                    → CONTEXT_WINDOW_EXCEEDED
```

**"`stop` 但内容为空"会被归成 `EMPTY_RESPONSE`** —— 这是我们实测过的：思考吃掉全部 token 时正文就是空的。所以 `EMPTY_RESPONSE` 在 `retryableCodes` 里，且最多重试一次。

---

## 5. `RetryPolicy` 的合法形状

```js
// dsh-llm/lib/index.js:247-347
DEFAULT_MAX_RETRIES = 5
DEFAULT_INITIAL_DELAY_MS = 500
DEFAULT_MAX_DELAY_MS = 10_000
DEFAULT_JITTER_RATIO = 0.1
DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]
```

```ts
interface RetryPolicy {
  mode: "normal" | "always";     // ← 只有这两个值！
  maxRetries?: number;           // 安全非负整数
  retryableCodes?: string[];     // 非空、无重复、全字符串
  backoff?: {
    initialDelayMs?: number;     // > 0 && <= MAX_TIMER_DELAY_MS
    maxDelayMs?: number;         // 同上，且 >= initialDelayMs
    jitterRatio?: number;        // [0, 1]
  };
}
```

**`mode` 只接受 `"normal"` 和 `"always"`。** 写 `"aggressive"` / `"never"` 会：

```
Error: <path>.mode must be "normal" or "always"
```

`validateKeys` 会拒绝未知键 —— 合法键固定为 `mode` / `maxRetries` / `retryableCodes` / `backoff`。

本项目的策略：

```ts
{
  mode: "normal",
  maxRetries: 2,               // sensenova 用 8，我们降到 2（积分池共享）
  retryableCodes: ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"],
  backoff: { initialDelayMs: 1500, maxDelayMs: 10_000, jitterRatio: 0.25 },
}
```

**`RATE_LIMIT` 不在列表里** —— 按账号 token 速率限流，重试只延长冷却，且上游不给 `Retry-After`。

**`mode: "normal"` vs `"always"`**：`normal` 只重试 `retryableCodes` 里的；`always` 无条件重试。我们只用 `normal`。

---

## 6. 思考档位：不设 `thinkingLevelMap` 只有五档

```js
// pi-ai/dist/models.js:679-690
getSupportedThinkingLevels(model) {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) =>
    model.thinkingLevelMap?.[level] !== null &&
    (level !== "xhigh" && level !== "max" || model.thinkingLevelMap?.[level] !== undefined)
  );
}
EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]
```

实测（冒烟脚本断言）：`reasoning: true` 且不设 `thinkingLevelMap` → **恰好五档** `["off","minimal","low","medium","high"]`。

`xhigh` / `max` 必须显式 map 过才出现。

**本项目的决定：不补 map。** 上游未必接受这两个取值，多一个可选档位就多一条"用户选了然后被拒绝"的路径。

---

## 7. `pi-ai` 的 `Api` 真实形状

```ts
interface Api {
  stream(model, context, options): AssistantMessageEventStream;      // ← 同步返回！
  streamSimple(model, context, options): AssistantMessageEventStream;
  fetchDeferred?: ...;
  cancelDeferred?: ...;
}
```

**不是 async generator，是 EventStream 对象**，用 `.push(event)` / `.end(message)` 驱动。

```js
// pi-ai/dist/api/lazy.js 全文
export function lazyApi(load, capabilities) {
  return {
    stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
    streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
  };
}
```

`openai-completions.lazy.js` 只有两行：

```js
import { lazyApi } from "./lazy.js";
export const openAICompletionsApi = () => lazyApi(() => import("./openai-completions.js"));
```

### 7.1 `createProvider` 的 `api` 可以是对象或映射

```js
// pi-ai/dist/models.js:527-590
const single = input.api && typeof input.api.stream === "function" ? input.api : undefined;
// dispatch: apiFor(model) = single ?? byApi?.[model.api]
```

找不到就返回 lazyStream 抛 `ModelsError("stream", 'Provider <id> has no API implementation for "<api>"')`。

### 7.2 `onPayload` 钩子

```js
// pi-ai/dist/api/openai-completions.js:188-191
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) params = nextParams;
```

**请求体可以在最后一刻被改写。** 这是本项目注入 `extra_body.thinking` 的唯一通道（[ADR-0007](../02-design/adr/0007-wrap-openai-completions-api.md)）。

但 **`dsh-llm-pi-ai` 的 `profileOptions()` 不透传 `onPayload`**（`lib/index.js:1754-1767` 只给 apiKey / reasoning / thinkingBudgets / cacheRetention / transport / timeoutMs / websocketConnectTimeoutMs / maxRetries:0）。

→ 所以必须在**自己的 `Api` 包装层**注入：

```ts
// packages/dsh-raccoon-web/src/provider/api.ts
const inner = openAICompletionsApi();
function wrap(method) {
  return (model, context, options = {}) => {
    const upstream = options.onPayload;
    return inner[method](model, context, {
      ...options,
      onPayload: async (params, m) => {
        const base = (await upstream?.(params, m)) ?? params;
        const merged = { ...base };
        applyThinking(merged, reasoningEffortOf(model));
        return merged;
      },
    });
  };
}
```

### 7.3 `openai-completions` 已原生支持 `reasoning_content`

```js
// pi-ai/dist/api/openai-completions.js:138, 400
const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"];
const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
```

命中就 `ensureThinkingBlock()` → `block.thinking += delta` → push `{type:"thinking_delta", contentIndex, delta, partial}`。

**思考内容解析不用自己写。**

### 7.4 `detectCompat` 对我们的 provider 全走默认

`detectCompat()` 按 provider 名与 baseUrl 子串判定（`api.z.ai` / `open.bigmodel.cn` → zai、`api.together.ai` → together、`openrouter.ai` → openrouter、`deepseek.com` → deepseek 等）。

`raccoon-web` + `xiaohuanxiong.com` **一个分支都不命中** → 全走默认：

| 字段 | 默认值 | 我们必须覆盖成 |
| --- | --- | --- |
| `maxTokensField` | `"max_completion_tokens"` | `"max_tokens"` |
| `supportsDeveloperRole` | `true` | `false` |
| `thinkingFormat` | `"openai"` | 保持（我们自己注入 `extra_body`） |

`getCompat()` 用 `model.compat.<field> ?? detected.<field>` **逐字段覆盖**，所以只需写要改的字段。

### 7.5 `baseUrl` 必须是 base，不能带 `/chat/completions`

```js
// pi-ai/dist/api/openai-completions.js:531-565
new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true, fetch, defaultHeaders: headers });
```

SDK 自己拼 `/chat/completions`。写全路径会变成 `.../llm/v2/chat/completions/chat/completions` → 404。

### 7.6 请求头合并顺序

```js
headers = { "User-Agent": getPiUserAgent(), ...model.headers }
// 然后 options.headers 最后合并（"Merge options headers last so they can override defaults"）
```

但 `PiAiAdapter.requestHeaders()`（`dsh-llm-pi-ai/lib/index.js:1817-1824`）会**剔除与 attribution 头同名的项**，再盖上 attribution 头：

```js
const reserved = new Set(Object.keys(attributionHeaders()).map(n => n.toLowerCase()));
return { ...Object.fromEntries(Object.entries(headers ?? {}).filter(([n]) => !reserved.has(n.toLowerCase()))), ...attributionHeaders() };
```

→ **认证头不能走 `profile.headers`**，必须走 `resolveApiKey`。但 `x-raccoon-session-id` 这种非 attribution 头可以烘进 `model.headers`。

---

## 8. `settings.register`

```js
// dsh-settings/lib/index.js:371-391
register(ns, schema, options) {
  // ns 必须匹配 /^[a-z][a-z0-9-]*$/
  const resolved = plainConfig(schema(mergeLayers(options?.base ?? {}, user ?? {})));
  options?.validate?.(resolved);
  this.ctx.effect(() => () => this.legacyRegistrations.delete(ns), ...);   // 自动 disposer
  return { get, watch, update, replace };
}
```

**`schema` 是个普通函数**，不是 JSON Schema / schemastery 对象。传进去的是"用户层对象"，返回归一化后的完整值。

本项目用**手写归一化函数**（`normalizeSettings`），因为 schemastery 是宿主依赖，不在我们 `dependencies` 里。

`ns = "dsh-raccoon-web"`，持久化到 `join(profileContext.home, "settings-legacy.yaml")`。

`get(ns)` 先查 `legacyRegistrations`，再查 `configEditor.configuration().find(item => item.entry?.options?.id === ns)`。

---

## 9. `webServer.register`

```ts
webServer.register({ kind: "exact" | "prefix", path: string, handler: (req, res) => void }): RouteHandle
```

三个参考插件的用法（minimaxcode `lib/index.js:2383-2410`）：

```ts
ctx.inject(["webServer"], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({ kind: "exact", path: STATUS_PATH, handler }));
});
```

**`isLoopback()` 得自己实现**（内核没导这个）：

```ts
function isLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;                    // ← Host 缺失返回 false
  const bare = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}
```

**`readRequestBody()` 也要自己实现**，上限 65536 字节。

---

## 10. 客户端半身（`client.js`）

### 10.1 加载契约

```js
(function () {
  "use strict";
  var loader = globalThis.__ModuleLoader__;
  if (loader === undefined) return;
  loader.load({
    id: BUNDLE_NAME,                       // 必须等于 package name
    factory(require) {
      var React = require("react");        // ← 只能 require('react')
      var h = React.createElement;
      return {
        inject: ["slots", "locale"],
        apply(ctx) {
          ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "...");
          var t = ctx.locale.bind(NAMESPACE);
          ctx.slots.inject("conversation.input.left", () => ctx.slots.register({...}, Comp));
          ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({...}, Page));
        },
      };
    },
  });
})();
```

**三个硬约束**：

1. 不能有 `import` / `export`（classic script，不是 module）
2. 不能有 JSX（没有构建步骤）
3. **`var React` / `var h` 必须声明在 IIFE 作用域**，只在 `factory` 里赋值 —— 组件都定义在 IIFE 里，写在 factory 内会让组件里 `h` 未定义

### 10.2 Slot 注册的两种键

| slot | 键 | 说明 |
| --- | --- | --- |
| `conversation.input.left` | `id: "raccoon-credits"` | 可以有多个实例 |
| `plugins.bundle.config` | `key: BUNDLE_NAME` | 一个插件一个 |

两个都要带 `order` / `locale` / `inject: () => ({ t })`。

### 10.3 宿主怎么下发 client.js

**路由是 prefix，不是 exact**（`dsh-client-modules/lib/index.js:202, 564`）：

```js
webCtx.webServer.register({ kind: "prefix", path: PLUGIN_ROUTE, handler: this.serveBundle });
PLUGIN_ROUTE = "/plugins";
```

真实的 URL 是 **combo 形状**：

```
/plugins/??<package-name>/client.js&rev=<12位hex>
```

`rev` = `artifactRevision()` = `sha1` 对 `[mtimeMs, ctimeMs, size]` 做 framed hash，取前 12 位。

```js
// lib/index.js:194-200
function artifactRevision(baseline) {
  return framedHash("plugin-artifact", [String(mtimeMs), String(ctimeMs), String(size)]);
}
```

实测：`curl "http://127.0.0.1:57292/plugins/??dsh-raccoon-web/client.js&rev=<算出来>"` → 200，49208 字节。

**猜错形状的路径全部 404**：`/plugins/dsh-raccoon-web/client.js`、`/app/plugins/.../client.js`、`/client.js`。

### 10.4 `parseDshClient` 的校验

```ts
dsh.client = {
  platform: string,          // 必填
  inject?: string[],
  external?: string[],
  immediately?: boolean,
}
```

**字段类型错会直接 throw，导致整个插件加载失败**（不是只有客户端部分失败）。

---

## 11. `cordis.patch.yml`

```yaml
- insert:
    - id: llm-raccoon-web
      name: "file:///D:/.../packages/dsh-raccoon-web/lib/index.js?v=1793937903234"
```

- `id` 是 cordis 节点 id，不能与已有节点重名
- `name` 可以是裸包名，也可以是**绝对 `file://` URL**

**`name` 写 `file://` URL 是让构建热更的关键。** 裸包名只在进程启动时解析一次；带 `?v=` 的 URL 每次改 tag 都会触发重新 import（`dshmarket/lib/hot.js` 的 `hotMount()` 就是这么做的）。

`Entry.import(name)` 的实现（`cordis-plugin-loader/lib/index.js:214-227`）：

```js
if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
return import(name);
```

---

## 12. 生命周期：必须挂 `ctx.effect` 的五类资源

```ts
ctx.effect(() => {
  // 注册
  return () => {
    // 清理
  };
}, "dsh-raccoon-web: <label>");
```

| 资源 | 不挂的后果 |
| --- | --- |
| `webServer.register()` 返回的 route | 卸载后路由还在，打过去 500 |
| `registerAdapter()` 返回的 handle | provider 幽灵存在，模型选择器里点不动 |
| `settings.register()` | 插件卸载后设置项还在（内核自己也会注册一个，双份） |
| 轮询定时器 | 卸载后还在打网关，白烧积分 |
| 在途 `fetch` 的 AbortController | 卸载后请求还在跑 |

本项目在 `src/index.ts` 里用一个 `ctx.effect` 管 host 整体（`host.dispose()` 内部清全部），路由挂在里面嵌套的 `sub.effect`。

---

## 13. 相关文档

- 三层分离与依赖方向：[00-architecture](../02-design/00-architecture.md)
- 每个文件干什么：[01-module-map](../02-design/01-module-map.md)
- 为什么包装而不是重写 Api：[ADR-0007](../02-design/adr/0007-wrap-openai-completions-api.md)
- 为什么用 PiAiAdapter 而不是继承 LlmAdapter：[ADR-0005](../02-design/adr/0005-pi-ai-adapter-over-raw-llmadapter.md)
- 相关实测编号：E-008 / E-009 / E-020 / E-021 / E-022 / E-023
