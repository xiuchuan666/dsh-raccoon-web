# ADR-0004 · 协议层与适配层分离

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [00-architecture](../00-architecture.md)、[01-module-map](../01-module-map.md)

---

## 背景

已有的六份实现，代码组织有一个共同特征：**全塞在一起**。

| 实现 | 主文件行数 | 里面有什么 |
| --- | --- | --- |
| `dsh-raccoon-connect` | 1345 | HTTP + 模型映射 + cordis 装配 + UI 路由 |
| `dsh-connect-workbuddy` | 619 KB | 同上（还有账号池、心跳） |
| `dsh-connect-sensenova-token-plan` | 9442 | 4 个 provider + UI + 积分 + 绘图 |
| `dsh-llm-adapters` | 8973 | 4 个 provider + 扫码页 + 每一个 provider 的细节 |

后果很具体：

- `dsh-raccoon-connect@0.2.2` 修 `textOf()` 截断 bug，改的是解析函数 —— 但它埋在 1345 行里，没有测试，只能靠用户反馈发现
- `sensenova` 的浣熊部分有 1116 行 `raccoon-models.js`，其中模型映射（纯函数）与 HTTP 调用混在一起
- 想知道"某个字段叫什么"，得通读整个文件

---

## 决策

**三层分离，依赖严格单向：**

```
host/  ──→  provider/  ──→  protocol/
 (DSH)      (pi-ai)         (纯 fetch)
```

### 每层的硬约束

| 层 | 可以 import | 不可以 import |
| --- | --- | --- |
| `protocol/` | `node:*`、相对路径 | **任何** npm 包、**任何** `@deepseek-ai/*`、`@earendil-works/*` |
| `provider/` | `protocol/*`、`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm*` | `host/*` |
| `host/` | 全部 | — |

CI 检查：

```bash
! grep -rn -E '@deepseek-ai|@earendil-works|require\(' packages/dsh-raccoon-web/src/protocol/
```

---

## 理由

### 1. 网关是唯一会变的东西，把它隔离出来

这个项目的全部不确定性都来自 `xiaohuanxiong.com`：

- 端点会改（`v1` → `v2` 已经发生过）
- 字段名会改（`context_window` vs `contextWindow` 未知，见 Q4）
- 错误码会加（`200001` / `200003` 已知，还有多少不知道）
- 限流阈值会调

**把这些关在一个目录里，改的时候只改这一个目录。**

### 2. `protocol/` 能脱离 DSH 单测

内核包从 profile 目录 import 会失败（E-008），必须从安装目录跑。而且它们没有类型（E-009）。

如果协议代码 import 了内核包，测试就必须在 DSH 的安装目录下跑 —— 那是别人的目录，路径随时会变。

保持 `protocol/` 纯净 ⇒ 测试在任何地方都能跑：

```bash
cd packages/dsh-raccoon-web && node --test test/protocol/
```

### 3. `protocol/` 能被别人复用

如果将来有人要把小浣熊接进别的框架（magpie、Cherry Studio、LobeChat），`protocol/` 可以直接拿走。

`magpie-raccoon-auth` 就是这么干的 —— 它移植了 `aimod-cc/agent2api` 的协议代码。

**协议知识应该属于协议层，不属于任何一个框架的适配层。**

### 4. 强制想清楚"这行代码属于哪一层"

写代码时每一次"这个函数放哪"都是一次设计决策。分层让这个决策变成显式的。

反例：`sensenova` 的 `raccoonRequestHeaders()` 在 `raccoon-models.js` 里（模型映射文件），因为它"反正都要用"。结果 `dsh-llm-adapters` 的 `raccoonHeaders()` 在另一个目录里 —— 两个实现的头不一样，而且没人对比过。

我们的 `headers.ts` 只有一处，三种组合（IAM / web / chat）都在里面，一眼能看出差异。

---

## 后果

### 正面

- 改网关 → 只改 `protocol/`（预计 80% 的维护工作在这里）
- 协议层可单测、可复用
- 新人（或未来的自己）能按目录判断"这段代码该不该依赖 DSH"

### 负面

| 代价 | 缓解 |
| --- | --- |
| 多一层间接（`protocol` 抛的 `RaccoonError` 要在 `provider` 翻译成 pi-ai 错误） | 翻译表在 [05-error-model](../05-error-model.md)，20 行 |
| 类型要在三层之间重复（`RaccoonModel` 在 protocol 定义，provider 用自己的 `ModelDescriptor`） | 有意为之：两层的类型本来就不同，硬复用会导致 protocol 层被 adapter 的形状污染 |
| 文件数变多 | 每个文件 100–400 行，比一个 1345 行的文件好找 |

### 中性

- 打包体积不变（都是同一个 bundle）

---

## 替代方案（已否决）

| 方案 | 否决理由 |
| --- | --- |
| 单文件（照抄 `dsh-raccoon-connect`） | 1345 行、无测试、bug 只能靠用户发现 |
| 按 feature 分（`login/`、`chat/`、`points/`） | 每个 feature 都横跨三层，等于没分 |
| 按框架分（`dsh/`、`core/`） | 只有一个框架，多出来的目录是空的 |

---

## 复审条件

1. `protocol/` 里出现大量 `if (someHostCapability)` 分支（说明没隔离干净）
2. 三层之间的类型转换代码超过 300 行（说明中间层设计错了）
3. 只有一份实现、没有复用需求，且总行数降到 800 以下 —— 那可以考虑合并
