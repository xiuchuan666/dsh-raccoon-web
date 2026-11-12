# 文档索引

> 这个文件是文档**唯一**的入口。加文档必须在这里登记，否则等于没写。

## 阅读路线

**第一次进来**（30 分钟搞清全貌）
`../README.md` → `01-research/00-overview.md` → `02-design/00-architecture.md` → `03-plan/00-roadmap.md`

**要写代码**
`02-design/01-module-map.md` → `02-design/02-data-flow.md` → `01-research/03-raccoon-protocol.md` → 相关 ADR

**要排障**
`04-ops/01-troubleshooting.md` → `01-research/05-empirical-findings.md` → `04-ops/02-observability.md`

**要发布**
`03-plan/03-release-plan.md` → `04-ops/00-dev-environment.md`

---

## 00 元

| 文档 | 说明 |
| --- | --- |
| [00-index.md](00-index.md) | 本文件 |
| [../AGENTS.md](../AGENTS.md) | 协作规矩（AI 与人类都适用） |
| [../devlog/](devlog/) | 开发日志，一天一篇 |

## 01 调研（research）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-overview.md](01-research/00-overview.md) | 调研范围、方法、结论摘要 | ✅ |
| [01-reference-plugins.md](01-research/01-reference-plugins.md) | 三个参考插件（workbuddy / trae / minimaxcode）的写法拆解 | ✅ |
| [02-prior-raccoon-plugins.md](01-research/02-prior-raccoon-plugins.md) | 已有的四个小浣熊反代，逐个盘点 + 失效归因 | ✅ |
| [03-raccoon-protocol.md](01-research/03-raccoon-protocol.md) | 小浣熊网关协议手册（本项目最重要的一份；全部字段按 E-001~E-039 回填） | ✅ |
| [04-dsh-kernel-api.md](01-research/04-dsh-kernel-api.md) | DSH 0.2.2-rc.1 插件内核契约（含 `AdapterRegistrationHandle` 三处纠正、`settings.section`、`locale.register` 重复抛错） | ✅ |
| [05-empirical-findings.md](01-research/05-empirical-findings.md) | 实测记录 E-001~E-039，带时间戳，可复现命令 | ✅ |
| [06-open-questions.md](01-research/06-open-questions.md) | 还没搞清的问题 + 验证方法 | ✅ |

## 02 设计（design）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-architecture.md](02-design/00-architecture.md) | 分层架构、进程边界、生命周期、两个凭据来源、明确不做的六件事 | ✅ |
| [01-module-map.md](02-design/01-module-map.md) | 模块清单（带实测行数）、职责、依赖方向、文件大小预算 | ✅ |
| [02-data-flow.md](02-design/02-data-flow.md) | 冷启动 / 凭据解析 / 扫码登录 / 目录刷新 / 流式对话 / 积分 / 卸载全链路 | ✅ |
| [03-state-and-storage.md](02-design/03-state-and-storage.md) | 凭据与状态存哪、两种来源的落盘差异、清理与安全边界 | ✅ |
| [04-ui-surfaces.md](02-design/04-ui-surfaces.md) | 客户端半身：三个 slot（含 `settings.section` 设置菜单入口）、设置卡、积分药丸、二维码页、五开关、账号池（含两个扫码入口靠 `login.mode` 认领）、14 行诊断 | ✅ |
| [05-error-model.md](02-design/05-error-model.md) | 错误分类、用户文案、重试策略 | ✅ |
| [06-coding-conventions.md](02-design/06-coding-conventions.md) | 代码风格、命名、注释、日志 | ✅ |
| [07-account-pool.md](02-design/07-account-pool.md) | 账号池：数据模型、选号排序、测量分类、八个 action、独立设备身份 | ✅ |

### ADR（架构决策记录）

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](02-design/adr/0001-login-via-web-qr.md) | 登录路线：网页扫码，不碰桌面端凭据 | **部分被推翻** → 0008 |
| [0002](02-design/adr/0002-self-contained-qr-encoder.md) | 自己实现二维码编码器，不引 `qrcode` | Accepted |
| [0003](02-design/adr/0003-reasoning-channel.md) | 思考通道：自定义 pi-ai Api 注入 `extra_body.thinking` | Superseded by 0007 |
| [0004](02-design/adr/0004-protocol-adapter-split.md) | 协议层与适配层分离 | Accepted |
| [0005](02-design/adr/0005-pi-ai-adapter-over-raw-llmadapter.md) | 用 `PiAiAdapter` 而不是裸 `LlmAdapter` | Accepted |
| [0006](02-design/adr/0006-vision-detection-by-probe.md) | 识图能力按实测，不信目录标签 | Accepted |
| [0007](02-design/adr/0007-wrap-openai-completions-api.md) | 思考通道：包装 `openAICompletionsApi` + `onPayload` 注入 | Accepted（取代 0003） |
| [0008](02-design/adr/0008-desktop-credential-reuse.md) | 只读官方桌面客户端凭据，作为首选登录方式 | Accepted（取代 0001 的凭据部分；第 77 行表述由 0011 补正） |
| [0009](02-design/adr/0009-web-auth-qr-protocol.md) | 扫码默认走官方桌面端的 Web auth 协议，IAM 码留作备选 | Accepted（第 91 行表述由 0011 补正；Web auth 码页面 2026-11-12 起 404，见 0012 / E-040） |
| [0010](02-design/adr/0010-account-pool.md) | 账号池：多账号并列第二身份来源，独立设备标识，额度用尽自动换号 | Accepted |
| [0011](02-design/adr/0011-no-token-refresh.md) | 不实现 token 自动续期：续期接口存在，但 rotate 会踢掉官方客户端 | Accepted（补正 0008/0009 的一条事实表述） |
| [0012](02-design/adr/0012-browser-loopback-login.md) | 账号池加号走浏览器 loopback（`/authorize` + 本机回调 + 授权码换 token），扫码降为备用 | Accepted（`/login/mp` 已 404，见 E-040） |

## 03 计划（plan）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-roadmap.md](03-plan/00-roadmap.md) | 阶段划分、里程碑、验收标准 | ✅ |
| [01-wbs.md](03-plan/01-wbs.md) | 工作分解（任务级估时 + 三轮实际耗时回填） | ✅ |
| [02-test-plan.md](03-plan/02-test-plan.md) | 测试策略、用例清单、夹具（263 tests / 52 suites） | ✅ |
| [03-release-plan.md](03-plan/03-release-plan.md) | 版本号、发布流程、回滚 | ✅ |
| [04-risks.md](03-plan/04-risks.md) | 风险登记册 | ✅ |

## 04 运维（ops）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-dev-environment.md](04-ops/00-dev-environment.md) | 本机环境、五个中文路径坑、怎么链进 DSH、构建热更 | ✅ |
| [01-troubleshooting.md](04-ops/01-troubleshooting.md) | 分诊树 → 症状 → 原因 → 处置（含两码互不通用、E-029） | ✅ |
| [02-observability.md](04-ops/02-observability.md) | 44 个日志事件、status 形状、14 行诊断、token 脱敏规则 | ✅ |

---

## 文档规范

- **命名**：`NN-kebab-case.md`，NN 是两位序号，同目录内递增。不加日期后缀（日期写进正文的"最后更新"）。
- **开头四行**：标题、一句话说明、`最后更新: YYYY-MM-DD`、`状态: 草稿 | 评审中 | 已定稿 | 已过期`
- **断言必须带证据**：涉及外部网关的行为，写"2026-11-06 实测 xxx"，不写"应该"。
- **代码引用带路径和行号**：`packages/dsh-raccoon-web/src/protocol/auth.ts:42`，不写"那个文件"。
- **过期文档就地标注**，不删除。加一行 `> ⚠️ 本文描述的行为已在 YYYY-MM-DD 失效，见 xxx`。

---

## 当前文档与实现的对齐状态（2026-11-12 凌晨，0.2.0 + 未发布改动）

四轮改动（换桌面端凭据路线 → 补 `settings.section` → 加账号池 → E-018/E-019/E-037 实测收口）之后，又做了六轮"自主收口"，然后 2026-11-12 处理用户报的三个 bug（换号后旧号消失、客户端退出后 401、扫码加号收不到登录）。**E-001 ~ E-040 已无待补项**，回来时需要先确认的只剩四件事：

1. **`/login/mp` 已在服务端下线**（E-040）：Web auth 扫码（协议 B）恒 404，用户微信扫完只会看到「二维码已过期或已被使用」。**加号主路线已改成浏览器 loopback**（ADR-0012 / `protocol/loopback.ts` / `pool-add-browser`），扫码降为备用（IAM 小程序码未受影响）。这条不是我们的 bug，是上游行为变更。
2. **浏览器登录的"真的登进去"这一段没人跑过**：验过起服务、URL 形状、三条拒收判据（错 state / 错路径 / 假 code），但**"用户在浏览器里真的登录 → 回调带回真 code → 换到真 token → 进池"整段未实测**。同样，扫码登录（协议 A）也从没被真人用手机扫过一次。
3. **号池签到只验过"幂等返回 false"**：2026-11-11 实测当日已领时返回 `{"code":0,"data":{"granted":false}}`，**没验过真的领到 `granted:true`**（需要等到次日北京零点后）。`pool-checkin` 整批流程未在真宿主跑过。
4. **首字节 60s 超时的落地差距**：`FIRST_BYTE_TIMEOUT_MS = 60_000` 写在协议层，但真链路走 `PiAiAdapter` 时生效的是 `streamIdleTimeoutMs = 300_000`（帧间 idle）。见 [02-data-flow.md §超时与重试](02-design/02-data-flow.md)。

**已收口的实测**（不再需要回来确认）：

| 项 | 结论 |
| --- | --- |
| E-018 图片 | URL 与 `data:` base64 **都支持**；裸 base64 会被当 URL 去下载 |
| E-019 体积上限 | 约 **3.0001 MiB**（3,145,650 ± 50 字节），**返回 400 不是 413** |
| E-037 token 续期 | 端点存在、字段名 `token`、格式不可猜；**refresh 会 rotate → 不做自动续期** |
| E-036 签到 | `POST /api/web/desktop/v1/login/points/grant`（无 body），幂等 |
| E-038 设备身份 | `X-Client-Device-ID` 是唯一设备身份头 |
| E-039 倍率 | 真实倍率看 `billing_effective_multiplier`，`billing_multiplier` 是标价 |
| E-040 扫码链路 | `/login/mp` **恒 404**（路由已下线）；官方换账号走 `/authorize` + loopback；`login_with_authorization_code` 对假 code → 400/200035 |

**M1–M4 已达成，M5 待发布。** 版本 `0.2.0`，`BUILD = 2026-11-12T01:20`，测试 `263 / 52 suites`。
