# 测试计划

最后更新: 2026-11-11
状态: 已定稿

> 这个项目的测试分三层：**不依赖宿主**的协议层单测、**mock 内核**的宿主层单测、**必须真人参与**的端到端验证。
> 第三层是这个项目的主要风险来源 —— 它无法自动化（要用手机微信扫码），所以必须写成"可复述的步骤"，让人照着做。

**当前实测数字（2026-11-11）**：**220 tests / 45 suites / 220 pass / 0 fail**，7 个测试文件，纯 `node --test`，无 vitest / jest。

| 文件 | tests | suites | suite 名 |
| --- | --- | --- | --- |
| `test/catalog.test.ts` | 22 | 4 | `parseCatalog` / `normalizeModel` / `fetchCatalog` / `积分` |
| `test/chat.test.ts` | 51 | 5 | `parseFrame` / `applyThinking` / `buildBody` / `sessionIdFor·principalOf` / `chatStream` |
| `test/host.test.ts` | 33 | 10 | `normalizeSettings` / `createTtlCache` / `Publisher` / `isLoopback` / `loginBlock` / `LoginFlow 的 mode 生命周期` / `日志脱敏` / `solidPng` / `buildDiagnostics` / `store 落盘` |
| `test/iam.test.ts` | 40 | 7 | `createQr` / `assertScanPath` / `qrContent` / `pollQr` / `cookieValue` / `confirmSession` / `validateToken` |
| `test/pool.test.ts` | 40 | 11 | PO-1 ~ PO-40 |
| `test/qr.test.ts` | 15 | 3 | `pickVersion` / `encodeQr` / `renderQrSvg` |
| `test/web-auth.test.ts` | 19 | 5 | `generateWebCode` / `isWebCode` / `createWebSession` / `webQrContent` / `pollWebSession` |
| **合计** | **220** | **45** | |

---

## 0. 测试命令

```bash
npm run typecheck                  # tsc --noEmit
npm run build                      # tsup（验证 splitting:false 生效）+ copy-client
npm test                           # 220 个用例
node scripts/verify-install.mjs    # 24 项静态检查（装得上、能解析、版本一致）
node scripts/smoke-host.mjs        # 宿主半身（假 ctx，不碰网络）
node scripts/smoke-provider.mjs    # provider 装配 + 换名册必须换实例
node scripts/smoke-pool.mjs        # 号池（真 RaccoonHost + 假网关，41 条断言）
node scripts/smoke-client-apply.mjs          # 离线跑 client.js 的 apply
node scripts/smoke-client-apply.mjs --twice  # 模拟同一包被加载两次
node scripts/smoke-desktop-auth.mjs          # 桌面端凭据路线
node scripts/smoke-chat-live.mjs             # 真对话（花积分）
```

单测用 `node --test`（Node 24 内置），不引 vitest / jest —— 理由见 [06-coding-conventions](../02-design/06-coding-conventions.md)。

**跑法有两个坑**（都踩过）：

1. 必须带 `--experimental-strip-types --import ./scripts/test-resolve-register.mjs`（把 `./x.js` 映射到 `x.ts`），否则 TS 源码 import 不到。
2. **构建必须 `cd packages/dsh-raccoon-web` 再跑** `node ../../node_modules/tsup/dist/cli-default.js --config tsup.config.ts`。在根目录跑报 `Cannot find index: src/index.ts`；用 `node_modules/.bin/tsup` 报 `SyntaxError`（那是 bash shim）。

---

## 1. 协议层单测（不需要 DSH、不需要网络）

**关键前提**：`src/protocol/` 只依赖 `node:*` 与相对路径，所以可以**脱离 DSH 直接跑**。
这是 [ADR-0004](../02-design/adr/0004-protocol-adapter-split.md) 的直接收益 —— 内核包从 `~/.dsh/profiles/desktop` 根本 import 不到（E-008），如果不分层，这一层根本没法测。

### 1.1 二维码（`test/protocol/qr.test.ts`）

| # | 用例 | 断言 |
| --- | --- | --- |
| QR-1 | `pickVersion(149)` | 返回 `8` |
| QR-2 | `pickVersion(122)` | 返回 `7` |
| QR-3 | `pickVersion(213)` | 返回 `10` |
| QR-4 | `pickVersion(214)` | 抛错（超出容量） |
| QR-5 | 版本 8 的矩阵尺寸 | `4 * 8 + 17 = 49` |
| QR-6 | 三个定位图案中心 | `(3,3)` `(3,46)` `(46,3)` 处全暗 |
| QR-7 | 版本信息块存在 | 右上 `(43..45, 0..5)` 与左下 `(0..5, 43..45)` 非空 |
| QR-8 | 时序图案交替 | `(6,8)` 暗、`(6,9)` 亮 |
| QR-9 | 暗模块 | `(4*8+9, 8) = (41,8)` 为暗 |
| QR-10 | 格式信息两处 | `(8, 0..8)` 与 `(0..8, 8)` 都非空 |
| QR-11 | `renderSvg` 输出 | 以 `<svg` 开头、含 `viewBox`、`<path` 非空 |
| QR-12 | **编码后再解码** | 用独立实现的解码器（或在线工具）解出原文（**手工一次性验证，不纳入 CI**） |

> QR-12 是唯一能真正验证"扫得出来"的自动化手段，但引入解码器就违背零依赖。**妥协**：M1 完成标准要求用手机实扫一次，把结果记进 `05-empirical-findings.md` 作为 E-0xx。之后回归只跑 QR-1~QR-11。

### 1.2 登录（`test/protocol/iam.test.ts`）

| # | 用例 | 断言 |
| --- | --- | --- |
| IAM-1 | `createQr` 正常响应 | 返回 `{code, scanPath, expiresIn, pollInterval}` |
| IAM-2 | 缺 `qrcode_code` | `RaccoonError.kind === "INVALID_RESPONSE"` |
| IAM-3 | `expires_in = 0` | 抛 |
| IAM-4 | `expires_in = 7200`（>3600） | 抛 |
| IAM-5 | `assertScanPath("/login/mp")` | 通过 |
| IAM-6 | `assertScanPath("//evil.com/x")` | 抛 |
| IAM-7 | `assertScanPath("/a b")` | 抛（含空格） |
| IAM-8 | `assertScanPath("/x#y")` | 抛（含 hash） |
| IAM-9 | `qrContent({code:"qr-1", scanPath:"/login/mp"})` | `https://xiaohuanxiong.com/login/mp?code=qr-1&appname=...&source=platform` |
| IAM-10 | `pollQr` → `pending` | 原样返回 |
| IAM-11 | `pollQr` → `logging` | 原样返回 |
| IAM-12 | `pollQr` → `success` + `access_token` | 返回 `accessToken` |
| IAM-13 | `pollQr` → `success` 但 `token_type: "mac"` | 抛 `INVALID_RESPONSE` |
| IAM-14 | `pollQr` 抛 `NETWORK_ERROR` | **返回 `status:"pending"`**（不杀登录） |
| IAM-15 | `pollQr` 抛 `TIMEOUT` | 同上 |
| IAM-16 | `pollQr` → `AUTH_QRCODE_EXPIRED` | `status:"expired"` |
| IAM-17 | `pollQr` → `AUTH_QRCODE_NOT_FOUND` | `status:"expired"` |
| IAM-18 | `cookieValue("xhx_token=abc; Path=/")` | `"abc"` |
| IAM-19 | `cookieValue("a=b; xhx_token=x%20y")` | `"x y"`（decodeURIComponent） |
| IAM-20 | `confirmSession` 无 `Set-Cookie` | 返回 `undefined`，**不抛** |
| IAM-21 | `jwtClaims("not.a.jwt")` | 返回 `undefined`，不抛 |
| IAM-22 | `jwtClaims(真 token)` | `{sub, exp, ...}` |

IAM-14/15 是这个项目最容易写错的两条 —— 顺手写 `throw` 就把"网络抖动"升级成"登录失败"。

### 1.3 对话与帧解析（`test/protocol/chat.test.ts`）

| # | 用例 | 断言 |
| --- | --- | --- |
| CH-1 | `parseFrame(': keep-alive')` | `null`（忽略注释行） |
| CH-2 | `parseFrame('data: [DONE]')` | `{kind:"done"}` |
| CH-3 | `parseFrame('data: {"choices":[{"delta":{"content":"你"}}]}')` | `{kind:"text", text:"你"}` |
| CH-4 | `parseFrame(...reasoning_content)` | `{kind:"reasoning", text:"..."}` |
| CH-5 | `parseFrame(...tool_calls)` | `{kind:"tool", ...}` |
| CH-6 | `parseFrame('data: {"error":{"message":"boom"}}')` | 抛（SERVER） |
| CH-7 | `parseFrame('data: {"code":200429,"message":"慢点"}')` | 抛（RATE_LIMIT） |
| CH-8 | `parseFrame('data: {"choices":[]}')` | `null`（空 choices 忽略） |
| CH-9 | `parseFrame('garbage')` | `null`（**不抛** —— 不能因为一行不认识就断流） |
| CH-10 | `parseFrame` 被拆成两段喂 | 正确拼回（行缓冲） |
| CH-11 | `isRateLimited(429, "")` | `true` |
| CH-12 | `isRateLimited(200, "user_model_rate_limited")` | `true` |
| CH-13 | `isRateLimited(200, "频率超限")` | `true` |
| CH-14 | `isRateLimited(200, "ok")` | `false` |
| CH-15 | `sessionId("u1", "m1")` 两次调用 | 相同 |
| CH-16 | `sessionId("u1", "m1")` vs `("u1","m2")` | 不同 |
| CH-17 | `sessionId` 格式 | `/^sess-0-[0-9a-f]{8}$/` |
| CH-18 | `applyThinking(body, "off")` | `body.extra_body.thinking.type === "disabled"` |
| CH-19 | `applyThinking(body, "none")` | 同上 + `body.reasoning_effort === "none"` |
| CH-20 | `applyThinking(body, "high")` | `enabled` + `reasoning_effort === "high"` |
| CH-21 | `applyThinking(body, "on")` | `enabled`，**无** `reasoning_effort` |

CH-9 很重要：网关偶尔会发心跳或厂商私有帧，一行解析失败就断流是最常见的"用着用着断了"。

### 1.4 目录与积分（`test/protocol/catalog.test.ts`）

| # | 用例 | 断言 |
| --- | --- | --- |
| CAT-1 | 标准 `data.categories` | 展开成模型列表 |
| CAT-2 | 嵌套两层（category → models） | 展开 |
| CAT-3 | `context_window` / `contextWindow` / `max_context_length` 三种键名 | 都能读到 |
| CAT-4 | 缺 `id` 的条目 | 跳过，不抛 |
| CAT-5 | `multiplier` 缺失 | `undefined`，显示名不加后缀 |
| CAT-6 | 空目录 | 抛（"模型目录为空"） |
| PT-1 | `balance` 各字段名（5 种） | 都能读出 `available` |
| PT-2 | `raccoonDay("2026-11-06T15:59:00Z")` | `"2026-11-06"`（北京 23:59） |
| PT-3 | `raccoonDay("2026-11-06T16:01:00Z")` | `"2026-11-07"`（北京次日 00:01） |
| PT-4 | `todayGranted(bills, now)` 有当日 `daily_grant` | `true` |
| PT-5 | 只有昨日 `daily_grant` | `false` |

PT-2/PT-3 用 UTC 时刻跨北京零点，是时区 bug 的唯一可靠检测方式。

---

## 2. 宿主层单测（mock ctx）

### 2.1 mock ctx 的形状

```ts
function makeCtx(home: string) {
  const effects: Array<() => void> = [];
  const routes = new Map<string, Handler>();
  const adapters: any[] = [];
  return {
    ctx: {
      logger: () => ({ info(){}, warn(){}, error(){}, debug(){} }),
      effect(fn: () => void) { effects.push(fn); return () => {}; },
      inject(_deps: string[], fn: (c: any) => void) { fn(fakeCtx); },
      profile: { home },
      llm: { registerAdapter(p: string[], a: any) { adapters.push({p, a}); return Object.assign(() => {}, {replace(){}}); } },
      webServer: { register(r: any) { routes.set(r.path, r.handler); return () => routes.delete(r.path); } },
    },
    effects, routes, adapters,
  };
}
```

### 2.2 用例

| # | 用例 | 断言 |
| --- | --- | --- |
| ST-1 | `writeToken` 后 `readToken` | 相等 |
| ST-2 | `readToken` 文件不存在 | `undefined`，不抛 |
| ST-3 | `readToken` 文件是 `{garbage` | `undefined`，不抛 |
| ST-4 | `readToken` `schemaVersion: 2` | `undefined`（不迁移） |
| ST-5 | `writeToken` 原子性 | `.tmp` 不存在于最终目录 |
| ST-6 | `profileHome` 三级兜底 | 三个都缺时落到 `~/.dsh/profiles/desktop` |
| ST-7 | `publish` 开关关 | `adapters.length === 0` |
| ST-8 | `publish` 开关开无 token | `adapters.length === 0` + `error === "not_configured"` |
| ST-9 | `publish` 开关开有 token | `adapters.length === 1` |
| ST-10 | 连续 `publish` 两次 | 第二次 `replace` 而非 `register`（不触发 `DUPLICATE_ADAPTER`） |
| ST-11 | `dispose` 后 `publish` | 不再注册 |
| ST-12 | `isLoopback("127.0.0.1:57292")` | `true` |
| ST-13 | `isLoopback("localhost:1")` | `true` |
| ST-14 | `isLoopback("[::1]:1")` | `true` |
| ST-15 | `isLoopback("evil.com")` | `false` |
| ST-16 | `readRequestBody` 超 65536 | 截断/抛（按实现） |
| ST-17 | `login-start` 连点两次 | 第二次返回同一个二维码（不重复取码） |
| ST-18 | `login-cancel` 后 `login-poll` | 返回 `{phase:"none"}` |

ST-10 是最容易踩的坑：`registerAdapter` 重复注册会抛 `DUPLICATE_ADAPTER`，而影响整个插件加载。

**2026-11-11 实际落地是 33 条**（上表是初版设计）。多出来的 15 条里，最值得记住的几条：

| # | 用例 | 为什么加 |
| --- | --- | --- |
| ST-18b | `loginBlock` 透传 `mode`，没有就不凭空造 | 前端靠它认领"这张二维码是不是我的" |
| ST-18c | `LoginFlow` 的 `mode` 生命周期：`start('pool')` → `pool`，`cancel`/`markReady`/`markDead` → `primary` | 两个扫码入口共用一个 `LoginFlow`，`mode` 不收回默认值会让池区一直以为有码在等 |
| ST-19 | `normalizeSettings` 的键集合 == 八个（含 `poolEnabled`） | 加号池第八键时这条先红，提醒"默认值也要加" |
| ST-20 | `poolEnabled` 默认 `false` | ADR-0010 的硬约束：自动换号不能默认开 |
| ST-21 | `Publisher` 换名册必须换实例（`handle.replace` 零调用） | 内核 `replace()` 返回 void 且换不掉实例，只能"先释放再注册" |
| ST-22 | `Publisher` 指纹含 `dev:<deviceId>` | 换账号必须触发重新注册，否则设备身份换了名册没换 |
| ST-23 | 日志里不出现 `eyJ`（JWT 前缀） | token 永远不进日志 |
| ST-24 | `buildDiagnostics` 输出 14 行 | 13 → 14 行是加号池那行 |
| ST-25 | 诊断含 `来源: 扫码` / `桌面端: 未读到` / `扫码协议: …` | 少一个字段就少一行，肉眼难发现 |
| ST-25b | 诊断末行 `号池: …` 五种形态 | 池空 / 有号未启用 / 开但空 / 开但零启用 / 开且有当前号 |
| ST-25c | 诊断行数严格 `=== 14` | 防"加了一行忘了改断言" |

### 2.3 号池单测（`test/pool.test.ts`，PO-1 ~ PO-40）

11 个 suite，覆盖 `src/host/pool.ts` 里不碰 IO 的那一半 + 一条落盘往返。四条最容易写错的：

- **PO-7**：`sortForUse` 里 **daily 降序必须压过 available 降序**。workbuddy 的 issue #70 就是这个：它把"快过期先花"排在"余额高"后面做严格字典序，结果那条规则**从未生效**，真实病例是 196.4 分当天作废。夹具：`aaa` daily 10 / available 50000 vs `zzz` daily 200 / available 200 → 断言 `zzz` 在前。
- **PO-17**：`classifyMeasure` 里 `status 200 + body 含 200429` **仍算 ok**（200 分支先命中）。写成"body 含 200429 就算 limited"会把正常响应误判成限流。
- **PO-26**：`nextRaccoonMidnight` 用固定 `+08:00` 偏移反推，北京 2026-11-11 10:00 → ISO `2026-11-11T16:00:00.000Z`。不能用 `Intl` 或本地时区，否则测试在别的机器上会飘。
- **PO-36 ~ PO-40**：`shouldPersistMeasure()` 的去抖规则。最关键的是 PO-37（`ok` → `ok` **不写盘**）与 PO-40（只比 `state` 不比 `at` —— `at` 每次都变，拿它比较等于没比较）。PO-38 / PO-39 保证"解除冷却"与"进入冷却"这两个方向的写盘永远不会被漏掉。

### 2.4 对话错误分类（`test/chat.test.ts`，CH-37a ~ CH-37f + CH-44 / CH-45）

这六条是 E-018 / E-019 实测之后补的，专门防"把参数错误说成体积超限"：

| # | 用例 | 断言 |
| --- | --- | --- |
| CH-37a | 400 `inference request is invalid` + 大请求体 | `INVALID_REQUEST` + 附体积提示 |
| CH-37b | 同一条 message 但请求体很小 | **不给**体积提示（退化成"参数"） |
| CH-37c | 400 `image download failed` | 提示含"没能下载到"，**不含"不支持"** |
| CH-37d | 400 `invalid image base64 content` | 同 CH-37c 归类 |
| CH-37e | 3 MB 请求体 | message 含真实字节数 + userText 含 "3 MiB" |
| CH-37f | 请求体只 `JSON.stringify` 一次 | 计数断言（避免字节数与 body 不同源） |
| CH-44 | 401 → `HINTS.AUTH` | userText **同时**含"官方客户端"与"扫码"（2026-11-11 前只写扫码，对桌面端用户是错的引导） |
| CH-45 | 遍历整张 `HINTS` 表 | **没有一条文案命中** `401/403`、`429`、`5xx`、`timeout`、`rate limit` —— 这些字样会被 `classifyPiAiError()` 重新归类，用户看到的类别就与真实原因不符 |

---

## 3. 端到端验证（必须真手机）

这一层不能自动化。写成**可复述的步骤 + 明确的判定标准**，每次发版前手工跑一遍。

> **2026-11-11 状态**：3.1 / 3.3 / 3.4 / 3.5 里除扫码外的部分**已用桌面端凭据路线实机跑过**（真宿主端口 52091，`login.source:"desktop"`、6 模型、真对话首字节 1637ms、余额 11682）。**3.2 扫码与 3.6 号池扫码添加仍然一次都没被真人扫过。**

### 3.1 E2E-1 首次安装

```
前置：DSH 里没有 raccoon 条目
1.  node scripts/link.mjs        # 幂等：profile package.json / bundles / patch / 符号链接四处
2.  node scripts/revive.mjs      # 换 ?v= 让运行中的宿主重新 import
判定：
  ✅ GET /plugins/dsh-raccoon-web/status 返回 200
  ✅ 设置对话框左侧菜单出现「小浣熊」（走 settings.section，order 95）
  ✅ 输入框左侧出现 🦝 药丸（**总是显示**，选别的模型时半透明并多一行说明）
  ✅ 诊断块 14 行，末行是「号池: …」
  ❌ 任何红字 / 卡片空白 → 先跑 npm run smoke:client:twice（能复现 locale 重复注册）
```

**为什么先看 status 端点而不是看界面**：界面空白有五种可能（包没加载 / `apply` 抛错 / slot 没注册 / client.js 是缓存的旧版 / 端口不对），而 status 端点 200 能一次排掉前四种。

### 3.2 E2E-2 扫码登录（**至今未人工验证**）

```
1.  设置卡 → 登录区 → 协议选「Web auth（官方客户端同款）」
2.  点「扫码登录」→ 手机微信扫
3.  手机上点「确认登录」
判定：
  ✅ 3 秒内二维码出现，且手机能扫出内容
  ✅ 扫码后手机显示确认页（而不是空白页）
  ✅ 确认后 5 秒内界面变「已登录 · <昵称>」
  ✅ token.json 存在且 principal 非空
  ✅ 模型选择器出现「小浣熊」分组
```

**扫码这里要额外验证一件事**：用手机扫出来的 URL 应当是

```
https://xiaohuanxiong.com/login/mp?code=<13位时间戳+32hex>&appname=%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91
```

（Web auth 协议，`appname` 是「小浣熊官网」，code 45 字符、本地生成。若切 IAM 协议则是 `code=qr-...`、`appname=商汤小浣熊`、`source=platform`。）

如果 URL 少了 `appname`，微信端会打开一个空白页 —— 这是 QR 编码器"内容正确但编码错"的典型症状，**必须肉眼对一次**。已用 OpenCV 双检测器离线验证过 139 / 149 字节两种内容都能正确解出（见 [E-033](../01-research/05-empirical-findings.md)），但"能解出"不等于"微信认"。

**踩过的坑（E-029）**：二维码刚生成就显示"已过期"，原因不是码坏了，而是**贴码之后又跑了一次 `login-start`** —— `LoginFlow.start()` 是先 `cancel()` 再取码，新码生成即作废旧码。所以观察只能用 `--wait-only`，任何会触发 `login-start` 的动作都不能在贴码之后做。

### 3.3 E2E-3 对话（**已实机通过**）

```
1.  选一个模型（先用 sn-sensenova-6-8-flash，最便宜）
2.  发「用一句话解释什么是进程」
判定：
  ✅ 文字逐字出现（不是一次性出现）
  ✅ 计时：首字 < 3 秒（实测 1637ms / 3107ms / 3423ms / 4517ms 四次）
3.  再发「刚才那句话里的关键词是什么」
判定：
  ✅ 能引用第一轮内容（上下文通了）
4.  发一个需要推理的问题（如「9.9 和 9.11 哪个大，逐步推理」）
判定：
  ✅ 思考区出现推理内容（实测 324 / 336 / 379 字）
5.  中途点「停止」
判定：
  ✅ 立刻停，不报错，已输出内容保留
```

### 3.4 E2E-4 失败路径

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 登录失效 | 手工把 `token.json` 的 `token` 改成 `xxx` | 发消息 → 明确提示"登录已失效，请重新扫码"，**不是** "未知错误"。**桌面端来源**（改坏 `auth.json`）提示的是"客户端凭据已失效，请打开官方客户端重新登录" —— 按来源分岔，2026-11-11 起 |
| 限流 | 连续发 20 条长上下文 | 提示吞吐上限的长文案，**不是** 500 |
| 断网 | 禁用网卡 → 发消息 | `TRANSPORT` 文案（"网络连接中断"） |
| 大图 | 发一张 4000×3000 的图 | 要么自动缩到预算内，要么明确提示"图片过大" |
| **请求体超 3 MiB** | 一次带四五张大图 | 提示"请求体超过了上游约 3 MiB 的上限"，**不是**"参数错误"（E-019） |
| **图片 URL 下不到** | 发一个国内访问不了的图片链接 | 提示"小浣熊的服务器没能下载到这张图"，**不是**"不支持图片"（E-018） |
| 卸载中途 | 对话进行中 `unlink` | 不崩溃，日志有 `disposed` |

### 3.5 E2E-5 持久化与卸载

```
1.  登录后重启 DSH
判定：✅ 仍是已登录，模型还在（token 持久化生效）
2.  点「退出登录」
判定：✅ 界面变未登录，模型从选择器消失，token.json 被删
3.  node scripts/unlink.mjs → 重启 DSH
判定：✅ 卡片消失，无 409 路由冲突，日志无 [raccoon-web]
```

**桌面端凭据路线的"退出登录"语义不同**：它只是本会话不再读那个文件，不会去删官方客户端的 `auth.json`（那是客户端的资产）。重启后又会读到 —— 这是设计如此，不是 bug。

### 3.6 E2E-6 账号池（**部分实机通过**）

```
1.  设置卡 → 账号池 → 点「导入客户端账号」
判定：✅ 列表出现 1 个号，enabled=false，设备标识是 8 位十六进制（不是 "raccoon-"）
2.  点该号的「测试」
判定：✅ 变「可用 · 正常」（打 model_catalog，零 token 成本）
3.  勾选该号
判定：✅ 出现「当前使用」标记，诊断末行变「号池: 开（1 个启用，当前 xxxxxxxx）」
4.  打开「自动换号」
判定：✅ status.pool.activeId 非空，publish 仍 published
5.  点「一键签到」
判定：✅ 每行一个结果（已签到 / 今日已签 / 失败），单个失败不中断
6.  点「扫码添加」→ 手机扫
判定：✅ 新号默认 enabled=false；**主登录相位不变**、token.json 不被写
7.  移除一个号
判定：✅ 两段式确认（点一次变「确认移除」，再点才删）
```

**3.6 的第 5、6 步至今没跑过**（当日已领、需真人扫码）。第 7 步也没在真宿主上跑过（只在 `smoke-pool.mjs` 里跑过）。

---

## 4. 非功能验证

| 项 | 方法 | 标准 | 2026-11-11 实测 |
| --- | --- | --- | --- |
| 启动开销 | `apply` 到 `loaded` 的毫秒数 | < 50ms（apply 里不做网络请求） | ✅ `apply` 同步、网络在 `void bootstrap()` 里 |
| 内存 | 任务管理器看宿主进程 | 增量 < 20MB | ✅ 未做量化，`lib/index.js` 145 KB 是唯一常驻 |
| token 泄露（日志） | `grep -rE "eyJ|Bearer [A-Za-z0-9]" <日志目录>` | 0 命中 | ✅ 单测 ST-23 断言 + `tokenTag()` 只输出 `sha256` 前 8 位 |
| token 泄露（status） | `curl <PORT>/plugins/dsh-raccoon-web/status` | 响应里**没有** token 原文、没有 deviceId 全文 | ✅ `smoke-pool.mjs` 第 8 段断言 |
| 构建产物 | `ls lib/` | 只有 `index.js` + `client.js`（**无 chunk**） | ✅ `verify-install` 第 7 项 |
| 依赖 | `npm ls --omit=dev` | 0 个运行时依赖 | ✅ `verify-install` 第 6 项 |
| 路由冲突 | 重复 link 两次 | 不报 409 | ✅ `link.mjs` 幂等，四步全命中「已就绪」 |
| 版本/构建一致性 | `node scripts/verify-install.mjs` | 24/24 | ✅ 见 §0 那三条新增检查 |

---

## 5. 回归时机

| 时机 | 跑哪一层 |
| --- | --- |
| 每次改 `src/protocol/` | §1 全跑（7 个 test 文件里 5 个受影响） |
| 每次改 `src/host/` | §2 全跑 + `smoke-host` / `smoke-pool` |
| 每次改 `client.js` | **`npm run smoke:client:twice`**（离线复现 `apply` 抛错），再手工看 §3.1 |
| 每次改 `package.json` 的 version 或 `src/build.ts` | `verify-install`（24 项里有 3 项专防这个漂移） |
| 每次改 `src/build.ts` 的 BUILD 或 `client.js` 的 BUILD | `verify-install` 第 11 项 + `copy-client` |
| 每次发版前 | §3 全部 + §4 全部 + 六个冒烟脚本 |
| 网关行为变化 | 先更新 `05-empirical-findings.md`，再改代码，再跑 §1 |

**最后一条是这个项目最重要的纪律**：网关变了不是"代码有 bug"，是"假设过期了"。

---

## 6. 不做

| 不做 | 理由 |
| --- | --- |
| 自动化 E2E（Playwright 等） | 需要真实微信扫码与真实账号，无法自动化。**但** `smoke-client-apply.mjs` 用 `node:vm` 把 `client.js` 装进替身 ctx 里跑，已经覆盖了"注册逻辑"这一半 —— 剩下的只有"肉眼确认渲染出来" |
| 覆盖率门禁 | 单文件行数才是真正的质量约束（见 module-map 的大小预算） |
| 性能基准 | 瓶颈在上游网关，不在插件（首字节 1637–4517ms 全是网关时间） |
| 模糊测试 | 网关是唯一输入源，测不出新东西 |
