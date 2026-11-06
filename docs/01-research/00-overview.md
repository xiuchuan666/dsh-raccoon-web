# 调研总览

最后更新: 2026-11-06
状态: 已定稿

## 这次调研要回答的四个问题

1. **DSH 插件长什么样？** —— 三个能用的参考插件（workbuddy / trae / minimaxcode）怎么写宿主半身、客户端半身、settings、provider 注册。
2. **别人已经做过的小浣熊反代长什么样？为什么坏了？** —— 四个已知实现，逐个拆。
3. **小浣熊网关到底怎么讲？** —— 端点、鉴权、请求头、SSE 帧、错误码、限流、积分。
4. **DSH 内核给了哪些钩子？** —— `llm.registerAdapter`、`settings.register`、`webServer.register`、`__ModuleLoader__`。

## 方法

- **读产物**：所有参考插件都是已构建的 ESM 包，没有 `src/`，直接读 `lib/*.js` 与 `client.js`。用 `grep` 定位 region 标记（`//#region lib/types/xxx.js`），按 region 阅读。
- **读内核**：DSH 安装目录 `resources/app/dsh/node_modules/@deepseek-ai/*` 的 `lib/index.js`，同样是构建产物。重点读 `dsh-llm`（provider 注册契约）、`dsh-client-modules`（客户端 bundle 契约）、`dsh-settings`、`cordis-plugin-loader`（模块解析）。
- **打真网关**：直接 `curl`/`fetch` 打 `xiaohuanxiong.com`，记录状态码与响应体。**这是唯一可信的证据来源。**
- **比对**：把两个独立实现（`dsh-raccoon-connect` 与 `dsh-llm-adapters` 里的小浣熊部分、以及 sensenova 内建的浣熊 provider）对同一端点的假设列表拉平对比，冲突处逐条实测裁决。

## 结论摘要

### 一、旧插件全死在凭据入口，不是死在代码质量

四个已知实现里，三个依赖 `~/.box-agent/config/auth.json`，一个依赖给别人的 `node_modules` 打补丁。本机实测 `~/.box-agent/config/auth.json` **不存在**，而 `POST /api/iam/v1/auth/mp/qrcode` **返回 200**。

→ 换入口，不是修代码。见 [ADR-0001](../02-design/adr/0001-login-via-web-qr.md)。

### 二、可用的协议已经被完整逆向出来了

`dsh-llm-adapters@1.2.4` 里有一份完整且当前有效的实现：IAM 扫码三步、`iam/confirm` 换 `xhx_token`、`model_catalog` 校验、`chat/completions` SSE、`points/v1/balance`、`points/v2/bills`。本项目直接沿用这套协议，并把它的每一处假设标注为"待实测"。

全部写进 [03-raccoon-protocol.md](03-raccoon-protocol.md)。

### 三、sensenova 的浣熊 provider 有两个已知缺陷

`dsh-connect-sensenova-token-plan@0.8.6` 内建了浣熊 provider，能用，但：

1. **不发 `x-client-platform` / `x-client-version`。** 而 `dsh-llm-adapters` 的 `raccoonHeaders()` 明确带这两个头。官方网页端一定带。缺头可能被网关降级处理或计入"非官方客户端"。
2. **`reasoning: false`。** 它在 descriptor 里明示关闭思考，因为 pi-ai 的 `openai-completions` API 不发射 `extra_body`。代价是整个思考通道作废。

→ 本项目补齐这两个头，并用自定义 pi-ai Api 把思考通道打开。见 [ADR-0003](../02-design/adr/0003-reasoning-channel.md)。

### 四、DSH 内核的扩展点够用，但有三个坑

1. **内核包没有 `.d.ts`。** `@deepseek-ai/dsh-llm` 的 `package.json` 写 `types: lib/types/index.d.ts`，但该文件不存在（`find -name '*.d.ts' | wc -l` = 0）。TS 项目要么自己补声明，要么关掉对内核包的严格类型检查。
2. **内核包不在 profile 的 `node_modules` 里。** 从 `~/.dsh/profiles/desktop` 跑 `import('@deepseek-ai/dsh-llm')` → `ERR_MODULE_NOT_FOUND`。它们在安装目录 `resources/app/dsh/node_modules` 下，靠宿主进程的 `cordis-plugin-loader` 用自己的 `baseUrl` 解析。**开发时不要试图在仓库里 `import` 内核包跑单测**，要么 mock，要么把安装目录加进 `NODE_PATH`（不推荐，版本会飘）。
3. **客户端半身是 classic script，不是 ESM。** 没有 `import`，React 从 `require('react')` 拿。构建流水线里它必须被单独处理（tsup 不管它）。

全部写进 [04-dsh-kernel-api.md](04-dsh-kernel-api.md)。

## 调研没解决的问题

见 [06-open-questions.md](06-open-questions.md)。其中三条必须在写代码前解决，已列入 WBS 的 P0：

- 网关 SSE 的 error frame 到底长什么样（只在参考实现里见过解构，没见过真帧）
- `x-client-platform` / `x-client-version` 到底是必需还是可选
- `extra_body.thinking` 是否还能被网关接受（2026-11 之后没验证过）
