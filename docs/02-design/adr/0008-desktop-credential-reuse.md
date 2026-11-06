# ADR-0008 · 以「只读官方桌面客户端凭据」为首选登录方式

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- Supersedes: [ADR-0001](./0001-login-via-web-qr.md)（部分：ADR-0001 断言"桌面端凭据不可用"，已被 E-030 推翻）
- 相关: [E-006](../01-research/05-empirical-findings.md)、[E-029](../01-research/05-empirical-findings.md)、[E-030](../01-research/05-empirical-findings.md)、[E-031](../01-research/05-empirical-findings.md)

---

## 背景

ADR-0001 当时的判断是：**只走网页扫码，不碰桌面端凭据**。理由是实测 `~/.box-agent/config/auth.json` **不存在**（E-006），所以"读桌面端凭据"这条路在本机根本走不通；再加上"读桌面端凭据"在授权边界上比"用户自己扫码"含糊，于是把整条路线否决掉了。

用户随后明确提出：**"不能用像 workbuddy 那种反代的方式吗，不需要登录直接接入本地客户端的登录状态"**（m01681）。

两条事实逼着重开这个决策：

1. **E-006 的结论是错的，不是判断错，是路径找错了。** 官方客户端（`C:\Program Files\@raccoonoffice-desktop\`，`@raccoon/office-desktop` 1.1.9）在 Windows 上把 profile 目录指到 **`.office-raccoon`**，不是 `.box-agent`。asar 内 `clientProfile.js`：

   ```js
   const WINDOWS_PROFILE_DIRECTORY = '.office-raccoon';
   ```

   于是 `BOX_AGENT_CONFIG_DIR` = `C:\Users\Administrator\.office-raccoon\agent\config`，凭据真实落点是
   **`~/.office-raccoon/agent/config/auth.json`**。这个文件在本机**存在**，490 字节，2026-11-04 13:33 写过。
2. **那个 token 真的能用。** 拿它直接打网关，四个端点全部 200（E-031）：`model_catalog`（9 个模型）、`chat/completions`（SSE 正常）、`points/v1/balance`（11700 分）、`auth/v1/user_info`（`RaccoonElizabeth` / uid 7865139）。JWT `exp` = 2026-12-04T05:33:48Z，写这份 ADR 时还剩 28 天。

也就是说：**用户要的那条路，技术上一直是通的，只是入口找错了地方。**

## 决策

新增 `src/protocol/desktop-auth.ts`，**只读**官方桌面客户端的凭据文件，作为**首选**登录来源：

```
authSource = "auto"     → 先试桌面端凭据，读不到/过期再回落到扫码（默认）
authSource = "desktop"  → 只用桌面端凭据，读不到就报错，绝不偷偷用扫码 token
authSource = "qr"       → 只用扫码，完全不看桌面端文件
```

候选路径按顺序探测（`authCandidates()`）：

| # | 路径 | 依据 |
| --- | --- | --- |
| 1 | `$BOX_AGENT_CONFIG_DIR/auth.json` | asar `getBoxAgentAuthPath()` 的第一优先 |
| 2 | `$BOX_AGENT_HOME/config/auth.json` | 同上，`resolveBoxAgentHome()` |
| 3 | `~/.office-raccoon/agent/config/auth.json` | **Windows 桌面端实际用的**（E-030） |
| 4 | `~/office-raccoon/agent/config/auth.json` | 非点号变体，防上游改名 |
| 5 | `~/.office-raccoon/config/auth.json` | 少一层 `agent` 的变体 |
| 6 | `~/.box-agent/config/auth.json` | 老版本/跨平台默认值 |

读到的 token 走**同一条** `StoredToken` 通路（`kind:"access_token"`、`source:"desktop"`），因此 provider 装配、catalog 刷新、配额查询全部无需分支。

**`source:"desktop"` 的 token 不落盘。** `token.json` 只属于我们自己扫码得来的凭据；桌面端那份由客户端维护，我们只在内存里引用。好处是：客户端退出登录/换账号，我们下次启动自然跟着变，不会出现"插件里还留着一个已经失效的旧 token"。

## 三条边界（写进文件头，不是口头承诺）

1. **只读。** 不写 `auth.json`、不改 `office_identity`、不生成 `.tmp` 回填。`readDesktopAuth()` 里只有 `readFile`。
2. **不上传。** token 只出现在两个地方：内存里的 `StoredToken`，和发往 `xiaohuanxiong.com` 的 `Authorization` 头。日志只打 `sha256(token).slice(0,8)`（`tokenTag()`）。
3. **不越界扩展。** 不扫全盘找 token、不读浏览器 cookie 库、不碰 Windows 凭据管理器、不 attach 进程内存。路径是**枚举**出来的六条，不是 `glob` 出来的。

## 为什么不照抄 workbuddy

用户的原话是"像 workbuddy 那种反代的方式"。查了 `dsh-connect-workbuddy@5.17.0` 的实现：

- `homedir()` 只用于探测 npm/nvm/fnm/volta/pnpm/yarn 的全局 bin 目录；
- `.workbuddy-pool` 文件存的是**探测结果**（`outcome` / `atMs` / `retryAtMs` / `message`），源码注释明确写"存的是观测结果而非凭据"；
- 它自己的凭据在 `$DSH_HOME/.workbuddy-auth.<region>.json`，是通过 OAuth（`{billing_base}{API_PREFIX}/auth/state?platform=` → 浏览器授权 → `/auth/token?state=`）拿到的，**跟本地客户端无关**。

**结论：workbuddy 并没有"读本地客户端登录态"这个能力，它只是把 OAuth 做得无感。** 所以"照抄 workbuddy"这条路本身不成立；能抄的是它的**产品形态**——用户不用管 token 从哪来，打开就能用。本 ADR 实现的是这个形态，只是凭据来源换成了官方客户端文件。

## 后果

**正面**

- 用户装过并登录过官方客户端 → **零操作**接入，比扫码快得多，也不用手机。
- token 由客户端负责续期，我们不用实现 refresh（IAM token 本来也没有 legacy refresh grant，见 E-032）。
- 首屏就有目录、余额、账号昵称（`user_info` 的 `data.name`），不像扫码路线要等一次往返。
- 与扫码路线共用同一条 `StoredToken` → `Publisher` → `PiAiAdapter` 通路，**没有第二套适配层**。

**负面**

- 依赖一个**不受我们控制的文件路径**。客户端升级改了目录（就像它曾经从 `.box-agent` 改到 `.office-raccoon`），我们就得跟着改——所以路径是六条枚举 + `BOX_AGENT_*` 环境变量优先，不是硬编码一条。
- 用户没装/没登录客户端时这条路是空的，扫码必须留着兜底。`authSource:"auto"` 就是这个意思。
- "退出登录"按钮的语义变了：**我们不能也不该去删客户端的 `auth.json`**。现在的行为是"本会话不再自动读取它"（`desktopIgnored = true`），UI 上明说"要真正退出请到客户端里退出"。这一点在 `client.js` 的 `loginDesktopReadonly` 文案里讲清楚了。
- 凭据过期时（`exp` 到点）我们只能报错让用户"打开客户端重新登录一次"，没法自动续。

**中性**

- `office_identity` 读到 `"personal"` 时不发 `X-Org-Code`（与官方 asar 一致）；非 `personal` 才发。这条规则现在只有桌面端路线用得上。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 继续只做扫码 | 用户明确要求不要每次扫码；且扫码这几轮实测下来，人工确认这一步的失败率远高于预期（连续 4 次码过期，见 E-029） |
| 复制 `auth.json` 到我们自己的目录再读 | 多一份凭据副本 = 多一个泄露面，且客户端换 token 后我们就是旧的。**直接读原文件，永远拿最新的。** |
| 监听文件变化（`fs.watch`）实现热切换 | 客户端写盘是 `.tmp` + `rename`，`watch` 会触发两次；收益只是省一次重启。留作后续优化，不进 0.1.0。 |
| 走桌面深链授权（`office-raccoon://auth/callback`） | 需要注册 URL scheme 并抢占官方客户端的 scheme，会互相打架。**否决。** |
| 读浏览器 cookie 里的 `xhx_token` | 明确越界：那是用户在浏览器里的会话，不是"本地客户端登录态"。 |

## 复审条件

1. 官方客户端把凭据改成加密存储 / DPAPI 保护 → 这条路失效，退回纯扫码，并把 ADR-0001 恢复为 Accepted。
2. `auth.json` 的 key 名从 `access_token` 变成别的（现在是扁平兜底读 `access_token | accessToken | token | auth_token`，能扛住一次改名）→ 更新 `desktop-auth.ts` 与 E-030。
3. 上游开始校验 IAM token 的 `aud` / `sid`，要求必须与客户端进程匹配 → 这条路彻底失效。
