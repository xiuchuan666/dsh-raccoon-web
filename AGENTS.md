# AGENTS.md — 给接手这个仓库的 AI/人类协作者

这个仓库是**一个人的长期工程**：一个人写、一个人维护、随时可能隔几周再回来。
所以下面这些不是形式主义，是把"回来时还能接上"的成本压到最低。

## 先读什么

按这个顺序，不要跳：

1. `README.md` —— 30 秒知道这是什么、现在到哪一步
2. `docs/00-index.md` —— 文档地图
3. `devlog/` 最近 3 篇 —— 上次停在哪、卡在哪
4. `docs/02-design/00-architecture.md` —— 代码应该长什么样
5. 你要改的那个模块对应的 ADR

## 硬规矩

### 1. 每次开工先读日志，收工必须写日志

日志是**唯一**可靠的"上次做到哪"的来源。commit message 不是，issue 不是，你脑子里的印象更不是。

- 一天一个文件：`devlog/YYYY-MM-DD.md`
- 模板：`devlog/_template.md`
- 收工时至少写：今天做了什么、什么没做成及原因、下次第一件事做什么

### 2. 文档和代码同一次改动里更新

改了协议端点 → 改 `docs/01-research/03-raccoon-protocol.md`
改了模块边界 → 改 `docs/02-design/01-module-map.md`
做了不可逆的架构选择 → 加一篇 ADR

**不接受"代码先上，文档回头补"。** 回头就是不会补。

### 3. ADR 一旦接受就不再改

ADR 是**当时的判断记录**，不是"当前最佳实践"。要推翻它，写一篇新的 ADR，在新 ADR 里 `Supersedes: ADR-000X`，旧的那篇只加一行 `Status: Superseded by ADR-000Y`。

### 4. 所有对外部世界的假设都必须带实测证据

这个项目全程在跟一个**没有文档、随时会变**的私有网关打交道。所以：

- 不能写"应该返回 xxx"，要写"2026-11-06 实测返回 xxx"
- 实测记录进 `docs/01-research/05-empirical-findings.md`，带时间戳
- 网关行为变了，不是"代码有 bug"，是"假设过期了" —— 先去更新实测记录

### 5. 占位符优先于猜测

缺 IP、缺域名、缺 token、缺路径，就写 `TARGET` / `HOST` / `TOKEN` / `PATH`，然后继续把结构写完。
不要因为"不知道具体值"就停下来问，也不要编一个看起来像真的值。

### 6. 不提交 `research/` 与构建产物

`research/pkgs/` 里是别人的包，只读参考，不进版本库。

## 技术约束

| 约束 | 值 | 原因 |
| --- | --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` | 跟 DSH 宿主一致 |
| 模块格式 | ESM（`"type": "module"`） | DSH loader 用 `import()` |
| 打包 | tsup → `lib/index.js`（ESM）+ 手写 `lib/client.js`（classic script） | 客户端半身必须是纯脚本，不能有 import |
| 依赖 | 尽量零运行时依赖 | 插件跑在宿主进程，依赖冲突会拖垮整个 app |
| 类型 | 内核包**没有** `.d.ts`，只有 `.js` | 需要类型时自己写 `src/types/*.d.ts` 补 |

## 目录归属

| 路径 | 谁可以改 |
| --- | --- |
| `packages/dsh-raccoon-web/src/protocol/` | 协议层，只依赖 `fetch`，不 import 任何 DSH 包 |
| `packages/dsh-raccoon-web/src/provider/` | 适配层，可以 import `@earendil-works/pi-ai` 与 `@deepseek-ai/dsh-llm*` |
| `packages/dsh-raccoon-web/src/host/` | 宿主半身，路由/settings/状态存储 |
| `packages/dsh-raccoon-web/lib/client.js` | 浏览器半身，**手写**，不经 tsup |
| `docs/`、`devlog/` | 随手改，但遵守上面的规矩 |

## 提交前自检

```bash
pnpm -w run typecheck   # 类型过
pnpm -w run build       # 构建过
node scripts/verify-install.mjs   # 装得上、能解析
```

日志里贴一遍结果，别只说"通过了"。
