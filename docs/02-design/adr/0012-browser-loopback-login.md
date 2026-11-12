# ADR-0012 · 账号池「加号」走浏览器 loopback，而不是扫码

- 状态：**Accepted**
- 日期：2026-11-12
- 相关：E-040、ADR-0009（Web auth 扫码协议）、ADR-0010（账号池）、ADR-0011（不做 token 续期）
- 补正：ADR-0009 的**结论**（Web auth 码可用、默认 `qrProtocol: "web"`）在 2026-11-12 之后只对 IAM 码成立 —— 见下文「为什么不能简单把默认改回 iam」。

## 背景

用户 2026-11-12 报：账号池点「扫码添加」→ 微信扫码 → 手机上点「确认登录 Web/PC」→ 手机提示**「二维码已过期或已被使用」**，插件永远收不到登录成功。

排查结论（完整取证见 E-040）：

1. `GET https://xiaohuanxiong.com/login/mp?code=...` 对**任何** UA（微信 iPhone / 微信 Windows / Chrome / curl / 无 UA）都返回 **404**，`_rsc=1` 时能看到 Next.js 的 `notFound` —— **这个路由在服务端已经不存在了**。
2. `POST /api/web/auth/v1/login_with_qrcode_code` 对**任何** body（含 `{}`、含非法 code、含 1 小时前/后的时间戳）恒定返回 `{"status":"pending"}` —— 它没有"码不存在"这个信号。
3. 官方桌面端**换账号时根本不用扫码**：`app.asar/build/electron/main/client/account/webLogin.js` 打开浏览器到 `/authorize`，用户在里面正常登录，完成后浏览器重定向到客户端在本机起的一次性 HTTP 服务，客户端拿 `code` 调 `login_with_authorization_code` 换 token。
4. 那条路的两个端点都实测可用：`GET /authorize?...` → 200（标题「客户端授权 | 商汤小浣熊」）；`POST login_with_authorization_code` 对假 code → **400 `code=200035`**（真的在校验）。

## 决策

**账号池「加号」的主路线改成浏览器 loopback（`pool-add-browser`），扫码（`pool-add-start`）降级为备用。**

具体：

- 新增 `src/protocol/loopback.ts`：`authorizeUrl()` / `newState()` / `parseCallback()` / `startLoopback()` / `exchangeCode()`。
- 新增两个 action：`pool-add-browser`（起服务、返回 `browser.url` + `port`，后台等回调）、`pool-add-browser-cancel`（收摊）。
- `StatusSnapshot` 新增 `browser: StatusBrowser`（`active` / `url` / `port` / `startedAt` / `message`），**不含 code、不含 token**。
- `PoolAccount.source` 与 `StoredToken.source` 从 `"qr" | "desktop"` 扩成 **`"qr" | "desktop" | "browser"`**，诊断里能看出这个号是从哪条路进来的。
- 同一时刻**只允许一个**在途 loopback（`Host.browserLogin` 单槽）；再点一次先关旧的。
- `dispose()` 里必须 `closeBrowserLogin()` —— 它在真的监听一个端口，卸载后还开着就是孤立的监听者。

## 为什么是 loopback 而不是继续修扫码

| 方案 | 为什么不行 / 为什么行 |
| --- | --- |
| 继续调 `login_with_qrcode_code` | 端点无状态，**没有任何可观测信号**能区分"码有效但没人扫"和"码根本不存在"。我们已经补齐了 UA 与 `registration_attribution`（2026-11-12），行为零变化 —— 缺的不是请求头。 |
| 换成 IAM 小程序码（`qrProtocol: "iam"`） | 它走另一套命名空间（`POST /api/iam/v1/auth/mp/qrcode` + `appname=商汤小浣熊`），**未受 `/login/mp` 下线影响**，可以作为备用；但它要求用户装微信小程序，且不能像 loopback 那样让用户用手机号登录。 |
| 让用户手工把 token 粘进来 | 用户拿不到 token（在客户端私有目录里，且要会读 JWT）。这不是"给个输入框"能解决的事。 |
| **loopback** | 浏览器里跑的是**官方网页端本体**，登录方式、风控、验证码全由它自己处理；换码端点**真的在校验**；全程不需要服务端认识我们（`/authorize` 对裸请求 200）。 |

## 安全边界（照抄官方 `webLoginLoopback.js`）

- 只在 `127.0.0.1` 上 `listen(0)`（系统分配端口），`maxConnections = 8`。
- `state` = 32 字节随机数的 hex（64 字符），回调必须**逐字符相等**（`timingSafeEqual`，先比长度避免抛）。
- 只接受 `GET /auth/callback`；参数名只允许 `code` 与 `state`，各出现**恰好一次**；带 hash 一律拒；`url.length ≤ 8192`；`code.length ≤ 4096`；`code` 不许含控制字符。
- 一次性：收到第一个合法回调就 `server.close()` + `closeAllConnections()`，之后同端口不再应答。
- 超时 300000ms 自动关闭（`timer.unref()`，不拖住进程）。
- 结果页带 `cache-control: no-store` / `referrer-policy: no-referrer`，且只有一行文字 + 一句"可以关闭此页面"。
- **`code` 与 `refreshToken` 都不落盘、不进日志**（与 ADR-0011 同一条规矩）。`refreshToken` 只在内存里传给 `exchangeCode()` 的返回值，随后丢弃。

## 后果

**正面**

1. 加号这条路终于**能走通**，而且走的是官方自己那条。
2. 用户可以用手机号登录 —— 不必有微信，也不必装小程序。
3. 回调服务的判据全部有单测（LB-1~LB-35），包括每一条拒收 reason。

**负面**

1. 多了一个监听本机端口的组件。虽然只绑 `127.0.0.1` 且一次性，但它确实是本插件里**唯一**对外开口子的东西 —— 以后任何改动都要先想清楚这一点。
2. 用户体验从"扫一下"变成"点开浏览器 → 登录 → 等跳回"。在已经登录过网页端的人身上这一步很快，在没登录过的人身上要输手机号 + 验证码。
3. 依赖 `/authorize` 这个页面继续存在。它和 `/login/mp` 是同一家公司同一批代码，**没有理由认为它不会同样被下线** —— 所以扫码那条要留着，不能删。

**中性**

- `source` 多一个值 `"browser"`。老数据（`"qr"` / `"desktop"`）照常读，不需要迁移。

## 被否决的方案

1. **把 `qrProtocol` 默认改回 `"iam"`** —— IAM 码确实没受影响，但它把"加号"重新绑到微信小程序上，而 loopback 能覆盖"没装微信小程序"的人。而且 IAM 码同样依赖一个我们无法验证存活的服务端路由。
2. **loopback 成功后再去调一次 `login_with_qrcode_code` 确认** —— 无意义的往返，那个端点什么都不会告诉我们。
3. **把 `code` 落盘以便失败后重试** —— `code` 是一次性的（换过就作废），落盘只会多一个泄露面。
4. **用 Electron 深链 `office-raccoon://auth/callback`** —— 那需要注册一个自定义协议处理器，等于在用户机器上装东西，超出插件边界。
5. **后台常驻回调服务** —— 端口长期开着、`state` 长期有效，是把一次性凭证变成常驻攻击面。

## 复审条件

1. `/login/mp` 恢复 200（有人重新上线那条路）—— 那时可以把扫码提回主路线。
2. `/authorize` 开始返回 404 或要求签名 —— 这条路也要跟着换。
3. 服务端开始对 `login_with_authorization_code` 要求额外参数（例如 PKCE `code_verifier`）—— 那要改 `exchangeCode()` 与 `authorizeUrl()` 两侧。
