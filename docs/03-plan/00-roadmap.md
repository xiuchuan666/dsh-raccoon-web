# 路线图

最后更新: 2026-11-06
状态: 已定稿

> 五个里程碑，每个都有**可验证的完成标准**。不写"基本完成"。

---

## 总览

| 里程碑 | 目标 | 估时 | 完成标准 |
| --- | --- | --- | --- |
| **M0** | 前期准备 | ✅ 已完成 | 文档齐、目录齐、日志齐 |
| **M1** | 能装、能起、能显示 | 1.5 天 | DSH 里能看到插件，设置卡打开，二维码出得来 |
| **M2** | 能登录 | 1 天 | 手机扫码 → token 落盘 → 出现在模型选择器 |
| **M3** | 能对话 | 2 天 | 流式回复、思考内容、多轮、工具调用 |
| **M4** | 能看余额、能排障 | 1 天 | 药丸、余额条、诊断块、识图探测 |
| **M5** | 能发布 | 0.5 天 | 打包、`pnpm link` 进 DSH、README |

**合计约 6 天**（不含网关协议变更带来的返工）。

依赖关系：

```
M0 ──→ M1 ──→ M2 ──→ M3 ──→ M4 ──→ M5
                  │
                  └──→ M4（余额可以在登录后先做）
```

M3 与 M4 有一半可以并行（M4 的余额/诊断不依赖 M3），但识图探测依赖 M3 的 chat 通路。

---

## M0 · 前期准备（✅ 已完成 2026-11-06）

### 交付物

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 工程目录 | `packages/dsh-raccoon-web/` | ✅ |
| 工作区配置 | `package.json` / `pnpm-workspace.yaml` | ✅ |
| 顶层文档 | `README.md` / `AGENTS.md` | ✅ |
| 文档索引 | `docs/00-index.md` | ✅ |
| 调研（7 篇） | `docs/01-research/` | ✅ |
| 设计（7 篇） | `docs/02-design/` | ✅ |
| ADR（6 篇） | `docs/02-design/adr/` | ✅ |
| 计划（5 篇） | `docs/03-plan/` | ✅ |
| 运维（3 篇） | `docs/04-ops/` | ✅ |
| 开发日志 | `devlog/` | ✅ |
| 探测脚本 | `scripts/probe-gateway.mjs` 等 | ✅ |

### 完成标准（已达成）

- [x] 六份已有实现全部盘点，失效原因归因到具体文件/行号
- [x] 浣熊协议有完整规格书（`03-raccoon-protocol.md`）
- [x] DSH 内核契约有完整说明（`04-dsh-kernel-api.md`）
- [x] 所有"网关会这样"的断言都有实测记录或标明"待实测"
- [x] 架构、模块、数据流、状态、UI、错误、约定七篇设计文档齐
- [x] 六个关键决策有 ADR，每个都写了"否决了什么、为什么"
- [x] 路线图、WBS、测试计划、发布计划、风险登记册齐

---

## M1 · 能装、能起、能显示

**目标**：把骨架立起来，在 DSH 里跑通"加载 → 显示"。

### 任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 1.1 | `packages/dsh-raccoon-web/` 骨架 | `package.json` / `tsconfig.json` / `tsup.config.ts` |
| 1.2 | `src/types/*.d.ts` 最小声明 | 内核包与 pi-ai 的类型桩 |
| 1.3 | `src/protocol/consts.ts` | 全部常量 |
| 1.4 | `src/protocol/errors.ts` | `RaccoonError` |
| 1.5 | `src/protocol/qr.ts` | 二维码编码器 + SVG |
| 1.6 | QR 单测 | 版本选择 / 版本信息块 / 定位图案 |
| 1.7 | `src/index.ts` 最小版 | `name` / `inject` / `apply` 空实现 + 日志 |
| 1.8 | `cordis.patch.yml` | `- id: llm-raccoon-web` |
| 1.9 | `client.js` 最小版 | 注册两个 slot，渲染"小浣熊 未登录" |
| 1.10 | `src/host/routes.ts` 最小版 | `GET /status` 返回 `{phase:"none"}` |
| 1.11 | `scripts/link.mjs` | 把包链进 `~/.dsh/profiles/desktop` |
| 1.12 | 在 DSH 里验证 | 设置页出现"小浣熊"卡片，能打开 |

### 完成标准

- [ ] `pnpm -w run typecheck` 通过
- [ ] `pnpm -w run build` 产出单文件 `lib/index.js`（无 chunk）
- [ ] DSH 重启后，设置 → 插件 → 小浣熊 卡片存在，能展开
- [ ] 输入框左侧出现 `🦝 未登录`
- [ ] **二维码能被真实手机扫出来，且内容正确**（用手机相机扫，看 URL 是否 = `https://xiaohuanxiong.com/login/mp?code=...`）
- [ ] DSH 日志里有 `[raccoon-web] loaded`

### 风险

| 风险 | 应对 |
| --- | --- |
| 二维码扫不出来 | 见 [R2](04-risks.md) |
| `ctx.profile.home` 拿不到 | 三级兜底（`03-state-and-storage.md` §9） |
| `client.js` 加载失败但无报错 | `__ModuleLoader__` 为 undefined 时早退；加 `console.info` 确认执行到 |

---

## M2 · 能登录

**目标**：扫码 → token 落盘 → adapter 注册 → 模型出现在选择器。

### 任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 2.1 | `src/protocol/iam.ts` | `createQr` / `qrContent` / `pollQr` / `confirmSession` / `validateToken` |
| 2.2 | `src/protocol/headers.ts` | 三种头组合 |
| 2.3 | `src/protocol/catalog.ts` | `fetchCatalog` / `parseCatalog`（多键名兼容） |
| 2.4 | `src/host/store.ts` | token 原子读写 |
| 2.5 | `src/host/login-flow.ts` | 状态机 + 2s 轮询 + deadline 重置 |
| 2.6 | `src/host/routes.ts` 扩展 | `login-start` / `login-poll` / `login-cancel` / `logout` |
| 2.7 | `src/provider/fallback-roster.ts` | 6 个模型的离线名册 |
| 2.8 | `src/provider/roster.ts` | `RaccoonModel` → descriptor |
| 2.9 | `src/provider/adapter.ts` | `createProvider` + `PiAiAdapter` |
| 2.10 | `src/host/publish.ts` | 三元门控 |
| 2.11 | `client.js` 二维码面板 | SVG 渲染 + 倒计时 + 状态文案 |
| 2.12 | 端到端验证 | 手机扫码 → 模型出现 |

### 完成标准

- [ ] 点"扫码登录"后 **3 秒内**出现二维码
- [ ] 手机微信扫码 → 手机上显示"确认登录" → 点确认 → DSH 界面 **5 秒内**变成"已登录"
- [ ] `~/.dsh/profiles/desktop/raccoon-web/token.json` 存在，内容含 `token` 与 `principal`
- [ ] 模型选择器出现「小浣熊」，列出目录里的模型
- [ ] 关掉 DSH 再开，仍然是"已登录"（token 持久化生效）
- [ ] 点"退出登录" → 模型从选择器消失 → token.json 被删
- [ ] **故意把 token 改坏** → 重启 → 界面显示"登录已失效，请重新扫码"（不是崩溃、不是空白）

### 「故意改坏」这条为什么必须测

它是**唯一**能验证 `200003` 处理路径的方法。不做这一步，线上第一次遇到 401 时会是一个未测过的代码路径。

---

## M3 · 能对话

**目标**：流式回复、思考内容、多轮、工具调用。

### 任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 3.1 | `src/protocol/chat.ts` | `buildBody` / `chatStream` / `parseFrame` / `isRateLimited` / `sessionId` |
| 3.2 | SSE 帧单测 | 三种已知帧 + 未知帧 |
| 3.3 | `src/provider/api.ts` | 自定义 pi-ai Api（**最难的一步**） |
| 3.4 | 首字节超时 + idle 超时 | AbortController |
| 3.5 | `applyThinking` | `extra_body` 注入 |
| 3.6 | 错误翻译 | `RaccoonError` → pi-ai 错误 |
| 3.7 | 重试策略 | `providerRetryPolicy` |
| 3.8 | 端到端验证 | 单轮 / 多轮 / 思考 / 工具 |

### 完成标准

- [ ] 发一条"你好" → 流式逐字出现（不是等完再出现）
- [ ] 发一条需要推理的问题 → 思考内容在思考区逐字出现
- [ ] 多轮对话上下文正确（第二轮能引用第一轮）
- [ ] 工具调用能触发（用一个简单的 `read_file` 工具测）
- [ ] 中途点"停止" → 立刻停，不报错
- [ ] **故意发一个超长上下文** → 得到限流文案（不是"未知错误"）
- [ ] 拔网线再发一条 → 得到 `TRANSPORT` 文案
- [ ] DSH 日志里没有 token 明文

### 3.3 的兜底

见 [ADR-0003](adr/0003-reasoning-channel.md) 的兜底触发条件。如果 8 小时内跑不通，切 `openAICompletionsApi()`，把 `reasoning: false` 写进 descriptor，M3 继续往下走。

---

## M4 · 能看余额、能排障

**目标**：药丸、余额条、诊断块、识图探测。

### 任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 4.1 | `src/protocol/points.ts` | `fetchBalance` / `fetchBills` / `todayGranted` |
| 4.2 | `TtlCache` | 60s 缓存 + inflight 去重 |
| 4.3 | `src/host/status.ts` | `StatusSnapshot` 聚合 |
| 4.4 | `client.js` 积分药丸 | 三态 + 20s 轮询 + 失焦暂停 |
| 4.5 | `client.js` 余额条 | 可用/永久/每日 + 到账提示 |
| 4.6 | `client.js` 诊断块 | 可复制文本 |
| 4.7 | `solidPng` + 识图探测 | 3×3 纯红 PNG |
| 4.8 | `vision-probe.json` | 持久化 |
| 4.9 | `client.js` 模型列表 | multiplier 显示 + 识图标记 |

### 完成标准

- [ ] 药丸显示真实积分数，千分位正确
- [ ] 20 秒后自动刷新（改一个数能看出来）
- [ ] 窗口失焦后停止轮询（Network 面板确认）
- [ ] 设置卡里余额三项都有数
- [ ] 今日已到账 / 未到账两种状态都能显示（改系统时间或等一天）
- [ ] 诊断块复制出来的文本里**没有 token**
- [ ] 识图探测：对一个已知支持的模型点"识图" → 几秒后显示 ✓
- [ ] 识图探测：对一个已知不支持的模型（`sn-glm-5-3`）点"识图" → 显示 ✗
- [ ] 重启 DSH 后，识图结论还在

---

## M5 · 能发布

**目标**：可安装、可回滚、有文档。

### 任务

| # | 任务 | 产出 |
| --- | --- | --- |
| 5.1 | `README.md`（包内） | 安装/原理/风险/FAQ |
| 5.2 | `CHANGELOG.md` | 0.1.0 |
| 5.3 | 版本号 | `0.1.0` |
| 5.4 | `scripts/verify-install.mjs` | 装得上、能解析、能加载 |
| 5.5 | `scripts/unlink.mjs` | 干净卸载 |
| 5.6 | 发布前自检 | 全套手工回归 |
| 5.7 | 打 tag | `v0.1.0` |

### 完成标准

- [ ] 在一台**干净的 DSH**（没有 link 过的）上 `pnpm add` 装得上
- [ ] `node scripts/verify-install.mjs` 全绿
- [ ] `unlink` 后 DSH 里卡片消失，无残留路由（重启不报 409）
- [ ] README 里有"风险提示"章节（照 workbuddy 的写法）
- [ ] README 明确写"不提供账号、不共享凭据、不绕过计费"

---

## 时间线（乐观估计）

```
Day 1  M1 骨架 + QR 编码器
Day 2  M1 收尾 + M2 协议层
Day 3  M2 登录端到端 + M3 协议层
Day 4  M3 自定义 Api（最难）
Day 5  M3 收尾 + M4 余额
Day 6  M4 识图 + M5 发布
```

**现实预期**：7–9 天。buffer 主要给 M3.3（自定义 Api）。

---

## 不做（本版本）

| 不做 | 理由 |
| --- | --- |
| 多账号 | 一个微信一个账号 |
| 自动签到 | 见 [03-raccoon-protocol §4.3](../01-research/03-raccoon-protocol.md) |
| 自定义 baseUrl | 会把插件变成任意转发器 |
| 对话历史同步 | 不在范围 |
| 移动端 UI | DSH 的 web 界面在手机上本来就不完整 |
| i18n（除中英） | 用户群是中文 |

这些不是"以后做"，是"这一版明确不做"。要做得单独立项。
