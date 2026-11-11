# 更新日志

本项目遵循「每个版本都写清实测更新」的规矩：**只要网关行为变了，就单独记一条**，
不能混进「修复」里 —— 因为那不是我们的 bug，是上游改了。

## 0.2.0（2026-11-11）

多账号池 + 三处上游行为纠偏。**这一版的核心是"一个人用多个号"**：统一管理、额度用完自动换、
一键全签、每号独立设备身份。

### 新增

- **账号池**（[ADR-0010](../../docs/02-design/adr/0010-account-pool.md)、[07-account-pool](../../docs/02-design/07-account-pool.md)）。
  `accounts.json`（`0600` + 原子写）存多个 token，**每个账号一个稳定随机 `X-Client-Device-ID`**
  （`raccoon-` + 32 hex），成员**显式勾选**才参与发请求，新加的号默认 `enabled:false`；
  空池绝不退化成"用全部账号"。
- **自动换号**。选号在 `resolveApiKey`、记测量在 `onResponse`；排序五条：可用 → `daily` 降序 →
  `available` 降序 → `expiresAt` 降序 → `id` 升序。`daily` 排在 `available` 之前是刻意抄
  workbuddy issue #70 的教训（它把"快过期先花"排在"余额高"后面做严格字典序，那条规则**从未生效**，
  真实病例 196.4 分当天作废）。**HTTP 400 不换号、流中途断开不换号**（那是请求本身的问题，换号只会连累下一个）。
- **一键签到**。`POST /api/web/desktop/v1/login/points/grant`（E-036），先查流水再写、
  单个账号失败不中断整轮、**与自动换号开关无关**（workbuddy 曾把签到按钮挂在开关上，
  关掉开关后再也没法签到）。返回三态：已签 / 已领到 / 失败。
- **设置界面新增「账号池」区块**：开关、成员勾选、逐号测试（打 `model_catalog`，**零 token 成本**）、
  两段式移除、扫码加号、导入客户端账号、一键签到、当前使用标记、设备标识后 8 位。
- 诊断块 **13 → 14 行**，新增 `号池:` 一行（五种形态：关/池空、关/N 个账号、开/池空、开/N 个 0 启用、
  开/N 个启用当前 xxxxxxxx）。
- 新增 `settings.section` slot 注册 —— **设置对话框左侧菜单出现「小浣熊」**（此前只有
  「插件」面板里的包详情页，用户找不到）。

### 修复

- **`apply()` 首句 `locale.register()` 抛错会让三个 slot 全部不注册。** DSH 0.2.2-rc.1 起，
  同一 namespace 同一 locale 重复注册会抛 `locale namespace "dsh-raccoon-web" already has locale "zh"`，
  同一包被加载两次就触发 → 积分药丸 + 设置菜单项 + 插件配置页**一个都不出现**，看起来像插件没生效。
  现在 `apply()` 分步 try/catch（`bindTranslator()` / `guard(label, step)`），任何一步失败只记
  `console.error` 并继续。离线复现：`npm run smoke:client:twice`。
- **积分药丸只在选中小浣熊时显示** → 用户默认模型是别的 provider 时永远看不到余额。
  改成**总是显示**，选中的不是小浣熊时降透明度并多一行说明。
- `poolSnapshot()` 的 `device` 用 `deviceId.slice(0, 8)` 把 `raccoon-` 前缀整个吃掉，
  界面显示 `device: "raccoon-"`。改成 `replace(/^raccoon-/, "").slice(0, 8)`。
- `readToken()` 从磁盘读回时漏展开 `source` 字段，导致重启后 `source` 永远是 `undefined`。
- `pool-toggle` 写盘失败时没有回滚内存里的 `enabled`，界面会显示成功。
- **`refreshCatalog()` 在 401 时无条件把主登录判死。** 两个后果：号池在服务时坏的是**池成员**的凭据
  （`recordMeasure()` 已经把它标 `dead` 并换号），却让用户看到"登录已失效"；桌面端凭据失效时
  提示"请重新扫码"，而他从来没扫过码。现在只在**没有池成员在服务**时判死，文案按来源分岔
  （桌面端 → "打开官方客户端重新登录"，扫码 → "请重新扫码"）。
- **"未登录"的三处文案只提扫码。** 装过官方客户端的人根本不需要扫码（ADR-0008 会自动读它的
  `auth.json`），只让他去扫码等于把首选路线藏起来。`HINTS.AUTH`、`resolveApiKey()` 的报错、
  `refresh-catalog` 的返回值都改成"两条路都说"。
- **`recordMeasure()` 每轮对话都把整表 `accounts.json`（含明文 token）重写一遍。** 它挂在每个响应的
  `onResponse` 上，等于每说一句话就把所有账号的 token 往磁盘刷一次，日志也被 `pool/measure ok` 刷满。
  新增纯函数 `shouldPersistMeasure()`：**`ok` 之后又是 `ok` 就不写**，其余情况（首次确认、解除冷却、
  任何转非 `ok`）都写。只比 `state` 不比 `at` —— `at` 每次都变，拿它比较等于没比较。
- `runAction()` 的注释还写着"八个 action"，实际已是 16 个 `case` / 14 个 action 名（注释漂移）。
  同时写明"新增 action 必须同时改三处"（switch / client.js 按钮 / 07-account-pool.md §5 的动作表）。
- **`load()` 在飞时直接 `return`，把 `act()` 结尾那次刷新丢掉。** 每个 action 完成后都会
  `void load()`，但它有可能正好撞上一次 20 秒轮询 —— 那次刷新被静默丢弃，用户点完「测试」
  或勾完开关要等下一个轮询周期才看到变化，看起来像按钮没生效。现在改成置 `reloadWanted`
  并在本轮返回后补跑一次。`routes.ts` 头注释里"八个 action / 八条路由"也同步改成十四个。
- **两个扫码入口共用一个 `LoginFlow`，池区会把主登录的二维码当成自己的。** `start(mode)` 先
  `cancel()` 再取码，所以用户在池区点了「扫码添加」之后又去点「扫码登录」时，`phase` 仍是
  `pending`，池区的 `scanning` 判据（只看 `phase`）依然为真 → 显示一张已经属于主登录的码，
  扫完 token 写进 `token.json` 而池里没多号。现在 `LoginSnapshot.mode`（`primary` / `pool`）
  一路透传到 `StatusLogin.mode`，池区用 `login.mode === 'pool'` 认领、登录区在
  `mode === 'pool'` 时改显示 `loginPoolBusy`；`cancel()` / `markReady()` / `markDead()` /
  `complete()` 的池分支都把 `mode` 收回 `primary`。

### 适配网关（E-018 / E-019 实测纠偏）

- **图片：`data:image/...;base64,` 与公网 URL 都支持**。此前文档写"只支持 base64"是错的 ——
  `image download failed` 的真实含义是**服务端去下载那个 URL 失败**（google / wikimedia 在我们这里
  下不到，httpbin 成功）。**裸 base64 会被当成 URL 去下载**，所以必须带 `data:` 前缀。
  报错文案已改成"服务器没能下载到这张图，把图片保存到本地再作为附件发送"。
- **请求体上限约 3.0001 MiB，不是 10 MB；超限返回 `400 inference request is invalid`，不是 413。**
  按 413 做分支是死代码。现在 `chatStream()` 只序列化一次请求体并量出真实字节数，
  在 400 上按 message + 实际字节数联合判定，接近上限才给"减少图片"的建议
  （否则会把参数错误也说成体积问题）。
- **token refresh 不做**（E-037）。四轮实测确认 body 字段名是 `token`，格式校验猜不出来；
  且 refresh 会 rotate，一 rotate 就把官方客户端踢下线。收益远小于风险。

### 测试

- `220 tests / 45 suites / 220 pass`（0.1.0 时是 168）。新增 `test/pool.test.ts`（PO-1~PO-40）
  与 `scripts/smoke-pool.mjs`（**12 段 56 条断言**，真 `RaccoonHost` + 假网关）；
  `test/chat.test.ts` 新增 CH-37a~CH-37f 覆盖 E-018 / E-019 的六条分支。
- `smoke-pool.mjs` 第 6.5 段：连查五次 `status`，断言当前号一致且 `pool/pick` **至多 1 条**
  —— 只读路径不许放大选号副作用。第 6.6 段：造"池成员 401"与"无池成员 + 桌面端凭据 401"两种现场，
  正反两面断言 `markDead()` 的两个前提条件。

---

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
- **账号池**（[ADR-0010](../../docs/02-design/adr/0010-account-pool.md)）：`accounts.json` 存多个 token（`0600`、
  原子写、不并入 `token.json`）；成员**显式勾选**、新号默认 `enabled:false`、空池绝不退化成"全部账号"。
  `poolEnabled` 默认 `false`（号池会自动**花掉**积分，必须显式打开）。
- **自动换号**：选号在 `resolveApiKey`（每次请求一次），记测量在 `onResponse`（拿得到 status）。
  排序五条：①可用优先 ②`daily` 降序 ③`available` 降序 ④`expiresAt` 降序 ⑤`id` 升序。
  ②排在③之前是 workbuddy issue #70 的教训（它把"快过期先花"排在"余额高"后做严格字典序 → 该规则从未生效）。
  **HTTP 400 不换号**（请求本身不合法，换号只是多等几轮看到同一个错）、**流中途断开不换号**（字节已发出）。
- **一键签到**：`POST /api/web/desktop/v1/login/points/grant`（E-036，无 body）。先查流水判今日是否已领，
  已领直接标 `already` 不发写请求；单个失败只标该行**不中断整批**；**与 `poolEnabled` 无关**（关掉自动换号也能签到）。
- **独立设备环境**：每个账号一个稳定随机 `X-Client-Device-ID`（`raccoon-` + 32 hex，E-038），
  `x-client-platform` 恒 `desktop-windows`。设备身份是**名册级**属性（`profileOptions()` 不透传请求头），
  所以换号必须重建名册，`rosterSignature()` 末尾带 `|dev:<deviceId>`。
- 诊断块 13 → **14 行**，新增「号池」（五种形态）。
- 客户端新增 `PoolSection`：账号列表（勾选 / 状态 / 设备 8 位 / 凭据到期 / 冷却到）、扫码添加、
  导入客户端账号、一键签到、测试、两段式移除。

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
- **DSH 升到 0.2.2-rc.1 后三个 slot 一个都不注册** → 积分药丸消失 + 设置页空白。根因是
  `apply(ctx)` 第一句 `ctx.locale.register()` 在 namespace 重复时抛错（`locale namespace "dsh-raccoon-web" already has locale "zh"`），
  后面三个 `slots.inject` 全部没执行。改成 locale 注册单独 try/catch、三个 slot 各包一层 `guard()`，
  **任何一步失败都不能连累其它两步**。新增 `scripts/smoke-client-apply.mjs` 离线跑 `apply` 回归（`--twice` 能抓住旧版 bug）。
- **积分药丸只在选中小浣熊时显示** → 用户默认模型是 `workbuddy-global`，药丸永不出现。改成总是显示，
  选中的不是小浣熊时按钮降透明度 + 详情面板加一行 `pillOtherModel` 解释"余额与所选模型无关"。
- `status.pool.accounts[].device` 曾显示成 `raccoon-`（`slice(0,8)` 把前缀整个吃掉）→ 改成先 `replace(/^raccoon-/, "")` 再截 8 位。
- `readToken()` 从磁盘读回时漏展开 `source` → 永远是 `undefined`。
- `pool-toggle` 写盘失败时未回滚内存 → 界面显示已启用、重启后又变回未启用。

### 已知限制

- 桌面端凭据路线依赖一个不受我们控制的文件路径。客户端升级改了目录就得跟着改
  （所以候选路径是六条枚举 + `BOX_AGENT_CONFIG_DIR` / `BOX_AGENT_HOME` 优先，不是硬编码一条）。
- 桌面端凭据过期（IAM JWT `exp` 到点）后**不做自动续期**。E-037 四轮实测确认了 refresh 端点的
  body 字段名是 `token`，但它的格式校验猜不出来，而且 refresh 会 rotate —— 一 rotate 就把用户正开着的
  官方客户端踢下线。所以选择"提示用户打开客户端刷新一次"，见 E-037。
- "退出登录"在桌面端来源下只表示"本会话不再自动读取"，**不会删除客户端的 `auth.json`**。
- 扫码路线需要人工确认一次，无法无人值守部署。
- ~~每日积分只读不代领~~ —— **已实现签到**。原判断"上游没有独立签到接口"被 E-036 推翻
  （`POST /api/web/desktop/v1/login/points/grant` 实测 200）。现在"一键签到"是用户显式点的动作，
  插件不会在后台替任何账号领取。
- 号池的签到写接口**只验过"今日已领"分支**（返回 `granted:false`），没验过真的领到（要等次日北京零点后）。
- 号池的"独立环境"是**每账号一个独立 `X-Client-Device-ID`**，不是设备指纹伪造 —— 它只让上游看到
  "这是另一台设备上的登录"，**不承诺防封**。
- 识图：`data:image/...;base64,` 与公网 URL **两条路都通**（E-018 实测）。但公网图链的成败取决于
  "小浣熊服务器能不能下载到那个站"，google / wikimedia 在我们这里就下不到（`image download failed`）。
- 请求体硬上限约 **3.0001 MiB**（E-019），超限回 **400 `inference request is invalid` 而不是 413**。
  多张大图会先撞体积而不是撞 token。
