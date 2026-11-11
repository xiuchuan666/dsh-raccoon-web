# ADR-0011 · 不实现 token 自动续期（续期接口存在，但用了会伤到用户）

- 状态: Accepted
- 日期: 2026-11-11
- 决策者: 项目所有者
- 相关: [E-037](../01-research/05-empirical-findings.md)、[ADR-0008](./0008-desktop-credential-reuse.md)、[ADR-0009](./0009-web-auth-qr-protocol.md)
- 补正: 本文不改写 ADR-0008 / ADR-0009 的正文，只把其中一条**事实性表述**纠正过来。两篇 ADR 的**结论**（token 不落盘、读到了也不存 refresh token）不变。

---

## 背景

ADR-0008 第 77 行写：

> token 由客户端负责续期，我们不用实现 refresh（IAM token 本来也没有 legacy refresh grant，见 E-032）。

ADR-0009 第 91 行写：

> 协议 B 的 `success` 可能带 `refreshToken`；IAM token 没有 legacy refresh grant（E-032），所以**读到了也不存**。

这两句话当时基于 E-032 的一个**否定性观察**：在官方客户端 asar 里没找到 refresh 相关调用。E-037 用四轮探针把这个观察推翻了。

## 事实（E-037，2026-11-11）

1. **端点存在**：`POST /api/web/auth/v1/refresh`。空 body 返回 `400 {"code":100000,"message":"request_body_error","details":"request body empty or json invalid"}` —— 这是参数错误，不是 404，说明路由是活的。
2. **字段名是 `token`**：9 种 body 形状（`refresh_token` / `refreshToken` / `access_token` / `accessToken` / `token` / 空对象 …）全部返回同一条 `400 code=100002 params_invalid_error`、`details=param token invalid format invalid`。**连 `{}` 空对象也是** —— 报的是"格式无效"而不是"字段缺失"，所以字段名就是 `token`。
3. **格式校验猜不出来**：17 种形状（32/64 hex、UUID、`rt_`/`rt-`/`xrt_` 前缀、base64url 320/432/512 字符、纯字母 432、纯数字 432、13 位时间戳、时间戳+32hex、64 字节 base64）全部同一条 `100002`。**没有一种能过格式关。**
4. **官方桌面端自己也不调它**：asar（`C:/Program Files/@raccoonoffice-desktop/resources/app.asar`，336,918,710 字节）里 `/api/web/auth/v1/refresh` **只出现 1 次**，位置 74078848，`callScore=0` / `docScore=1` —— 是一段 SDK 文档，不是可执行调用点。

## 决策

**不实现 token 自动续期。** 凭据过期时引导用户去官方客户端刷新（`desktopAuth.reason` / `login.message` 已有对应文案）。

**并且：探针全程刻意没有放真 token 进 `refresh`。** 理由是下面这条风险，不是谨慎过度。

## 为什么（不是"猜不出来所以放弃"）

真正的理由不是"格式猜不出来"，而是**即使猜出来也不该用**：

**refresh 会 rotate。** 续期成功意味着服务端作废旧的那个 token 并下发新的。我们手里的是**从官方客户端只读来的**（ADR-0008）。一旦我们拿它去续期并成功，官方客户端手里那个就失效了 —— 用户下次打开客户端会被踢下线，而且他不会知道是谁干的。

这条风险是不可观测的：我们在自己的进程里看不到"用户被踢了"，只会在几天后收到"官方客户端要重新登录"的抱怨，且无法归因。**一个会让用户的其他软件静默失效的功能，收益（省掉每 30 天一次的重新登录）远小于代价。**

## 后果

### 正面

- 用户的其他软件（官方客户端）永远不会因为我们而掉线。
- 我们不需要持有 refresh token，`token.json` / `accounts.json` 里少一类高价值凭据，泄露面更小。
- 凭据过期这件事变成**可解释的**：界面直接说"打开官方客户端重新登录"，用户做完就好，不涉及我们的任何状态机。

### 负面

- 桌面端凭据每约 30 天要用户手动刷一次（打开客户端即可，客户端自己会续）。
- 号池里的账号过期后只能靠用户重新导入；`pool-test` 能把 `dead` 打回 `ok`，但前提是那个号的 token 还有效。
- 与 workbuddy 那类"自己 OAuth 换 token"的实现相比，我们少了一层自动恢复能力 —— 这是**用别人的凭据**必然的代价。

### 中性

- `pool-checkin` 与 `pool-test` 都不依赖续期，功能不受影响。

## 被否决的方案

| 方案 | 为什么否 |
| --- | --- |
| 拿桌面端 token 试 `refresh`，失败就算了 | 一旦成功就 rotate，把用户从官方客户端踢下线。**失败也可能已经消耗了某种一次性状态**，只是我们看不到。 |
| 暴力枚举 `token` 的格式 | 17 种形状已试完。再往下就是拿用户真 token 去撞，等于上一条。 |
| 让用户手动粘贴 refresh token | 我们本来就不该持有它；而且用户拿不到（客户端不展示）。 |
| 过期后静默回落到扫码 token | `authSource: desktop` 是严格模式，静默回落会让用户以为自己在用桌面端账号，实际在用另一个号 —— 余额和配额都对不上。 |
| 自己实现一套 OAuth（像 workbuddy 那样自己换 token） | 那是**另一个账号**，不是用户的桌面端账号。ADR-0008 的整个价值就是"用你已经登录的那个"。 |

## 复审条件

出现以下任一情况时重新评估：

1. 官方文档明确写出 `refresh` 的语义是**不 rotate**（或 rotate 后旧 token 仍有效一段时间）。
2. 官方客户端 asar 里出现真实的 `refresh` 调用点（`callScore > 0`），说明这是它自己也在走的正常路径。
3. 官方提供一种"只读续期"能力（例如 `GET` 查询剩余有效期而不换发）。

在那之前，`docs/04-ops/01-troubleshooting.md` §4.2 的引导文案就是最终方案。
