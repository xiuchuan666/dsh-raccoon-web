# 测试计划

最后更新: 2026-11-06
状态: 已定稿

> 这个项目的测试分三层：**不依赖宿主**的协议层单测、**mock 内核**的宿主层单测、**必须真人参与**的端到端验证。
> 第三层是这个项目的主要风险来源 —— 它无法自动化（要用手机微信扫码），所以必须写成"可复述的步骤"，让人照着做。

---

## 0. 测试命令

```bash
pnpm -w run typecheck      # tsc --noEmit
pnpm -w run build          # tsup（验证 splitting:false 生效）
pnpm -w run test           # node --test 'test/**/*.test.ts'（经 tsup 或 tsx）
node scripts/verify-install.mjs   # 装得上、能解析
```

单测用 `node --test`（Node 24 内置），不引 vitest / jest —— 理由见 [06-coding-conventions](../02-design/06-coding-conventions.md)。

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

---

## 3. 端到端验证（必须真手机）

这一层不能自动化。写成**可复述的步骤 + 明确的判定标准**，每次发版前手工跑一遍。

### 3.1 E2E-1 首次安装

```
前置：~/.dsh/profiles/desktop/raccoon-web/ 不存在；DSH 里没有 raccoon 条目
1.  node scripts/link.mjs
2.  重启 DSH
判定：
  ✅ 设置 → 插件 → 出现「小浣熊」卡片
  ✅ 输入框左侧出现 🦝 未登录
  ✅ 日志有 [raccoon-web] loaded (build ...)
  ❌ 任何红字 / 卡片空白 → 记录到 troubleshooting
```

### 3.2 E2E-2 扫码登录

```
1.  打开设置卡 → 点「扫码登录」
2.  手机微信 → 扫
3.  手机上点「确认登录」
判定：
  ✅ 3 秒内二维码出现（且手机上能扫出内容）
  ✅ 扫码后手机显示确认页
  ✅ 确认后 5 秒内界面变「已登录 · <昵称>」
  ✅ token.json 存在且 principal 非空
  ✅ 模型选择器出现「小浣熊」分组
```

**扫码这里要额外验证一件事**：用手机扫出来的 URL 应当是

```
https://xiaohuanxiong.com/login/mp?code=qr-...&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform
```

如果 URL 少了 `appname` 或 `source`，微信端会打开一个空白页 —— 这是 QR 编码器"内容正确但编码错"的典型症状，**必须肉眼对一次**。

### 3.3 E2E-3 对话

```
1.  选一个模型（先用 sn-sensenova-6-8-flash，最便宜）
2.  发「用一句话解释什么是进程」
判定：
  ✅ 文字逐字出现（不是一次性出现）
  ✅ 计时：首字 < 3 秒
3.  再发「刚才那句话里的关键词是什么」
判定：
  ✅ 能引用第一轮内容（上下文通了）
4.  发一个需要推理的问题（如「9.9 和 9.11 哪个大，逐步推理」）
判定：
  ✅ 思考区出现推理内容（若模型支持）
5.  中途点「停止」
判定：
  ✅ 立刻停，不报错，已输出内容保留
```

### 3.4 E2E-4 失败路径

| 场景 | 操作 | 期望 |
| --- | --- | --- |
| 登录失效 | 手工把 `token.json` 的 `token` 改成 `xxx` | 发消息 → 明确提示"登录已失效"，**不是** "未知错误" |
| 限流 | 连续发 20 条长上下文 | 提示吞吐上限的长文案，**不是** 500 |
| 断网 | 禁用网卡 → 发消息 | `TRANSPORT` 文案（"网络连接中断"） |
| 大图 | 发一张 4000×3000 的图 | 要么自动缩到预算内，要么明确提示"图片过大" |
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

---

## 4. 非功能验证

| 项 | 方法 | 标准 |
| --- | --- | --- |
| 启动开销 | 日志打 `apply` 到 `loaded` 的毫秒数 | < 50ms（apply 里不做网络请求） |
| 内存 | 任务管理器看宿主进程 | 增量 < 20MB |
| token 泄露 | `grep -r "xhx_\|eyJ" ~/.dsh/logs/` | 0 命中 |
| 构建产物 | `ls lib/` | 只有 `index.js`（**无 chunk**） |
| 依赖 | `pnpm ls --prod` | 0 个运行时依赖 |
| 路由冲突 | 重复 link 两次 | 不报 409 |

---

## 5. 回归时机

| 时机 | 跑哪一层 |
| --- | --- |
| 每次改 `src/protocol/` | §1 全跑 |
| 每次改 `src/host/` | §2 全跑 |
| 每次改 `client.js` | §3.1 + §3.3（手工） |
| 每次发版前 | §3 全部 + §4 全部 |
| 网关行为变化 | 先更新 `05-empirical-findings.md`，再改代码，再跑 §1 |

**最后一条是这个项目最重要的纪律**：网关变了不是"代码有 bug"，是"假设过期了"。

---

## 6. 不做

| 不做 | 理由 |
| --- | --- |
| 自动化 E2E（Playwright 等） | 需要真实微信扫码，无法自动化 |
| 覆盖率门禁 | 单文件行数才是真正的质量约束（见 module-map 的大小预算） |
| 性能基准 | 瓶颈在上游网关，不在插件 |
| 模糊测试 | 网关是唯一输入源，测不出新东西 |
