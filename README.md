# dsh-raccoon-web

> 把**商汤小浣熊（Raccoon / xiaohuanxiong.com）**接成 DSH 里的一个 LLM provider。
> **默认直接复用官方桌面客户端已登录的账号**（读 `~/.office-raccoon/agent/config/auth.json`，只读），读不到再扫码。

一句话定位：**上一代小浣熊反代插件全部失效，不是因为作者不维护，而是因为它们读的凭据路径 `~/.box-agent/config/auth.json` 已经不用了——官方客户端在 Windows 上把 profile 迁到了 `~/.office-raccoon`。本项目同时支持两条路：直接复用客户端登录态（首选）与扫码（兜底），两条路由共用同一套 provider 装配。**

---

## 现在是什么状态

**插件已在真宿主里跑通完整链路**：桌面端凭据 → 真目录（6 个可见模型）→ 真对话（SSE 流式 + 思考区）→ 真余额 → 多账号池。

| 阶段 | 状态 |
| --- | --- |
| 竞品/参考实现调研 | ✅ 完成（[盘点与失效归因](docs/01-research/02-prior-raccoon-plugins.md)） |
| 协议逆向与实测验证 | ✅ 完成（**E-001~E-039 已无待补项**，见 [实测记录](docs/01-research/05-empirical-findings.md)） |
| 官方客户端 app.asar 逆向 | ✅ 完成（凭据契约、两套扫码协议、账号 API 全景、签到接口） |
| 架构与 ADR | ✅ 完成（[8 篇设计](docs/02-design/) + [11 个 ADR](docs/02-design/adr/)） |
| 开发计划 / 测试计划 / 发布计划 | ✅ 完成（[路线图](docs/03-plan/00-roadmap.md) / [WBS](docs/03-plan/01-wbs.md)） |
| 插件实现 | ✅ protocol 10 文件 / provider 4 / host 11 / 手写 `client.js`（1,525 行） |
| 单元测试 | ✅ **220 个用例 / 45 个 suite 全绿** |
| 冒烟测试 | ✅ `smoke-host` + `smoke-provider` + `smoke-pool` + `smoke-client-apply` + `smoke-desktop-auth` + `smoke-chat-live` |
| 真宿主加载 | ✅ 已链入 `~/.dsh/profiles/desktop`，构建即热更 |
| 桌面端凭据登录 | ✅ **实测通过**：`login.source:"desktop"`、6 模型、首字节 1637ms |
| 账号池 / 自动换号 / 一键签到 | ✅ 已实机跑通（导入、测试、勾选、开关、诊断第 14 行）；签到 `granted:true` 分支待次日零点 |
| 两个扫码入口隔离 | ✅ 靠 `login.mode` 认领（修掉池区显示主登录二维码的串台） |
| 扫码登录（Web auth） | 🟡 二维码已在真宿主下发，OpenCV 双检测器解出正确内容，**待人工确认一次** |
| 识图能力 | ✅ **实测两种形式都支持**（公网 URL 与 `data:` base64），见 E-018 |

自检一把跑完：

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup → lib/index.js + 复制 client.js
npm test            # 220 个用例 / 45 个 suite
npm run smoke       # 宿主半身 + provider + 号池（不碰网络）
npm run smoke:client        # 离线跑一遍 client.js 的 apply（复现"设置页空白"）
npm run smoke:client:twice  # 模拟同一包被加载两次（locale 重复注册）
npm run smoke:live  # 桌面端凭据 → 真网关（读真实 token）
npm run smoke:chat  # 真对话（会花少量积分）
node scripts/verify-install.mjs   # 24 项静态检查
npm run revive      # 让运行中的 DSH 立刻用上新构建
```

进度看 [开发日志](devlog/)；文档入口看 [docs/00-index.md](docs/00-index.md)。

---

## 为什么不是"再 fork 一个旧插件"

已存在的四个小浣熊 DSH 插件，全部死在同一处：

- `dsh-raccoon-connect@0.2.4`（1346 下载/月，fork 自 `dsh-raccoon-work`）——读 `~/.box-agent/config/auth.json`
- `magpie-raccoon-auth@0.3.2` —— magpie 框架，不是 DSH 原生插件
- `dsh-raccoon@0.0.1` —— 占位包，没有实现
- `dsh-raccoon-checkin` —— 给别的插件打 `node_modules` 补丁，上游一变就碎

根本原因：**取凭据的入口换了**。桌面端把 profile 从 `~/.box-agent` 迁到 `~/.office-raccoon`（E-030），网页端另有一套 IAM 扫码。旧插件读一个已经不存在的文件，再怎么补丁也救不回来。

`dsh-connect-sensenova-token-plan@0.8.6` 里其实已经内建了一份可用的小浣熊实现（走扫码），但它是 sensenova 插件的附属功能：provider id 写死 `sensenova-raccoon`、开关和 sensenova 的积分体系绑在一起、模型名带 `sn-` 前缀、`reasoning: false` 放弃了思考通道。想要一个干净、独立、能自己迭代的小浣熊 provider，就得单独做一个。

详见 [旧插件盘点与失效归因](docs/01-research/02-prior-raccoon-plugins.md)。

---

## 设计取舍（先看这六条，细节在 ADR）

1. **首选复用官方客户端的登录态，扫码兜底。** 客户端把凭据写在 `~/.office-raccoon/agent/config/auth.json`（[ADR-0008](docs/02-design/adr/0008-desktop-credential-reuse.md)）。插件**只读**那个文件：不写回、不复制副本、不读浏览器 cookie、不碰凭据管理器。读不到或过期才回落到扫码，用户也可以在设置里强制只用其中一条。
2. **扫码默认用官方桌面端那套 Web auth 协议。** code 本地生成（13 位时间戳 + 32 hex）、`appname=小浣熊官网`、`POST /api/web/auth/v1/login_with_qrcode_code`（[ADR-0009](docs/02-design/adr/0009-web-auth-qr-protocol.md)）。IAM 小程序码作为可选协议保留。
3. **自己实现二维码编码器。** 不引 `qrcode` 依赖 —— 插件跑在宿主进程里，多一个依赖就多一处可能跟 Electron 版本打架。byte 模式 + 纠错 M + 版本 1–10 足够（实测两种码分别 139 / 149 字节，都落在版本 8）。已用 OpenCV 双检测器做过 12 个容量边界 + 40 次 fuzz 验证。
4. **思考通道走 `extra_body.thinking`。** 包装 `openAICompletionsApi()`，在 `onPayload` 里注入 `extra_body`，思考内容由 pi-ai 原生解析 `delta.reasoning_content`（[ADR-0007](docs/02-design/adr/0007-wrap-openai-completions-api.md)）。实测关掉思考后仍有少量 reasoning 回吐，UI 容忍。
5. **账号池是"并列的第二身份来源"，不是替换。** 每个成员显式勾选才会被拿去发请求，空池绝不退化成"全部账号"；每个账号有独立稳定的 `X-Client-Device-ID`（[ADR-0010](docs/02-design/adr/0010-account-pool.md)）。**"独立环境"指的是设备标识隔离，不是指纹伪造，也不承诺防封** —— 任何插件都做不到那个。
6. **签到只做"领取本来属于这个账号的当日积分"。** 用官方桌面端自己的接口 `POST /api/web/desktop/v1/login/points/grant`（E-036），先查后写、单个失败不中断、**与自动换号开关解耦**（关掉自动换号仍能签到）。不做多账号轮询刷分，不做任何绕过额度的动作。
   > 这条推翻过早期判断"绝不替用户领每日积分"。推翻理由：那个接口就是官方客户端的领取动作、幂等、无副作用，且积分属于账号本人；当初的顾虑是"重放 `setting_info` 骗发放"，与调用官方接口不是一回事。

---

## 目录

```
.
├── docs/                       # 全部文档（索引见 docs/00-index.md）
│   ├── 01-research/            # 调研：参考插件、协议、内核 API、实测（E-001~E-039）
│   ├── 02-design/              # 设计：架构、模块、数据、UI、错误、账号池
│   │   └── adr/                # 架构决策记录（11 篇）
│   ├── 03-plan/                # 计划：路线图、WBS、测试、发布、风险
│   └── 04-ops/                 # 运维：开发环境、排障、可观测
├── devlog/                     # 开发日志，一天一篇
├── packages/dsh-raccoon-web/   # 插件本体
│   ├── src/protocol/           # 协议层：常量、错误、请求头、QR、IAM、Web auth、目录、对话、积分、桌面端凭据
│   ├── src/provider/           # 适配层：pi-ai Api 包装、名册、adapter 装配
│   ├── src/host/               # 宿主半身：设置、状态、路由、登录流程、发布器、存储、账号池
│   └── client.js               # 浏览器半身（手写 classic script，1,525 行）
├── research/                   # 下载下来的参考包原文（不提交）
└── scripts/                    # 探针、链接、校验、冒烟、热更脚本
```

## 快速开始

```bash
npm install

# 探网关通不通（不需要登录）
node scripts/probe-gateway.mjs

# 把本地插件链进 DSH profile（写带 ?v= 的 file URL，等于顺便支持热更）
node scripts/link.mjs

# 构建 + 让运行中的 DSH 立刻加载新构建
npm run build && npm run revive

# 看状态（端口用 DSH 实际监听的那个，每次启动会变）
curl -s http://127.0.0.1:<PORT>/plugins/dsh-raccoon-web/status | head -c 400
```

---

## 风险与边界

- **不保证长期可用。** 网关是私有的，端点、请求头、鉴权随时可能变。所以本项目把**协议层和适配层分开**：协议变了只改 `src/protocol/`，适配层不动。
- **不提供账号，不共享凭据。** 桌面端凭据只在本机读一次、只进内存；扫码 token 存在你自己机器的 profile 目录里。不上传任何地方，**不发任何遥测**。
- **不绕过计费。** 每次调用消耗的是你自己小浣熊账号的积分。
- **限流是按账号 token 吞吐算的**，不是每分钟请求数。一轮对话上下文越大越快撞到，撞到后额度缓慢回血，上游不给恢复时间。插件会把这句话原样告诉用户，而不是静默重试到死。
- **`~/.office-raccoon` 是官方客户端的私有目录。** 我们只读 `agent/config/auth.json` 这一个文件，不写、不搬、不缓存副本。客户端退出登录后，插件下次启动会自然跟着失效。

## License

MIT
