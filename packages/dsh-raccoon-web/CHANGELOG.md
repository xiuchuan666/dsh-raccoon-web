# 更新日志

本项目遵循「每个版本都写清实测更新」的规矩：**只要网关行为变了，就单独记一条**，
不能混进「修复」里 —— 因为那不是我们的 bug，是上游改了。

## 0.1.0（2026-11-06）

首个可用版本。两条登录路线、一个 provider、零运行时依赖。

### 新增

- **首选：复用官方桌面客户端的登录态。** 只读 `~/.office-raccoon/agent/config/auth.json`
  （Windows 桌面端的真实落点，E-030），`authSource` 三态 `auto | desktop | qr`（默认 `auto`）。
  只读、不上传、不复制副本；`source:"desktop"` 的 token **不落盘**，客户端换账号我们下次启动自然跟着变
  （[ADR-0008](../../docs/02-design/adr/0008-desktop-credential-reuse.md)）。
- **兜底：扫码登录，默认走官方桌面端那套 Web auth 协议。** code 本地生成（13 位时间戳 + 32 hex）、
  `appname=小浣熊官网`、`POST /api/web/auth/v1/login_with_qrcode_code`；
  IAM 小程序码（`/api/iam/v1/auth/mp/qrcode`）作为 `qrProtocol:"iam"` 保留
  （[ADR-0009](../../docs/02-design/adr/0009-web-auth-qr-protocol.md)）。
- 自实现 QR 编码器（byte 模式 + 纠错 M + 版本 1–10 + SVG 输出），零运行时依赖（ADR-0002）。
  经 OpenCV 双检测器验证：12 个容量边界 + 40 个随机内容全部可解（E-024）。
- 小浣熊 provider 注册为 `raccoon-web`，模型列表来自 `GET /api/web/llm/v2/model_catalog`。
- 思考通道：包装 `openAICompletionsApi()`，在 `onPayload` 里注入 `extra_body.thinking`（ADR-0007）。
  —— 这是相对 `dsh-connect-sensenova-token-plan`（`reasoning: false`）的核心差异。
- 积分药丸：输入框左侧显示可用积分，20s 轮询，失焦暂停；点击展开永久 / 每日明细。
- 设置卡：登录来源 / 扫码协议 / 登录态 / 二维码 / 余额 / 模型列表 / 识图探测 / 诊断块 / 五个开关。
- 识图探测：每个模型一个按钮，发 3×3 纯红 PNG 问颜色，三态判定后持久化（ADR-0006）。
- 首字节超时 60s（实测高峰有 60s+ 无响应）+ 流内 idle 120s。
- 限流识别覆盖 **HTTP 200 + `{"code":200429}`** 这种形状，不只是 `status === 429`。
- 结构化日志 `[raccoon-web]`，token 只打 `sha256` 前 8 位。
- 构建即可热更：`scripts/link.mjs` 把 profile 里那条 insert 的 `name` 写成带 `?v=<mtime>`
  的绝对 `file://` URL（DSH 的 loader 支持，`dshmarket` 自己也这么做）；`scripts/revive.mjs` 手动换 tag。

### 适配网关

- **目录字段在嵌套里**：`context_window` / `max_tokens` 在 `params` 对象内，不在顶层 →
  `pickNumberDeep()` 先读顶层再读 `params`/`config`/`limits`/`meta`/`spec`（E-032）。
- **显示名是 `description`**（`"Kimi-K3"`），`name` 与 `model_name` 都是 id（E-032）。
- **倍率是 `billing_multiplier` / `billing_effective_multiplier`**，不是 `multiplier`（E-032）。
- **分类分组 key 取 `type`**：分类对象只有 `{type:"chat", default_model}`，没有 `key`/`name`（E-032）。
- `visible:false` 的模型（`raccoon-*` 三个）默认过滤 —— 它们**能调通**，只是官方客户端不展示。
- `baseUrl` 用 `https://xiaohuanxiong.com/api/web/llm/v2`（不带 `/chat/completions`）——
  pi-ai 的 OpenAI SDK 自己拼，写全路径会双份 404（E-023）。
- `compat.maxTokensField: "max_tokens"` 显式覆盖 —— `detectCompat` 对 `raccoon-web` 走默认的
  `max_completion_tokens`，网关不认（E-020）。
- `compat.supportsDeveloperRole: false` 显式覆盖 —— 默认 `true`，会把 system 发成 developer。
- 请求头补齐 `x-client-platform` / `x-client-version: v1.0.35` / `x-org-code: ""`。
  **注意：官方 asar 里这三个头零命中**（E-034），带上无副作用但没有官方依据。
- `x-raccoon-session-id` 按 `sess-0-<sha256(principal\0model)[:8]>` 稳定生成，
  不每次请求新开会话。
- 思考注入实测：`extra_body.thinking` 与顶层 `thinking` 都生效，`enable_thinking` 无效；
  **关掉思考后仍有少量 `reasoning_content` 回吐**（E-035）。

### 修复

- `registerAdapter` 返回的句柄 `replace()` 返回 `void` 且**换不掉 adapter 实例**，
  早先当成返回新句柄 → 第二次换名册后句柄丢失，`refresh-auth` 报 `providers is not iterable`。
  改为「先释放再注册」，全程只有一个活着的 registration（单测 ST-10 / ST-10b 覆盖）。
- `refresh-catalog` 只更新了内存目录，没有重新发布名册 → 设置卡显示 64000 而模型选择器背后还是 128000。
- `auth.apiKey.resolve()` 恒返回 `undefined` → pi-ai 抛出 `Provider is not configured: raccoon-web`，
  界面只说"出错了"。改为从 `credential.key` 取、取不到再 `resolveToken()` 兜底。
- 未登录时 `refresh-catalog` 静默返回 `{ok:true, models:[]}` → 用户以为目录空了。
- 未登录时设置卡模型列表为空 → 改用 fallback 名册展示（"展示"与"注册 provider"是两件事）。
- `statusModels()` 未按 `contextCap` 截断 → 显示 1M 上下文、实际发 128000。
- 设置卡只注册了 `conversation.input.left` 与 `plugins.bundle.config` 两个 slot，
  **漏了 `settings.section`** → 用户看「设置」对话框时左侧菜单没有「小浣熊」，`contextCap` 等设置项无从调整。
  现补注册 `settings.section`（`id: BUNDLE_NAME`、`order: 95`、`label: () => t('title')`、包装组件闭包捕获 `t`），
  与插件面板包详情页入口并存。BUILD 升到 `2026-11-06T15:35`。

### 已知限制

- 桌面端凭据路线依赖一个不受我们控制的文件路径。客户端升级改了目录就得跟着改
  （所以候选路径是六条枚举 + `BOX_AGENT_CONFIG_DIR` / `BOX_AGENT_HOME` 优先，不是硬编码一条）。
- 桌面端凭据过期（IAM JWT `exp` 到点）后无法自动续期 —— IAM token 没有 legacy refresh grant（E-032），
  只能提示用户"打开客户端重新登录一次"。
- "退出登录"在桌面端来源下只表示"本会话不再自动读取"，**不会删除客户端的 `auth.json`**。
- 扫码路线需要人工确认一次，无法无人值守部署。
- 每日积分**只读不代领** —— 上游没有独立签到接口，每日积分由"当天首次带登录态访问网页"发放，
  重放 `setting_info` 能触发，但那等于未经用户同意改变账号状态。
- 识图能力实测探测已实现，但**尚未对真实图片跑过一次**（E-018 / E-019 待补）。
