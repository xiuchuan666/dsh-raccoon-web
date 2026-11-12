# 更新日志

本项目遵循「每个版本都写清实测更新」的规矩：**只要网关行为变了，就单独记一条**，
不能混进「修复」里 —— 因为那不是我们的 bug，是上游改了。

## 0.2.1（2026-11-12）

修用户报的三个 bug（换号后旧号消失、客户端退出后 401、扫码加号收不到登录），
其中第三个的根因是**上游把 `/login/mp` 这个页面下线了**，于是加号主路线整体换到浏览器 loopback。

### 新增

- **浏览器 loopback 加号**（[ADR-0012](../../docs/02-design/adr/0012-browser-loopback-login.md)）。
  新增 `src/protocol/loopback.ts`：本机 `127.0.0.1` 起一次性回调服务（随机端口、`state` 64 hex、
  `timingSafeEqual` 比对、只接受 `GET` + `/auth/callback`、5 分钟超时、`closeAllConnections()`），
  打开 `https://xiaohuanxiong.com/authorize?...&desktop_callback=loopback&redirect=...&state=...`，
  用户登录完由浏览器跳回本机，拿到 `code` 后用 `POST /api/web/auth/v1/login_with_authorization_code`
  换成 token 直接进池。**这就是官方桌面端换账号时走的那条路。**
- 新增两个 action：`pool-add-browser` / `pool-add-browser-cancel`；`status` 新增 `browser` 块
  （`{ active, url?, port?, startedAt?, message? }`，**不含 code、不含 token**）。
- 设置卡「账号池」多一个「浏览器登录」按钮与等待卡片；新增 6 条文案键（zh/en 各 124 键，其中 `pool*` 35 个）。
- `source` 从 `"qr" | "desktop"` 扩成 `"qr" | "desktop" | "browser"`（`PoolAccount` / `StoredToken` / status / routes）。
- 登录状态新增诊断字段 `login.lastPoll` / `login.lastPollAt`（`pending` / `logging` / `canceled` / `error:<原文>`），
  界面上以「最近一次轮询：…」显示。**扫了没反应时这是唯一能区分原因的证据。**
- `packages/dsh-raccoon-web/test/loopback.test.ts`（**LB-1 ~ LB-35**，5 suite）：`authorizeUrl` 参数顺序、
  `parseCallback` 的 14 条拒收 reason、`exchangeCode` 的三种结果、`startLoopback` 真起服务打自己的回调。

### 修复

- **换号后池里旧账号消失。** 根因是 `writePool()` 是**整表原子写**，而 `this.accounts` 只是内存快照；
  内存比磁盘旧时（别处写过 / 上次写失败 / 用户手改文件）直接写就把磁盘上多出来的账号抹掉了。
  新增 `mergePools(memory, disk)`（同 id 以内存为准，磁盘独有的追加）与 `Host.savePool()`
  （先合并再整表写），`addPoolAccount` / `pool-toggle` / `pool-test` 全部改走它；
  `pool-remove` **刻意不合并**（合并会把刚删的号又并回来）。`recordMeasure()` 保留裸写并注明理由。
- **客户端退出登录后插件仍用内存里的旧 token，报「API 密钥无效」。** `refreshCatalog()` 拿到 401
  直接 `markDead()`，而用户其实刚在客户端换了号、`auth.json` 里已经是新 token。
  新增 `rereadDesktopAuth()`：判死之前先重读一次桌面端凭据，**token 字符串变了就换掉并继续**
  （判据是 token 不是 principal —— 同账号重登也会换新 token）。
- **`canceled` 被当成"用户取消"收尾。** 官方网页端对 `canceled` 是 `return void c()` —— 立刻换一张新码。
  我们原来把 `phase` 打成 `none`，用户手机上点一下取消，界面就留一张作废的码。
  现在 `LoginFlow.reissue()` 自动换码并提示「二维码已刷新，请重新扫码。」，
  上限 `MAX_REISSUES = 3`（超了收尾成「二维码反复失效，请重新获取。」，避免 2 秒一次的请求风暴）。
  同时 `start()` 拆成 `start()`（重置计数）+ `beginRound()`（不改计数），否则上限永远触发不了。
- **`expired_at` 没被采纳。** 服务端在 `logging` 时第一次给出 `expired_at`，官方就在那一刻记下来。
  新增 `applyServerDeadline()` 把 `deadline` 校正到 `min(服务端, LOGIN_TIMEOUT_MS)`。
- **`upsertAccount()` 的 `source` 永远保留第一次的来源。** 同一个号先扫码进来、后来用桌面端凭据导入，
  标成 `qr` 会误导排障。改成跟最后一次来源走。
- `client.js` 的 `PoolSection` 在浏览器登录进行中时禁用「浏览器登录」按钮，避免起第二个回调服务。
- **一键签到的逐号结果从来没显示出来。** 宿主一直在 `results` 里返回
  `{ id, result: "already"|"granted"|"error", message? }`，但 `PoolSection` 只把它丢掉了 ——
  用户点完按钮看到的就是"转两秒然后什么都没变"。现在每个账号卡片上多一行结果
  （绿：已签到 / 今日已签；红：签到失败 · 上游原文第一行），新一轮开始前清掉上一轮。
- **签到失败不记测量状态。** `actionPoolCheckin()` 只把失败塞进 `results`，不动 `measure` ——
  一个凭据已经废掉的号会继续显示「可用」并继续被选去服务。签到是**用户主动**发起的、
  每天一次的动作，它拿到的失败信号比对话中途的 `onResponse` 更可信，所以现在也走
  `classifyMeasure()` + `shouldPersistMeasure()`：`AUTH` → `dead`、限流 → `limited`、
  超时/网络 → `flaky`、余额不足 → `empty`，HTTP 400 之类与账号无关的仍然不记。
  写盘走 `savePool()`（合并后整表写），失败不影响结果展示。
  新增常量 `ACCOUNT_KINDS`（`RaccoonErrorKind` → `MeasureInput.kind` 的映射）：
  `INVALID_REQUEST` / `ABORTED` 在测量词表里没有对应项 —— 它们说明请求本身不成立，
  换一个号也一样失败，记成冷却只会白躺一个好号。
- **`dead` 状态的说明文案写死了"需要重新扫码"。** 号池成员的来源有三种（`qr` / `desktop` / `browser`），
  只有一种能靠扫码恢复；桌面端凭据过期的人看到这句会被引导到一条走不通的路上。
  改成来源中性的「登录已失效，需要重新登录这个账号」。

### 适配网关（E-040 实测）

- **`GET /login/mp?code=...` 这个页面在服务端已经不存在了。** 11 组 UA / header 组合（微信 iPhone、
  微信 Windows、Chrome 131、`curl/8.0`、无 UA、`x-requested-with: com.tencent.mm`、`referer: servicewechat.com`、
  完整 `sec-fetch-*`）**全部 404**；带 `_rsc=1` 时返回的 RSC 流里明确是
  `404: This page could not be found.`（`notFound`）。`/login/mp/` 是 308、`/login/mp` 无参是 404，
  而 `/login` 是 200 —— 坐实**路由下线**，不是鉴权或 UA 问题。
- **`POST /api/web/auth/v1/login_with_qrcode_code` 对任何 body 恒回 `pending`**：正常 code、
  `registration_attribution: ""` / `"test"`、时间戳 ±1 小时、`qrcode_code: "abc"`、**`{}` 空对象**
  全部 `200 {"code":0,"data":{"status":"pending"}}`。**没有任何"码未注册"的信号** —— 所以
  `qrProtocol: "web"` 现在扫一百次也不会成功，微信端只会显示「二维码已过期或已被使用」。
- **`/authorize` 与换码端点都活着**：`GET /authorize?login_source=desktop&appname=商汤小浣熊客户端&
  desktop_callback=loopback&...` → 200 / 32175 字节（标题「客户端授权 | 商汤小浣熊」）；
  `POST /api/web/auth/v1/login_with_authorization_code` 对假 code → `400 code:200035
  authorization_code_not_found_error`（**它真的在校验**）。
- 扫码那条**不删**：`qrProtocol: "iam"` 是另一套命名空间（`appname=商汤小浣熊`、`code` 形如 `qr-...`），
  不受 `/login/mp` 下线影响，是唯一还能被微信小程序认的。

### 测试

- `263 tests / 52 suites / 263 pass / 0 fail`（0.2.0 时是 220 / 45）。
  新增 `test/loopback.test.ts` LB-1~LB-35；`test/pool.test.ts` 补 PO-32b / PO-41~PO-43（`mergePools` 三条 +
  `source` 跟最后一次来源）；`test/host.test.ts` 补 ST-28（换码上限与 `mode` 保持）、ST-29（`deadline` 校正）、
  ST-30（`lastPoll` 生命周期）；`test/web-auth.test.ts` 补 WA-10b，WA-10/WA-11 改成顶层 `access_token` 主形状。
- `scripts/smoke-pool.mjs` 补三条（79 → **82 条**）：凭据失效的号在签到结果里是 `error`、
  签到失败也落成 `measure.state === "dead"`、签到写盘没有抹掉别的号（合并后仍 3 条）。
  为此让假网关的 `/login/points/grant` 对 `DEAD` 回 401 —— 否则"签到拿到账号级失败"这条路测不到。
- 真宿主实测（端口 52091，`build 2026-11-12T02:05`）：`pool-add-browser` 起服务 + 返回 `/authorize` URL；
  错 `state` → 400 且不打换码端点；错路径 → 400；合法 state + 假 code → 502 且页面是
  `authorization_code_not_found_error`；`pool.total` 未被污染；`pool-checkin` 对真网关跑出
  `error`（`200003 authorization_verify_error`）+ `already` 两行，且失败号被标成 `dead`。

### 已知限制

- **浏览器登录的"真的登进去"这一段没人跑过**：验过起服务、URL 形状、三条拒收判据、换码端点的错误分支，
  但"用户在浏览器里真的登录 → 回调带回真 code → 换到真 token → 进池"整段未实测。
- 扫码登录（协议 A / IAM）从没被真人用手机扫过一次。
- 一键签到的 `granted: true` 分支未实测（只验过当日已领时的 `granted: false`）。

---

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

- `263 tests / 52 suites / 263 pass`（0.1.0 时是 168；2026-11-12 加 `test/loopback.test.ts` LB-1~LB-35）。新增 `test/pool.test.ts`（PO-1~PO-40）
  与 `scripts/smoke-pool.mjs`（**13 段 82 条断言**，真 `RaccoonHost` + 假网关）；
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
