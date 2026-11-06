# 架构

最后更新: 2026-11-06（按实现回填，含桌面端凭据与双扫码协议）
状态: 已定稿

> 一句话：**协议层不 import 任何 DSH 包，适配层只做 pi-ai 装配，宿主层管路由与状态；token 从不进浏览器。**

---

## 1. 全景

```
┌──────────────────────────────────────────────────────────────────┐
│ DSH 桌面端（Electron 主进程 / web 宿主）                          │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ dsh-raccoon-web（宿主半身 lib/index.js，tsup 构建）         │  │
│  │                                                             │  │
│  │  index.ts          name / inject / apply（同步返回）         │  │
│  │    ↓                                                        │  │
│  │  host/  ── settings  watch ──┐                              │  │
│  │   ├ RaccoonHost ─────────────┴─ bootstrap()  (fire&forget)   │  │
│  │   ├ routes.ts    /plugins/dsh-raccoon-web/{status,action}    │  │
│  │   ├ login-flow   none→pending→logging→ready/expired          │  │
│  │   ├ store.ts     $DSH_HOME/state/dsh-raccoon-web/*.json      │  │
│  │   ├ publish.ts   三元门控 → registerAdapter                  │  │
│  │   ├ cache.ts     TtlCache（inflight 去重）                   │  │
│  │   ├ solid-png    3×3 纯红 PNG（识图探测）                    │  │
│  │   └ status.ts    快照 + 13 行诊断                            │  │
│  │    ↓                                                        │  │
│  │  provider/                                                  │  │
│  │   ├ api.ts       createRaccoonApi = 包装 openAICompletionsApi│  │
│  │   ├ roster.ts    RaccoonModel → ProviderModelDescriptor      │  │
│  │   ├ adapter.ts   createProvider + PiAiAdapter 装配           │  │
│  │   └ fallback-roster.ts  无 token 时的 5 条占位名册           │  │
│  │    ↓                                                        │  │
│  │  protocol/      （只许 node:* 与相对路径）                    │  │
│  │   ├ consts.ts   全部 URL / 超时 / 常量                       │  │
│  │   ├ errors.ts   RaccoonError（七种 kind）                    │  │
│  │   ├ headers.ts  各端点头                                    │  │
│  │   ├ qr.ts       自实现 QR 编码器（byte + M + v1–10）         │  │
│  │   ├ iam.ts      IAM 小程序扫码（协议 A）                     │  │
│  │   ├ web-auth.ts Web auth 扫码（协议 B，官方桌面端同款）       │  │
│  │   ├ desktop-auth.ts  只读官方客户端 auth.json                │  │
│  │   ├ catalog.ts  model_catalog 解析（多层级多键名）            │  │
│  │   ├ chat.ts     SSE 帧解析 / thinking 注入 / sessionId        │  │
│  │   └ points.ts   余额 + 流水 + 北京时区日判                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ DSH 内核                                                    │  │
│  │  LlmService.registerAdapter(providers, adapter)             │  │
│  │  settings.register(ns, schemaFn, {applies:"live"})          │  │
│  │  webServer.register({kind:"exact", path, handler})          │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              ↕ HTTP（loopback，仅 JSON）
┌──────────────────────────────────────────────────────────────────┐
│ DSH 浏览器半身（client.js，手写 classic script）                   │
│  conversation.input.left  → 积分药丸（20s 轮询 / 失焦暂停）        │
│  plugins.bundle.config    → 设置卡（登录 / 余额 / 模型 / 诊断）     │
│  **只调 /status 与 /action，永不接触 token**                       │
└──────────────────────────────────────────────────────────────────┘
                              ↕ HTTPS
┌──────────────────────────────────────────────────────────────────┐
│ xiaohuanxiong.com                                                 │
│  /api/iam/v1/auth/mp/qrcode*        协议 A 的取码 / 轮询          │
│  /api/web/auth/v1/login_with_qrcode_code   协议 B 的轮询          │
│  /api/web/auth/v1/{iam/confirm,user_info}                         │
│  /api/web/llm/v2/{model_catalog,chat/completions,images/gen}      │
│  /api/web/points/{v1/balance,v2/bills}                            │
└──────────────────────────────────────────────────────────────────┘
                              ↑ 只读
┌──────────────────────────────────────────────────────────────────┐
│ 官方客户端（商汤小浣熊 / @raccoon/office-desktop）                 │
│  ~/.office-raccoon/agent/config/auth.json   ← 我们只读这一个文件   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 三层分离（[ADR-0004](./adr/0004-protocol-adapter-split.md)）

依赖方向**严格单向**：

```
host  →  provider  →  protocol
```

| 层 | 允许 import | 禁止 | 为什么 |
| --- | --- | --- | --- |
| `protocol/` | `node:*`、相对路径 | 任何 `@deepseek-ai/*`、`@earendil-works/*` | 内核包**只能从安装目录解析**且没有 `.d.ts`（E-008/E-009），一旦污染就再也无法脱离宿主单测 |
| `provider/` | 上面 + `@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` | `src/host/*` | 适配层不该知道状态存哪 |
| `host/` | 全部 | — | 只在这一层接触 `ctx` |

CI 检查（`scripts/verify-install.mjs` 之外，人工跑）：

```bash
grep -rn "@deepseek-ai\|@earendil-works" packages/dsh-raccoon-web/src/protocol/    # 必须零命中
grep -rn "from \"\.\./host\|from \"\./host" packages/dsh-raccoon-web/src/provider/ # 必须零命中
```

**收益是实的**：168 个单测里，`qr` / `iam` / `web-auth` / `catalog` / `chat` / `points` / `desktop-auth` 全部在不启动 DSH 的情况下跑，靠一个 30 行的 ESM loader 钩子把 `./x.js` 映射到 `x.ts`。

---

## 3. 两个半身

| | 宿主半身 | 浏览器半身 |
| --- | --- | --- |
| 文件 | `src/**` → `lib/index.js` | `client.js` → `lib/client.js`（**手写，不经 tsup**） |
| 语言 | TypeScript ESM | classic script（`(function(){...})()`） |
| 加载 | cordis plugin loader `import()` | `globalThis.__ModuleLoader__.load({id, factory})` |
| 热更 | 改 `cordis.patch.yml` 的 `name`（`npm run revive`） | `lib/client.js` 变了宿主自动下发新 rev，**刷新页面** |
| 能做 | 一切 | 只能 `fetch` `/status` 与 `/action` |
| 约束 | apply 必须同步返回 | 不能有 `import`/`export`、不能有 JSX |

**为什么 client.js 不进 tsup**：它是 classic script，一旦被包成 ESM 就无法在 `__ModuleLoader__` 里执行。`scripts/copy-client.mjs` 只做"复制 + 静态检查（前 60 行不能有 import/export、必须含 `__ModuleLoader__`）"。

---

## 4. token 永远不进浏览器

这是硬边界，不是风格偏好。

- `/status` 返回的 `login` 块只有 `phase` / `source` / `principal`（前 8 位）/ `kind` / `expiresAt` / `message`
- 日志只打 `tokenTag()` = `sha256(token).slice(0,8)`
- 诊断块 13 行里没有 token
- `buildDiagnostics()` 有单测断言"不含 `eyJ`"（JWT 的 base64 前缀）

理由：浏览器半身运行在 renderer 里，任何 `window` 上的东西都可能被 devtools、扩展、剪贴板工具拿到。而 token 是一个能直接花这个账号积分的 bearer。

---

## 5. 为什么走 PiAiAdapter 而不是继承 LlmAdapter

[ADR-0005](./adr/0005-pi-ai-adapter-over-raw-llmadapter.md)。一句话：`LlmAdapter` 要实现 6 个方法 + 全套 assistant-stream 协议（工具调用 index 累积、`finish_reason` 映射、中断补齐、token 计数），四个参考插件全部选了声明式的 `PiAiAdapter`。

装配形状（照抄 `dsh-connect-sensenova-token-plan/lib/llm-adapter-core.js:465-512`）：

```ts
const provider = {
  ...createProvider({ id: PROVIDER_ID, name: displayName, auth: { apiKey: {...} }, models, api }),
  getModels: () => models,
};

const profiles = new Map([[PROVIDER_ID, {
  provider: PROVIDER_ID, displayName, streamIdleTimeoutMs, retryPolicy,
  configuredMaxTokens: new Map(), modelErrors: new Map(),
  maxRequestImageBytes, requestImagePixelBudget, requestImageMaxBytes,
  piProvider: provider,
}]]);

new PiAiAdapter({
  profiles: () => profiles,          // ← 必须函数形式
  auth: INERT_AUTH,
  resolveApiKey: async () => token,
  resolveAttachments: () => get?.("attachments"),
  resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(...),
});
```

三个必须照抄的细节（都踩过）：

1. **`profiles: () => profiles`** —— `PiAiAdapter.current()` 用 `profiles()` 的**引用相等**做 memo（`dsh-llm-pi-ai/lib/index.js:1856-1871`）。传 Map 本身不会自动刷新。
2. **`auth.apiKey.resolve()` 必须真的返回 `{auth:{apiKey}}`** —— 恒返回 `undefined` 会被 pi-ai 判成 `Provider is not configured`（`pi-ai/dist/models.js:429`）。
3. **换名册必须换 adapter 实例** —— 所以 `Publisher` 的做法是"先释放再注册"，而不是 `handle.replace()`（后者换不掉闭包里的 adapter）。

---

## 6. 思考通道：包装而不是重写（[ADR-0007](./adr/0007-wrap-openai-completions-api.md)）

`extra_body: {thinking:{type:"..."}}` 是私有字段，pi-ai 的 `buildParams` 里**没有任何 `extra_body` 分支**（10 种 `thinkingFormat` 全查过，E-020）。但 `openai-completions.js:188-191` 有：

```js
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) params = nextParams;
```

所以 `provider/api.ts` 只有 68 行：

```ts
const inner = openAICompletionsApi();
return {
  stream: wrap("stream"),
  streamSimple: wrap("streamSimple"),
};

function wrap(method) {
  return (model, context, options = {}) => inner[method](model, context, {
    ...options,
    onPayload: async (params, m) => {
      const base = options.onPayload ? await options.onPayload(params, m) ?? params : params;
      return applyThinking({ ...base }, effortOf(model));
    },
  });
}
```

**SSE 帧解析、思考解析（`reasoning_content`/`reasoning`/`reasoning_text` 三个别名原生支持）、文本、工具调用、usage、finish_reason 全部交还 pi-ai。** 我们只负责两件事：塞 `extra_body`、把"改代码前先测"这条纪律带进 `applyThinking` 的单测。

天然退路：若某天实测证明**顶层 `thinking`** 被稳定接受，改成 `compat.thinkingFormat` 分支就能删掉 `api.ts`。

---

## 7. 两个凭据来源（[ADR-0008](./adr/0008-desktop-credential-reuse.md)）

```
settings.authSource
├─ "auto"    → 先试桌面端凭据，读不到/过期再回落到我们自己的扫码 token
├─ "desktop" → 只认桌面端凭据（严格模式，读不到就报错，不偷偷回落）
└─ "qr"      → 只认扫码 token
```

| | 桌面端凭据 | 扫码 token |
| --- | --- | --- |
| 来源 | `~/.office-raccoon/agent/config/auth.json`（只读） | 本插件 `LoginFlow` |
| 落盘 | **不落盘，只在内存** | `$DSH_HOME/state/dsh-raccoon-web/token.json`（0600） |
| 有效期 | IAM JWT ~30 天，**过期不能自动续** | 同左（IAM token 无 refresh grant） |
| "退出登录" | 只是本会话不再读（凭据归客户端管） | 删文件 |
| 客户端换账号 | 我们下次启动自动跟着变（因为不落盘） | 不受影响 |

**只会读这一个文件**：不扫全盘、不读浏览器 cookie 库、不碰凭据管理器、不 attach 进程内存。

---

## 8. 两个扫码协议（[ADR-0009](./adr/0009-web-auth-qr-protocol.md)）

| | 协议 A（IAM 小程序码） | 协议 B（Web auth，默认） |
| --- | --- | --- |
| code 从哪来 | `POST /api/iam/v1/auth/mp/qrcode` 服务端下发 `qr-...` | **本地生成** `${Date.now()}${randomBytes(16).hex}`，45 字符 |
| appname | `商汤小浣熊` | `小浣熊官网` |
| 轮询 | `POST /api/iam/v1/auth/mp/qrcode/login` | `POST /api/web/auth/v1/login_with_qrcode_code` |
| 额外一步 | `POST /api/web/auth/v1/iam/confirm` 换 `xhx_token` | 不需要 |
| 能被微信小程序扫 | ✅ | ✗ |
| 失败信号 | 有（`AUTH_QRCODE_EXPIRED` 等错误码） | **没有**（对任何合法 code 都回 pending） |

两个命名空间互不通用：IAM 端点对 B 的 code 回 `AUTH_QRCODE_INVALID`。

`LoginFlow` 用同一套状态机（`none→pending→logging→ready/expired/error`），只在 `start()` / `tick()` / `complete()` 三处分岔。默认 `web`，因为它是官方客户端在用的那套，且少一次网络往返。

---

## 9. 生命周期

```ts
export function apply(ctx) {              // 同步返回，不能 await
  const logger = createLogger(ctx.logger);
  ctx.inject(["settings"], (sub) => {
    const settings = registerSettings(sub.settings);
    const host = new RaccoonHost({ logger, settings, llm: ctx.llm, get: ctx.get, ... });
    const unwatch = settings.watch(() => { /* debugLog / 名册相关 → 重跑 */ });

    sub.effect(() => () => { unwatch(); host.dispose(); }, "dsh-raccoon-web: host");
    void host.bootstrap();               // fire & forget

    sub.inject(["webServer"], (web) => {
      web.effect(() => host.mount(web.webServer), "dsh-raccoon-web: routes");
    });
  });
}
```

必须挂 `ctx.effect` 的资源（漏一个就会在卸载后残留）：

1. `webServer.register` 返回的两条路由
2. `llm.registerAdapter` 返回的 handle（`Publisher` 持有）
3. `settings.register`（内核自己会挂，但 `settings.watch` 的 unsubscribe 要我们挂）
4. 登录轮询定时器（`LoginFlow.timer`）
5. `settings.watch` 的 unwatch

**为什么 `webServer` 不写在顶层 `inject`**：它是可选的 —— 只有桌面 / web 宿主才有。写进顶层 `inject` 会让 CLI 宿主直接拒载整个插件。

---

## 10. 状态存哪

| 数据 | 位置 | TTL |
| --- | --- | --- |
| 扫码 token | `$DSH_HOME/state/dsh-raccoon-web/token.json`（0600，原子写） | 到 `exp` |
| 桌面端凭据 | **不落盘**，只在 `RaccoonHost.desktopAuth` | 到 `exp` |
| 识图探测结果 | `$DSH_HOME/state/dsh-raccoon-web/vision-probe.json` | 无 |
| 模型目录 | 内存 `TtlCache` | 5 min |
| 余额 | 内存 `TtlCache` | 60 s |
| 二维码会话 | 内存 `LoginFlow` | 5 min（服务端 `expires_in`） |
| 七个设置项 | `~/.dsh/profiles/desktop/settings-legacy.yaml`（内核管） | 无 |

用 `$DSH_HOME/state/` 而不是 `<profileHome>/` 的理由：token 属于**用户级**，换 profile 不该被迫重新登录。

细节见 [03-state-and-storage](./03-state-and-storage.md)。

---

## 11. 并发与背压

| 场景 | 做法 |
| --- | --- |
| 目录 / 余额并发请求 | `TtlCache` 的 inflight 去重 —— 同一个 key 同时只有一次 load |
| 连点"扫码登录" | `LoginFlow.generation` 自增，旧一代的轮询回调直接丢弃 |
| 换名册 | `Publisher` 的"先释放再注册"在**同一个同步段**完成，中间不能 `await`，否则监听者会看到 provider 短暂消失 |
| 流式对话 | 首字节 60s、帧间 120s、外部 abort 三条超时都归到 `RaccoonError` 的 `TIMEOUT` / `ABORTED` |
| 卸载时在途请求 | `LoginFlow.dispose()` 清定时器；在途 fetch 由 `AbortSignal` 自然结束 |

---

## 12. 失败模式

| 失败 | 用户看到 | 系统状态 |
| --- | --- | --- |
| 没有桌面端凭据、也没扫码 | 卡片显示"未读到客户端登录态"+ 两个按钮并列 | `publish: not-configured`，`models` 仍是 5 条 fallback（**刻意的**，不然用户以为插件坏了） |
| 凭据过期 | "官方客户端的登录态已过期：打开客户端重新登录一次，或改用扫码。" | `phase: expired` |
| 目录拉取 401 | 同"登录已失效" | 清 catalog/quota 缓存，**不删 token**（可能只是抖动） |
| 上游限流 | 长文案（按 token 速率、不是每分钟请求数） | `RATE_LIMIT`，**不重试**（重试只延长冷却） |
| 首字节 60s | "小浣熊响应超时…" | 重试 2 次（`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`） |
| 宿主卸载 | 界面元素消失 | 路由 / adapter / 定时器 / 订阅全部释放 |

---

## 13. 明确不做的事

1. **多账号池** —— 只用一个凭据来源。做池就要做配额分摊与故障切换，那是另一个项目。
2. **自动签到** —— 每日积分是"当天首次打开网页时发放"，我们**只读不写**，不代领（重放 `setting_info` 能触发，那等于未经用户同意改变账号状态）。
3. **请求录制** —— 日志只打事件与数值，不打请求体全文。
4. **代理穿透 / 伪造指纹** —— 复刻官方客户端头是为了"像正常客户端"，不是为了绕过风控。伪造 TLS 指纹、伪造 `sec-ch-ua`、代理池、打码都不做。
5. **读官方客户端除 `auth.json` 之外的任何东西** —— 不读 Nedb、不读 leveldb、不读 `mcp.system.json`、不 attach 内存。
6. **发 npm 公网** —— 见 [03-release-plan](../03-plan/03-release-plan.md)。

---

## 14. 相关文档

- 模块与文件职责：[01-module-map](./01-module-map.md)
- 时序：[02-data-flow](./02-data-flow.md)
- 存储：[03-state-and-storage](./03-state-and-storage.md)
- 界面：[04-ui-surfaces](./04-ui-surfaces.md)
- 错误模型：[05-error-model](./05-error-model.md)
- 编码约定：[06-coding-conventions](./06-coding-conventions.md)
- 协议事实：[03-raccoon-protocol](../01-research/03-raccoon-protocol.md)、[05-empirical-findings](../01-research/05-empirical-findings.md)
