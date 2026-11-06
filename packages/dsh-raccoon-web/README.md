<p align="center"><img src="./icon.svg" width="96" alt="dsh-raccoon-web"></p>

<h1 align="center">dsh-raccoon-web</h1>

<p align="center"><strong>把「商汤小浣熊」接进 DeepSeek Harness —— 默认直接复用官方客户端已登录的账号，读不到再扫码。</strong></p>

<p align="center">
  <a href="./README.md">简体中文</a> ·
  <a href="../../README.md">工程总览</a> ·
  <a href="../../docs/00-index.md">文档地图</a> ·
  <a href="../../devlog/">开发日志</a>
</p>

---

## 风险提示

> - **不保证长期可用。** 这是一个**没有公开文档的私有网关**，上游随时可能改协议。变了不是"插件有 bug"，是"假设过期了"——本项目为此维护 `docs/01-research/05-empirical-findings.md`，每条断言都带实测日期。
> - **不提供账号。** 你要么装过并登录过官方「商汤小浣熊」桌面客户端，要么自己扫码。
> - **不共享凭据。** 桌面端凭据是从 `~/.office-raccoon/agent/config/auth.json` **只读**读出来的，只进内存、不落盘、不回写；扫码得到的 token 存在你本机 `~/.dsh/state/dsh-raccoon-web/token.json`。插件**不发送任何遥测**。
> - **不绕过计费。** 每次对话消耗的是**你自己账号的积分**。插件不代领每日积分，也不做任何"刷额度"的事。
> - **必须用手机扫码（兜底路线）。** 桌面端路线不需要，但扫码路线做不到无人值守部署。
> - **不是官方插件。** 与小浣熊官方无关，出问题不要去找官方客服。

---

## 为什么又写一个

已有的六份实现都不可用，而**死因是同一个**：把"能不能用"押在一个不受自己控制的入口上。

| 实现 | 死因 |
| --- | --- |
| `dsh-raccoon-connect` 0.2.4 | 读 `~/.box-agent/config/auth.json` —— **路径早就变了**，官方桌面端现在写在 `~/.office-raccoon/agent/config/auth.json`（E-030） |
| `dsh-raccoon` 0.0.1 | 空壳包，什么都没实现 |
| `magpie-raccoon-auth` | magpie 框架插件，不是 DSH 原生 |
| `dsh-connect-sensenova-token-plan` 内建 | 能用，但 **`reasoning: false`**（思考通道直接关掉），且请求头缺 `x-client-platform` / `x-client-version` |
| `dsh-llm-adapters` 内建 | 网页扫码路线写得对，但它同时接四家，浣熊只是其中一块 |
| `dsh-raccoon-checkin` | 给别的插件打 `node_modules` 补丁，上游一变就碎 |

本插件的定位：**只做小浣熊一件事，把这件事做到底**——并且**同时支持两条取凭据的路**，一条断了另一条还在。

---

## 功能特性

- 🔑 **两个登录入口，永远并列** ——
  **① 复用官方客户端登录态**（默认，零操作）：只读 `~/.office-raccoon/agent/config/auth.json`，客户端换账号/退出登录，插件下次启动自然跟着变；
  **② 扫码**（兜底）：默认走**官方桌面端同款 Web auth 协议**（code 本地生成、`appname=小浣熊官网`、`POST /api/web/auth/v1/login_with_qrcode_code`），IAM 小程序码作为可选项保留。
  设置里 `登录来源` 三态 `自动 / 只读客户端 / 只扫码`，选 `只读客户端` 时**绝不偷偷用扫码 token**。
- 🔒 **只读，不代持** —— 桌面端凭据只出现在两个地方：内存里的 token，和发往 `xiaohuanxiong.com` 的 `Authorization` 头。不写回 `auth.json`、不复制副本、不读浏览器 cookie 库、不碰 Windows 凭据管理器、不 attach 进程内存。路径是**枚举**出来的六条 + `BOX_AGENT_CONFIG_DIR` / `BOX_AGENT_HOME` 优先，不是全盘 `glob`。
- 🎨 **零依赖 QR 编码器** —— byte 模式 + 纠错 M + SVG 输出，约 400 行自己写。理由：宿主进程里多一个依赖就多一个拖垮整个 app 的可能（[ADR-0002](../../docs/02-design/adr/0002-self-contained-qr-encoder.md)）。
  实测：12 个容量边界 + 40 个随机内容全部被 OpenCV 双检测器解出（E-024）；真宿主下发的两种码（139 / 149 字节，均版本 8）也解得出。
- 🧠 **思考通道真的开着** —— 包装 `openAICompletionsApi()`，在 `onPayload` 里注入 `extra_body.thinking`，`delta.reasoning_content` 由 pi-ai 原生解析（[ADR-0007](../../docs/02-design/adr/0007-wrap-openai-completions-api.md)）。
  实测：关掉思考后仍会有少量 reasoning 回吐（81 vs 260 字符），UI 容忍这种情况（E-035）。
- ⏱️ **首字节超时 60s** —— 实测首字节中位 1–2 秒（真链路 1637ms），但高峰有 60s+ 无响应。没这个超时，用户看到的是十分钟转圈。
- 🚦 **限流识别覆盖 HTTP 200** —— 上游限流常以 `{"code":200429,"message":"user_model_rate_limited"}` 塞在 200 流里，只看 `status === 429` 会漏，用户看到的是"模型突然不说话"。
- 📚 **目录字段全按实测来** —— `context_window` / `max_tokens` 在 `params` 嵌套里、显示名是 `description`、倍率是 `billing_multiplier`、分组 key 取 `type`（E-032）。`visible:false` 的模型默认过滤（它们能调通，但官方客户端不展示）。
- 💰 **积分只读** —— 永久 / 每日两项分开显示，20 秒刷新，失焦暂停。**不代领**：上游没有独立签到接口，每日积分由"当天首次带登录态访问网页"发放，重放公告能触发，但那等于未经用户同意改变账号状态。
- 🔍 **识图能力实测** —— 目录里的 `vision` 标签**不可信**（2026-09-18 实测 5 个模型错 2 个，两个方向都错）。所以提供逐模型探测：发 3×3 纯红 PNG 问颜色，三态判定后持久化（[ADR-0006](../../docs/02-design/adr/0006-vision-detection-by-probe.md)）。
- 🧾 **诊断块可复制** —— 十三行纯文本，**不含 token**，贴给别人就能排障。
- 🔒 **token 脱敏** —— 日志里只出现 `sha256(token)` 前 8 位，任何路径都不打 token 明文。
- 🔄 **构建即热更** —— `scripts/link.mjs` 把 profile 里那条 insert 的 `name` 写成带 `?v=<mtime>` 的绝对 `file://` URL（DSH loader 支持，`dshmarket` 自己也是这么做的），改完 `npm run build` 几秒内宿主就换新代码，不用重启桌面端。

---

## 安装

```bash
# 1. 装依赖 + 构建
npm install
npm run build            # → lib/index.js + lib/client.js

# 2. 链进 DSH profile（写 file URL，顺便支持热更）
node scripts/link.mjs

# 3. 让正在运行的 DSH 立刻加载
npm run revive

# 4. 看状态
curl -s http://127.0.0.1:57292/plugins/dsh-raccoon-web/status
```

`status` 里 `publish: "published"` + `catalogReady: true` + `login.source: "desktop"` 就代表接上了。

### 前置

- **桌面端路线**：装过并登录过「商汤小浣熊」桌面客户端（`C:\Program Files\@raccoonoffice-desktop\`），凭据文件在 `~/.office-raccoon/agent/config/auth.json`。
- **扫码路线**：手机微信能扫普通 QR 码。
- DSH 0.2.1-rc.1 及以上（`peerDependencies` 逐段列出 0.2.x 的每个预发布区间，因为 node-semver 的预发布规则要求这样写 —— 写成 `>=0.2.1-rc.1 <0.3` 匹配不到 `0.2.2-rc.1`）。

---

## 工作原理

```
┌─────────────────┐   只读   ┌──────────────────────────────┐
│ 官方桌面客户端   │ ───────► │ ~/.office-raccoon/agent/     │
│ (可选，首选)     │          │ config/auth.json             │
└─────────────────┘          └──────────────┬───────────────┘
                                            │ access_token (IAM JWT)
┌─────────────────┐   扫码   ┌──────────────▼───────────────┐
│ 手机微信         │ ───────► │ LoginFlow (none/pending/     │
│ (兜底)           │          │ logging/ready/expired/error) │
└─────────────────┘          └──────────────┬───────────────┘
                                            │ StoredToken{kind, source}
                              ┌─────────────▼──────────────┐
                              │ Publisher（三元门控）        │
                              │ enabled? token? models?     │
                              └─────────────┬──────────────┘
                                            │ 先释放再注册（不能 replace）
                              ┌─────────────▼──────────────┐
                              │ PiAiAdapter + createRaccoon │
                              │ Api（onPayload 注入 extra_  │
                              │ body.thinking）             │
                              └─────────────┬──────────────┘
                                            │
                              ┌─────────────▼──────────────┐
                              │ DSH 模型选择器 / 对话       │
                              └────────────────────────────┘
```

**为什么必须「先释放再注册」**：`LlmService.registerAdapter()` 返回的句柄带 `replace(providers)`，但它**返回 `void`**，而且 **adapter 是构造时闭包捕获的，`replace` 换不掉实例**。而本插件换名册必须换 `PiAiAdapter` 实例（`PiAiAdapter.current()` 用 `profiles()` 的**引用相等**做 memo）。所以每次换名册都是 `release()` + `registerAdapter()`，全程只有一个活着的 registration。

---

## 三处与「标准 OpenAI」不同

| 差异 | 我们的做法 | 依据 |
| --- | --- | --- |
| 思考开关 | `extra_body: {thinking:{type:"enabled"/"disabled"}}`（顶层 `thinking` 也行，`enable_thinking` 无效） | E-035 |
| 思考内容 | 回在 `delta.reasoning_content`（非标准字段），由 pi-ai 的 `reasoningFields` 原生识别 | E-020 |
| `max_tokens` | 必须发 `max_tokens`，不能发 `max_completion_tokens` | E-020、E-032 |

---

## 三个开关怎么选

| 开关 | 默认 | 什么时候改 |
| --- | --- | --- |
| `登录来源` `authSource` | `auto`（客户端优先，读不到回落扫码） | 只想用扫码时选 `qr`；客户端凭据过期想强制报错而不是静默回落，选 `desktop` |
| `扫码协议` `qrProtocol` | `web`（官方桌面端同款） | 手机习惯扫小程序码时选 `iam`。**两种码互不通用** |
| `上下文上限` `contextCap` | `128000` | 上游给的是 1M，但小浣熊的限流按**账号 token 吞吐**算，一轮对话越大越快撞到。调到 128000 是主动降级换"能连续问几轮" |
| `思考` `reasoning` | `true` | 关掉后思考显著变短（260 → 82 字符），但**不会完全消失** |
| `识图实测覆盖` `visionProbeOverride` | `false` | 打开后以逐模型探测结果覆盖目录标签 |

---

## 排障

| 症状 | 先看这里 |
| --- | --- |
| 模型选择器里没有小浣熊 | `status` 的 `settings.enabled` / `publish` / `desktopAuth.found` |
| `publish: "not-configured"` | 没读取到凭据。`status.desktopAuth.reason` 会写原因（"未找到…已回退到扫码" / "…已过期"） |
| 设置卡有模型但对话报"未登录" | token 在启动后过期了。点「读取客户端登录态」重跑一次 |
| 二维码扫不出来 | `status.login.qrSvg` 存在但手机扫不出 → 大概率是 QR 版本信息块问题；本仓库 `node scripts/verify-qr.mjs` 用 OpenCV 双检测器验证 |
| 二维码刚生成就"已过期" | **别在贴码之后再点「扫码登录」**。那会作废旧码（E-029） |
| 对话报"吞吐已达上限" | 上游限流，按账号 token 速率算。等一会儿，或把 `contextCap` 调小 |
| 对话报"登录已失效" | `200003` / `401`。桌面端路线 → 打开客户端重新登录；扫码路线 → 重新扫 |
| 改了代码宿主没反应 | `npm run build && npm run revive`（`lib/index.js` 不会自动热更） |

---

## 不做的六件事

1. **不提供账号，不共享凭据，不发遥测。**
2. **不代领每日积分。** 只读。
3. **不做多账号池。** 一个 profile 一个号。
4. **不抄浏览器 cookie、不碰凭据管理器、不 attach 进程内存。** 只读那一个文件。
5. **不做请求录制。** 日志里不该有用户说了什么。
6. **不做自动重连。** 浣熊没有 `Last-Event-ID` 续传，重连只会撞限流。

---

## 文档

- [工程总览](../../README.md) —— 30 秒知道这是什么
- [文档地图](../../docs/00-index.md) —— 全部文档的入口
- [协议手册](../../docs/01-research/03-raccoon-protocol.md) —— 网关长什么样
- [实测记录](../../docs/01-research/05-empirical-findings.md) —— 每条断言的时间戳与复现命令
- [ADR-0008 桌面端凭据](../../docs/02-design/adr/0008-desktop-credential-reuse.md) / [ADR-0009 Web auth 扫码](../../docs/02-design/adr/0009-web-auth-qr-protocol.md)
- [排障手册](../../docs/04-ops/01-troubleshooting.md)

## License

MIT
