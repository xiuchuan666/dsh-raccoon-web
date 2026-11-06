# 三个参考插件的写法拆解

最后更新: 2026-11-06
状态: 已定稿

读的是安装后的构建产物（无 `src/`）。路径根：

```
~/.dsh/profiles/desktop/node_modules/
  dsh-connect-workbuddy/          v5.17.0
  dsh-connect-trae/               v4.8.0
  dsh-connect-minimaxcode/        v0.5.4
  dsh-connect-sensenova-token-plan/ v0.8.6   ← 内含完整小浣熊实现
```

---

## 一、共同的骨架

三个（四个）插件的宿主入口**形状完全一致**：

```js
export const name = "<包名>";
export const inject = ["llm"];

export function apply(ctx, config) {
  // 1. 设置命名空间
  ctx.inject(["settings"], (c) => c.settings.configure({ auto: true }));
  // 2. 注册 provider
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter), "...");
  // 3. 注册 web 端点
  ctx.inject(["webServer"], (c) => { ... });
}
```

这不是巧合，是 `cordis-plugin-loader` 的插件协议：`name` 用于 loader 日志与去重，`inject` 声明服务依赖（缺服务时插件不激活而不是崩），`apply` 是唯一的生命周期入口。

**新插件照抄这个骨架。**

---

## 二、`dsh-connect-minimaxcode` —— 最小可用的完整样本

85 KB 的 `lib/index.js`、27 KB 的 `lib/client.js`。是本项目**最应该对标的体积**。

### 宿主半身

```js
// lib/index.js:1894
const name = "dsh-connect-minimaxcode";
const inject = ["llm"];
```

导出面极宽（60+ 个具名导出），但对外真正要紧的只有 `apply`：其余是给测试与调试用的。**这个习惯值得学** —— 把内部函数具名导出，写测试时不用 `rewire`。

凭据模型：

- 主路径 `~/.minimax/local-runtime.auth.json`（MiniMax 自己的桌面端写的）
- 兜底路径：插件自己维护 OAuth（`makePkce` / `startDeviceLogin` / `pollDeviceLogin`），存到 `pluginCredentialPath`
- 二级兜底：`readCredential` 直接读用户粘的 API key

**三路并存 + 优先级**。这是"外部凭据来源不稳定"的正确应对姿势：不押注单一来源。

状态存储：`PLUGIN_STATE_FILENAME`（一个 JSON），`readPluginState` / `writePluginState`，路径由 `dshHome()` 推导。**不写 `~/.dsh` 之外的任何地方。**

### Web 端点

```js
const MINIMAX_STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status';
const MINIMAX_ACTION_PATH = '/plugins/dsh-connect-minimaxcode/action';
```

两个端点，一个读一个写，都走 `webServer.register({ kind: "exact", path, handler })`：

- `status`：GET，返回 `statusDocument()` 的 JSON
- `action`：**POST only**，`action` 从 query 取，body JSON

安全边界（**必须照抄**）：

```js
if (!isLoopback(req.headers.host)) {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "loopback only" }));
  return;
}
```

`isLoopback` 是它自己的私有 helper —— DSH 内核没给。新插件要自己实现一份：

```ts
function isLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}
```

body 读取有 64 KB 上限：

```js
async function readRequestBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length > 65536) break;
  }
  return text;
}
```

### 思考：客户端半身是最值得学的一块

`lib/client.js` 头注释把设计意图写清楚了：

> The host loads a client bundle as a classic script and calls `window.__ModuleLoader__.load`, handing the factory a `require` that resolves against the browser's own module table. React therefore comes from the host — this file installs no React of its own, and ships no bundler output: it is a script, so it can be dropped into the page as-is.

结构：

```js
"use strict";
(function bootstrapMinimaxCodeClient() {
  const BUNDLE_NAME = 'dsh-connect-minimaxcode';
  const NAMESPACE = 'dsh-connect-minimaxcode';
  const STATUS_PATH = '/plugins/dsh-connect-minimaxcode/status';
  const ACTION_PATH = '/plugins/dsh-connect-minimaxcode/action';
  const POLL_INTERVAL_MS = 20000;

  const zh = { /* ... */ };
  const en = { /* ... */ };

  // ... 组件定义（用 React.createElement，不用 JSX）

  const loader = globalThis.__ModuleLoader__;
  if (loader === undefined) return;

  loader.load({
    id: BUNDLE_NAME,
    factory(require) {
      const React = require('react');
      const h = React.createElement;
      return {
        inject: ['slots', 'locale'],
        apply(context) {
          context.effect(() => context.locale.register(NAMESPACE, { zh, en }), `${BUNDLE_NAME}: locale`);
          const t = context.locale.bind(NAMESPACE);

          context.slots.inject('conversation.input.left', () => context.slots.register({
            name: 'conversation.input.left',
            id: 'minimax-credits',
            order: 4,
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, CreditPillGate));

          context.slots.inject('plugins.bundle.config', () => context.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_NAME,
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, PluginPage));
        },
      };
    },
  });
})();
```

**三条硬规矩**（新插件必须遵守）：

1. **不打包。** 手写，直接能被浏览器当脚本执行。`tsup` 不参与这个文件。
2. **不装 React。** `require('react')` 从宿主拿。
3. **`id` 与 `key` 的语义不同。** `conversation.input.left` 用 `id`（同一 slot 可以有多个挂件），`plugins.bundle.config` 用 `key: BUNDLE_NAME`（一个插件一张设置卡，按包名索引）。

**一个 store + 一个 ticker 喂多个界面。** 头注释写明："Both read it through one store with one ticker, so the account API is asked once per interval no matter how many surfaces are on screen." 这个设计直接决定了新插件不能用"每个组件自己 `fetch` + `setInterval`"。

### 元数据（`package.json`）

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [...] }
  },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json"
  }
}
```

`exports` 里 `./client` 这条不能少 —— 客户端 bundle 靠它被 `dsh-client-modules` 解析（`<id>/client` 与裸包名归一）。

---

## 三、`dsh-connect-sensenova-token-plan` —— 本项目最重要的参考

它**已经把小浣熊做完了**，只是绑在 sensenova 的体系里。要读的是它的浣熊模块。

### 模块切分（构建产物里的 region 标记，按行号）

```
lib/index.js
    9  codes.ts                    — 错误码常量
  268  sensenova-crypto
  496  auth-config
  605  auth-trace
  772  auth-iam
 1024  sensenova-auth
 1408  credentials-service
 1456  state-store
 1845  throttle-store
 2080  token-store/*
 3090  catalog-store
 3420  switch-store
 3497  provider-store
 3595  draw-store
 3778  api-key-store
 3917  raccoon-store              ← 浣熊凭据
 4175  raccoon-switch-store       ← 浣熊开关
 4301  raccoon-web-store          ← 浣熊网页登录态
 4382  raccoon-roster-seen-store  ← 见过的模型名册
 4559  switch-precedence
 4633  publish-core
 4993  raccoon-publish            ← 三元门控发布器
 5190  provider-publish
 5519  coalesced-fetch
 6552  routes/*
 8475  effects                     ← 错误分类/文案
 8549  raccoon-search
 9030  lifecycle
 9240  index
```

**关键洞察：它把 store 切得很细。** 每个关注点一个 store（凭据 / 开关 / 网页登录态 / 名册快照 / 模型目录），互不覆盖。新插件的 `src/host/store/` 照这个粒度切。

### 浣熊 provider 装配（`lib/raccoon-llm-adapter.js`，62 行）

```js
import { a as raccoonRoster, n as RACCOON_PROVIDER_ID, r as buildRaccoonDescriptors, t as RACCOON_DISPLAY_NAME } from "./raccoon-models.js";
import { t as assemblePiAiAdapter } from "./llm-adapter-core.js";

export function createRaccoonAdapter({ rows, officeIdentity = "", resolveToken, get }) {
  const models = buildRaccoonDescriptors(rows ?? raccoonRoster(null), { officeIdentity });
  return assemblePiAiAdapter({
    providerId: RACCOON_PROVIDER_ID,
    displayName: RACCOON_DISPLAY_NAME,
    apiKeyName: "Raccoon access token",
    models,
    resolveCredential: resolveToken,
    get,
    requestImagePixelBudget: RACCOON_REQUEST_IMAGE_PIXEL_BUDGET,
  });
}
```

**注意它把"造 adapter"缩成一行委托。** 真正的粘合在 `llm-adapter-core.js:465-512`。

### `assemblePiAiAdapter`（`lib/llm-adapter-core.js:465-512`）—— 直接可抄的形状

```js
const provider = createProvider({
  id: providerId,
  name: displayName,
  auth: { apiKey: { name: apiKeyName, async resolve({ credential }) { return credential; } } },
  models,
  api: openAICompletionsApi(),
});
const profiles = new Map([[providerId, {
  provider,
  displayName,
  streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), ...),
  configuredMaxTokens: new Map(),
  modelErrors: new Map(),
  ...reasoning,
  ...imageBudgets(...),
  piProvider: provider,
}]]);
return {
  adapter: withReclassifiedStream(new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveCredential(),
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => get?.("fs")?.processPathFromHostPath?.(hostPath), ref),
  })),
  providerIds: [providerId],
};
```

import 行（**原样抄**）：

```js
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
```

### 重试策略

```js
{
  mode: "normal",
  maxRetries: 8,
  retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
  backoff: { initialDelayMs: 1500, maxDelayMs: 20000, jitterRatio: 0.25 },
}
```

**`QUOTA` / `ACCOUNT_QUOTA` 不在列表里，是刻意的**：共享积分池，重试只会延长冷却。新插件沿用，并在注释里写明理由。

### 发布器：三元门控（`raccoon-publish`，`:4993`）

```
开关关               → dispose 现有注册，不注册
开关开 + 无 token    → dispose，error = "not_configured"
开关开 + 有 token    → 构建并注册
```

`createPublishQueue()` 串行化 + `disposed` 门 + `registerPair` 单点注册 + 失败回滚上一对。签名 `raccoonSignature(rows) = rows.map(r => `${r.id}:${r.vision===true?1:0}`).join(",")` 用来判断"要不要重新发布"。

**这个模式直接抄。** 它解决的是"settings 变了 / 登录态变了 / 模型目录刷新了"三个事件并发触发重新注册的竞态。

### 模型映射的诚实之处

```js
reasoning: false,   // 网关唯一思考通道是 extra_body.thinking，pi-ai openai-completions 不发射它
```

—— 承认限制，而不是假装支持。本项目要在 [ADR-0003](../02-design/adr/0003-reasoning-channel.md) 里把这个限制解掉。

---

## 四、`dsh-connect-workbuddy` —— 文档与工程化的标杆

619 KB 的 `lib/index.js`、724 KB 的 `lib/client.js`。体积说明它做的事很多（账号池、心跳、CLI）。

**代码层面没多少可抄的**（太重、太特化）。值得学的是**别的东西**：

### README 的写法

结构：

```
<p align=center><img 头图></p>
<h1 align=center>包名</h1>
**一句话定位**
徽章行 + 锚点导航
## 风险提示        ← 引用块，先说不保证什么
## 功能特性        ← 极长 bullet，每条 emoji + 加粗开头
## 安装
## 工作原理
## 账号池
## CLI 路线
## 免责声明
```

`## 功能特性` 里每条都带**实测数值、issue 编号、取舍理由**。例如不写"支持识图"，写"识图按逐个模型实测判定，2026-09-18 测的 5 个模型里错 2 个，两个方向都错，原因分别是……"。

**这是本工程文档的标杆。** 一个决定没有证据就不配写进文档。

### 文件布局

```
lib/index.js          宿主
lib/client.js         浏览器
lib/bin.js            CLI 入口（可选）
lib/host-heartbeat-*  独立子模块
icons/
locale/{en,zh}.json   语言包独立成文件，不内联
docs/WINDOWS.md       平台特化文档
screenshots.json      截图清单
THIRD_PARTY_NOTICES.md
```

**语言包独立成 JSON** 比 minimaxcode 内联在 `client.js` 里更好维护 —— 但 minimaxcode 的做法省一次网络请求。本项目：**宿主半身用内联常量，`client.js` 也用内联**（少一个请求），但 `locale/` 目录仍然提供（给 DSH 的设置界面读）。

### `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-connect-workbuddy
      name: dsh-connect-workbuddy
```

`id` 是这个 loader 条目的稳定标识（settings 按它存），`name` 是要 `import()` 的模块说明符。两者可以不同 —— 新插件用 `id: llm-raccoon-web`、`name: dsh-raccoon-web`，跟 sensenova（`id: llm-minimaxcode` 那种风格）保持一致。

---

## 五、`dsh-connect-trae`

537 KB + 494 KB。作者同 workbuddy，是同一套工程体系的产物。额外有一个 `scripts/verify-windows.mjs` —— **安装后自检脚本**，这个习惯要学。

新插件的 `scripts/verify-install.mjs` 直接对标它：装完跑一遍，检查包能解析、`exports` 齐全、patch 条目在、provider 出现在 `llm/adapters` 里。

---

## 六、横向对比：本项目该抄谁

| 关注点 | 抄谁 | 具体做法 |
| --- | --- | --- |
| 插件骨架 | 全体 | `name` / `inject: ["llm"]` / `apply(ctx, config)` |
| Provider 装配 | sensenova | `assemblePiAiAdapter` 的形状，一行委托 |
| 发布门控 | sensenova | 三元门控 + 发布队列 + 签名比对 |
| Store 粒度 | sensenova | 一关注点一 store |
| Web 端点安全 | minimaxcode | `isLoopback` + POST-only + 64 KB 上限 |
| 客户端半身 | minimaxcode | classic script + `__ModuleLoader__.load` + 一个 store 喂多面 |
| 自检脚本 | trae | `scripts/verify-install.mjs` |
| 文档风格 | workbuddy | 每个决定带实测证据与拒绝理由 |
| 目录布局 | workbuddy | `lib/` + `locale/` + `icons/` + `docs/` |

## 七、明确不抄的

| 东西 | 为什么不抄 |
| --- | --- |
| workbuddy 的账号池 | 小浣熊是单账号 + 积分模型，池化没有收益，只增加凭据泄露面 |
| minimaxcode 的三路凭据兜底 | 小浣熊的桌面端凭据路径已失效，两路兜底（扫码 + 手动粘 token）就够 |
| sensenova 的 `reasoning: false` | 见 ADR-0003，本项目要打开思考通道 |
| 任何插件的 `bin.js` CLI | 本项目先用设置页 + 脚本，CLI 进 backlog |
