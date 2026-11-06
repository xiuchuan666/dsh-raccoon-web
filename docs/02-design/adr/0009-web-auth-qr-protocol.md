# ADR-0009 · 扫码改用官方桌面端那套 Web auth，IAM 小程序码留作备选

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [E-029](../01-research/05-empirical-findings.md)、[E-033](../01-research/05-empirical-findings.md)、[ADR-0002](./0002-self-contained-qr-encoder.md)、[ADR-0008](./0008-desktop-credential-reuse.md)

---

## 背景

扫码这条线上，我们最初按 `dsh-llm-adapters` 与 `dsh-connect-sensenova-token-plan` 的做法实现（下称 **协议 A / IAM 小程序码**）：

```
POST /api/iam/v1/auth/mp/qrcode            → { qrcode_code: "qr-01a1...", scan_path: "/login/mp", expires_in: 300 }
二维码内容 = https://xiaohuanxiong.com/login/mp?code=<qrcode_code>&appname=商汤小浣熊&source=platform
POST /api/iam/v1/auth/mp/qrcode/login      { qrcode_code } → pending | logging | success{access_token}
```

这条路线**能出码、能被微信识别、手机上也确实弹出了「确认登录商汤小浣熊」**。但连续 4 次实测都是同一个结果：用户扫完立刻看到「二维码已过期或已被使用，请在 Web/PC 端刷新二维码后重新扫码」，按钮变成「本次请求已结束」。

排查结论（E-029）：**码是我们自己的脚本作废的**——`scripts/login-qr.mjs` 旧版每次运行都先打 `action=login-start`，而 `LoginFlow.start()` 内部是 `cancel()` → `createQr()`，服务端在新码生成的一瞬间就把旧码标记为已使用。所以"刚贴给用户就换码"必然导致扫到的是一张死码。这是操作失误，不是协议问题。

修好这个失误之后，同时去逆向官方桌面客户端（`app.asar`），发现了一件更值得注意的事：**官方桌面端根本不用协议 A**（E-033）。

## 官方桌面端实际用的协议（下称协议 B / Web auth）

```js
// asar 内 createAccountQrSession
const code = `${Date.now()}${randomBytes(16).toString('hex')}`;   // 13 位 ms + 32 hex = 45 字符
const url = new URL('/login/mp', baseUrl);
url.searchParams.set('code', code);
url.searchParams.set('appname', '小浣熊官网');                     // ← 不是「商汤小浣熊」
```

```
POST /api/web/auth/v1/login_with_qrcode_code  { qrcode_code: code }
  → pending | logging | canceled | success{ tokens: { accessToken, refreshToken? } }
```

三个关键差异：

| | 协议 A（IAM） | 协议 B（Web auth） |
| --- | --- | --- |
| code 从哪来 | **服务端下发** `qr-xxxx` | **本地自己生成**，45 位数字+hex |
| appname | `商汤小浣熊` | `小浣熊官网` |
| 轮询端点 | `/api/iam/v1/auth/mp/qrcode/login` | `/api/web/auth/v1/login_with_qrcode_code` |
| 拿到的令牌 | `access_token`（IAM JWT） | `tokens.accessToken`（**也是** IAM JWT） |
| 命名空间 | 与 B 不通用（B 的 code 打 A 的端点回 `AUTH_QRCODE_INVALID`） | — |

协议 B 还有一个特性：`login_with_qrcode_code` 对**任何格式正确的 code 都返回 `pending`**（实测随便编一个 `1234567890123` + 32 个 `a` 也是 `200 {"code":0,"data":{"status":"pending"}}`），也就是说**这个端点没有"code 是否有效"的概念**，它只回答"这个 code 现在扫了没"。无效码永远不会变成 `success`，最终由本地 `expiresAt` 判定过期。

## 决策

1. **默认走协议 B**（`qrProtocol: "web"`）。理由见下。
2. **保留协议 A**，作为设置项 `qrProtocol: "iam"` 的可选项。
3. 两种协议在 `LoginFlow` 里用同一个状态机（`none / pending / logging / ready / expired / error`），只在三处分岔：取码、轮询、以及**是否需要 `iam/confirm` 握手**。
   - 协议 A 成功后要 `POST /api/web/auth/v1/iam/confirm` 把 Bearer 换成 `xhx_token` cookie；失败不致命，以 `model_catalog` 能否返回 `data.categories` 为准。
   - **协议 B 拿到的是 IAM JWT，官方客户端直接当 Bearer 用**，不需要 `iam/confirm` 那一步（`complete()` 里 `const cookie = this.protocol === "web" ? undefined : await confirmSession(...)`）。
4. `qrProtocol` 进 settings（`"web" | "iam"`，默认 `"web"`），设置卡给一个下拉，诊断块加一行"扫码协议"。

## 为什么默认选 B

1. **少一次网络往返。** 协议 A 要先 `POST` 取码，网络抖动时用户看到的是"二维码加载失败"；协议 B 是纯本地生成，`login-start` 立刻返回 SVG。
2. **和服务端行为解耦。** 协议 A 的 code 有效期由服务端给（`expires_in`），协议 B 的有效期由我们自己定（`expiresIn = 300`，与服务端 `expired_at` 对齐）。上游若把 IAM 取码端点加了风控/限频，协议 B 完全不受影响。
3. **这是官方在用的那条。** 逆向出来的实现就是它，行为一致性最好；协议 A 是网页/小程序那一侧，将来若下线我们无从得知。
4. **`iam/confirm` 那一步可以省。** 少一次可能失败的调用，登录成功路径更短。

## 为什么还留着 A

- 协议 A 的码是**微信小程序**那一侧的码，用户如果在手机上是"扫小程序码"的习惯，A 更自然。两种码在视觉上都是普通 QR，但服务端接受方不同。
- 如果将来上游对 web auth 的 code 加了签名（现在是明文时间戳+随机串，非常"可预测"），A 可能是唯一还活着的入口。
- 保留成本极低：两个协议只在三处分岔，共享同一套状态机与 UI。

## 后果

**正面**

- `login-start` 变成**纯本地操作**（协议 B 下不碰网络），实测响应即刻返回、`qrSvg` 16389 字节。
- 二维码内容实测 **139 字节**（`code` 45 + `appname` 编码后 45 + 固定部分），比协议 A 的 149 字节短，但**仍然落在 QR 版本 8**（版本 7 容量 122 字节不够）。ADR-0002 里"版本 ≥7 必须写版本信息块"这条对两条协议都成立。
- 设置卡多一个下拉，诊断块多一行，用户能自己判断"我这个码是哪一套"。

**负面**

- **两种码互不通用**，UI 必须讲清楚（`settingQrHint`），否则用户拿 B 的码去小程序扫会一脸茫然。
- 协议 B 的 code 是"时间戳 + 32 hex"，看起来像可预测的口令。**不做任何加固**：这不是我们能改的，客户端就是这么发的，我们照抄才是"像官方客户端"。
- `qrProtocol` 切换后旧的进行中会话必须作废（`start()` 每轮重新读设置），否则会出现"用 A 的 code 去问 B 的端点"。

**中性**

- 协议 B 的 `success` 可能带 `refreshToken`；IAM token 没有 legacy refresh grant（E-032），所以**读到了也不存**。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 只留协议 A | 它是"每次都要先问服务端要码"的那条，网络依赖更重；且官方自己不用它 |
| 只留协议 B | 丢掉小程序那一侧的入口；且上游若改 web auth，A 可能是唯一活路 |
| 自动探测（先试 B 失败再试 A） | 无法探测——B 对任何 code 都回 `pending`，没有"失败"信号。**必须由用户显式选择。** |

## 复审条件

1. 协议 B 的 `login_with_qrcode_code` 开始对无效 code 返回错误（不再是恒 `pending`）→ 说明上游加了状态校验，可以简化我们的本地过期判定。
2. 协议 A 的 `expires_in` / `poll_interval` 形状变了 → 更新 `iam.ts` 与 E-001。
3. 上游给 web auth 的 code 加签名（不再接受明文时间戳）→ 协议 B 失效，默认切回 A。
