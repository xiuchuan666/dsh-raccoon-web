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
| [03-raccoon-protocol.md](01-research/03-raccoon-protocol.md) | 小浣熊网关协议手册（本项目最重要的一份；全部字段按 E-001~E-035 回填） | ✅ |
| [04-dsh-kernel-api.md](01-research/04-dsh-kernel-api.md) | DSH 0.2.1-rc.5 插件内核契约（含 `AdapterRegistrationHandle` 三处纠正） | ✅ |
| [05-empirical-findings.md](01-research/05-empirical-findings.md) | 实测记录 E-001~E-035，带时间戳，可复现命令 | ✅ |
| [06-open-questions.md](01-research/06-open-questions.md) | 还没搞清的问题 + 验证方法 | ✅ |

## 02 设计（design）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-architecture.md](02-design/00-architecture.md) | 分层架构、进程边界、生命周期、两个凭据来源、明确不做的六件事 | ✅ |
| [01-module-map.md](02-design/01-module-map.md) | 模块清单（带实测行数）、职责、依赖方向、文件大小预算 | ✅ |
| [02-data-flow.md](02-design/02-data-flow.md) | 冷启动 / 凭据解析 / 扫码登录 / 目录刷新 / 流式对话 / 积分 / 卸载全链路 | ✅ |
| [03-state-and-storage.md](02-design/03-state-and-storage.md) | 凭据与状态存哪、两种来源的落盘差异、清理与安全边界 | ✅ |
| [04-ui-surfaces.md](02-design/04-ui-surfaces.md) | 客户端半身：三个 slot（含 `settings.section` 设置菜单入口）、设置卡、积分药丸、二维码页、五开关、13 行诊断 | ✅ |
| [05-error-model.md](02-design/05-error-model.md) | 错误分类、用户文案、重试策略 | ✅ |
| [06-coding-conventions.md](02-design/06-coding-conventions.md) | 代码风格、命名、注释、日志 | ✅ |

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
| [0008](02-design/adr/0008-desktop-credential-reuse.md) | 只读官方桌面客户端凭据，作为首选登录方式 | Accepted（取代 0001 的凭据部分） |
| [0009](02-design/adr/0009-web-auth-qr-protocol.md) | 扫码默认走官方桌面端的 Web auth 协议，IAM 码留作备选 | Accepted |

## 03 计划（plan）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-roadmap.md](03-plan/00-roadmap.md) | 阶段划分、里程碑、验收标准 | ✅ |
| [01-wbs.md](03-plan/01-wbs.md) | 工作分解（任务级估时 + 两轮实际耗时回填） | ✅ |
| [02-test-plan.md](03-plan/02-test-plan.md) | 测试策略、用例清单、夹具 | ✅ |
| [03-release-plan.md](03-plan/03-release-plan.md) | 版本号、发布流程、回滚 | ✅ |
| [04-risks.md](03-plan/04-risks.md) | 风险登记册 | ✅ |

## 04 运维（ops）

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [00-dev-environment.md](04-ops/00-dev-environment.md) | 本机环境、五个中文路径坑、怎么链进 DSH、构建热更 | ✅ |
| [01-troubleshooting.md](04-ops/01-troubleshooting.md) | 分诊树 → 症状 → 原因 → 处置（含两码互不通用、E-029） | ✅ |
| [02-observability.md](04-ops/02-observability.md) | 34 个日志事件、status 形状、13 行诊断、token 脱敏规则 | ✅ |

---

## 文档规范

- **命名**：`NN-kebab-case.md`，NN 是两位序号，同目录内递增。不加日期后缀（日期写进正文的"最后更新"）。
- **开头四行**：标题、一句话说明、`最后更新: YYYY-MM-DD`、`状态: 草稿 | 评审中 | 已定稿 | 已过期`
- **断言必须带证据**：涉及外部网关的行为，写"2026-11-06 实测 xxx"，不写"应该"。
- **代码引用带路径和行号**：`packages/dsh-raccoon-web/src/protocol/auth.ts:42`，不写"那个文件"。
- **过期文档就地标注**，不删除。加一行 `> ⚠️ 本文描述的行为已在 YYYY-MM-DD 失效，见 xxx`。

---

## 当前文档与实现的对齐状态（2026-11-06）

换路线（默认复用官方桌面客户端凭据）之后，以上带 ✅ 的文档**全部按真实现重写过一遍**，不是初版估测。三处需要回来时先确认：

1. **仍缺实测**：E-018（图片是否必须 base64 data URL）、E-019（413 确切阈值）、E-036~E-039（SSE error 帧真形状 / 版本号是否校验 / `x-raccoon-session-id` 影响 / 凭据过期后客户端怎么续）。见 [03-raccoon-protocol.md §10](01-research/03-raccoon-protocol.md)。
2. **扫码端到端未人工确认**：两套协议的取码、轮询、success 分支都只有单测与 OpenCV 解码验证，**用户从未用手机确认过一次登录**。桌面端凭据路线已实机跑通。
3. **首字节 60s 超时的落地差距**：`FIRST_BYTE_TIMEOUT_MS = 60_000` 写在协议层，但真链路走 `PiAiAdapter` 时生效的是 `streamIdleTimeoutMs = 300_000`（帧间 idle）。见 [02-data-flow.md §超时与重试](02-design/02-data-flow.md)。

**M1–M4 已达成，M5 待发布。** 版本 `0.1.0`，`BUILD = 2026-11-06T12:35`。
