# 发布计划

最后更新: 2026-11-06
状态: 已定稿

> 这个插件不会上 npm 公网 —— 它读的是**使用者自己的小浣熊账号**，公开分发会带来说不清的账号风险。
> 发布形态是：**本地打包 tgz + `pnpm link` 到本机 DSH profile**，可选地打到私有 registry。

---

## 1. 发布形态

| 形态 | 用在哪 | 命令 |
| --- | --- | --- |
| **本地 link**（默认） | 开发机、自己用 | `node scripts/link.mjs` |
| **本地 tgz** | 备份、给第二台机器 | `pnpm pack` → `dsh-raccoon-web-0.1.0.tgz` |
| **私有 registry** | 团队内部分发 | `pnpm publish --registry <PRIVATE>` |
| ~~npm 公网~~ | 不做 | 见 §7 |

### link 与 tgz 的区别

|  | link | tgz |
| --- | --- | --- |
| 改代码要重装 | 不用（指回源码目录） | 要 |
| 走 tsup 构建 | 要（`prepack` 之外不会自动） | 会（`prepack`） |
| 适合 | 开发 | 分发 |

---

## 2. 版本号策略

`0.1.0` 起，语义化版本：

| 位数 | 什么情况加 |
| --- | --- |
| **major** | 只在 1.0.0 之后；1.0.0 定义为"网关协议完全稳定 + 已被 3 人连续使用 2 周" |
| **minor** | 新功能：识图探测、诊断块、多模态 |
| **patch** | 适配网关变化、修 bug、改文案 |

**网关一变就可能要发 patch** —— 所以 patch 要发得随意，不要攒。这个项目的主要维护工作就是跟网关。

### CHANGELOG 规则

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 写，分类固定六项：

```
### 新增 / 修复 / 变更 / 移除 / 安全 / 适配网关
```

**"适配网关"是自定义分类**，专门记"上游变了所以我们跟着变"。这条不能混进"修复"，否则以后看不出是"我们的 bug"还是"上游变了"。

---

## 3. 发布前检查清单

按顺序执行，每条都要贴结果。

```bash
# 1. 干净的工作区
git status --porcelain          # 应为空

# 2. 类型
pnpm -w run typecheck           # 0 error

# 3. 构建
pnpm -w run build
ls packages/dsh-raccoon-web/lib/     # 只有 index.js，无 chunk，无 .map

# 4. 单测
pnpm -w run test                # 全绿

# 5. 装得上
node scripts/verify-install.mjs # 全绿

# 6. 手工回归
#    → docs/03-plan/02-test-plan.md §3 全部
```

### `verify-install.mjs` 到底验什么

```js
// 1. package.json 的 dsh.bundle.patch 指向的文件存在
// 2. cordis.patch.yml 能被 YAML 解析，且顶层是数组，含 insert
// 3. dsh.client.platform === "web"，inject 全是 string
// 4. exports["./client"] 指向 client.js，且该文件不以 import/export 开头
// 5. client.js 里能找到 __ModuleLoader__ 与 loader.load(
// 6. lib/index.js 存在且能被 node --check 解析（ESM）
// 7. 从安装目录 import("@deepseek-ai/dsh-llm") 成功（确认宿主能解析）
// 8. peerDependencies 用逐段并集，且每一段都是合法 semver range
```

第 4 条是**最容易踩的**：client.js 是 classic script，只要有一个 `import` 语句就会整体加载失败，且**报错不会出现在 DSH 日志里**（只在浏览器 console）。

第 8 条检查写法：

```js
import semver from "semver";
const range = pkg.peerDependencies["@deepseek-ai/dsh-llm"];
semver.validRange(range)                       // 整体可解析
range.split("||").every(s => semver.validRange(s.trim()))
```

---

## 4. 安装步骤（README 要写的原文）

### 4.1 开发机（link）

```powershell
# 1. 构建
cd D:\dsh小浣熊反代开发
pnpm -w run build

# 2. 链进 profile
node scripts/link.mjs

# 3. 重启 DSH
```

`link.mjs` 实际做的事：

```js
// 1. 在 ~/.dsh/profiles/desktop/package.json 的 dependencies 里加
//    "dsh-raccoon-web": "link:D:/dsh小浣熊反代开发/packages/dsh-raccoon-web"
// 2. 确保 dsh.profile.bundles 里有 "dsh-raccoon-web"
// 3. 在 cordis.patch.yml 里 insert 一条（若没有）
// 4. 打印"重启 DSH 生效"
```

**不做** `pnpm add`，因为 pnpm 的 link 协议在 workspace 外容易破。

### 4.2 第二台机器（tgz）

```powershell
cd D:\dsh小浣熊反代开发\packages\dsh-raccoon-web
pnpm pack                    # 产出 dsh-raccoon-web-0.1.0.tgz

# 拷到目标机后
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add D:\path\to\dsh-raccoon-web-0.1.0.tgz
# 手动在 package.json 的 dsh.profile.bundles 里加 "dsh-raccoon-web"
```

### 4.3 卸载

```powershell
node scripts/unlink.mjs
# 1. 从 dependencies 删
# 2. 从 dsh.profile.bundles 删
# 3. 从 cordis.patch.yml 删那条 insert
# 4. 询问是否删 raccoon-web/（含 token）
# 5. 重启 DSH
```

**第 4 步必须问**，不能默认删 —— 里面有用户的登录态。反过来也不能默认留 —— 有人卸载就是想清干净。所以要问。

---

## 5. 回滚

| 场景 | 做法 |
| --- | --- |
| 新版本插件加载失败 | `node scripts/unlink.mjs` → 重启 → 用旧 tgz 重装 |
| 网关改了导致不可用 | 关掉开关（`enabled: false`）而不是卸载 —— 保住 token，等适配 |
| token 污染 | 删 `raccoon-web/token.json` → 重启 → 重扫码 |

### 开关比卸载重要

`settings.enabled = false` 时 publisher 释放 adapter，模型从选择器消失，但 token 保留。
这是**首选的"临时停用"手段**，因为卸载再装要重新扫码。

---

## 6. 发布记录模板

每次发版在 `devlog/` 里追加一段：

```markdown
## 发布 v0.1.1 (2026-11-10)

- 类型：patch
- 原因：网关把 `delta.reasoning_content` 改成了 `delta.reasoning`
- 改动：`src/protocol/chat.ts:88` 两个键都读
- 验证：
  - typecheck ✅
  - build ✅（lib/index.js 单文件 41.2 KB）
  - test ✅（58 passed）
  - verify-install ✅
  - E2E-1/2/3 ✅（手工，手机扫码正常）
  - E2E-4 限流 ✅ / 断网 ✅
- 实测更新：E-021 记录新字段名
```

**"实测更新"这一栏不能空** —— 每次因为网关变化发版，都必须在 `05-empirical-findings.md` 里加一条。这是这个仓库最重要的资产。

---

## 7. 为什么不发 npm 公网

| 理由 | 说明 |
| --- | --- |
| 账号风险 | 插件跑在用户机器上、用用户自己的 token。公开分发后"插件有问题"和"账号被封"很难撇清 |
| 上游会变 | 网关是私有的，没有稳定性承诺。公网包会被当成"应该一直能用" |
| 支持成本 | 会有人来问"为什么扫不出来"，而原因多半在他的微信/网络 |
| 法律面 | 逆向私有网关并公开分发，比自用更容易被注意到 |

**替代方案**：把 `src/protocol/` 单独发一个"协议库"（不含任何 DSH 依赖、不含任何凭据读写），别人可以拿去做自己的客户端。这个是干净的。

---

## 8. 发布后监控

没有服务端，所以没有"监控"。替代手段：

| 手段 | 做法 |
| --- | --- |
| 自诊断块 | 设置卡里"复制诊断信息"，用户报障时贴这个 |
| 结构化日志 | `[raccoon-web]` 前缀，`debugLog` 打开后有完整请求/响应摘要（不含 token） |
| 实测记录沉淀 | 每次网关变化都进 `05-empirical-findings.md` |

诊断块内容（**绝不含 token**）：

```
dsh-raccoon-web 0.1.1
build 2026-11-06T10:00
dsh 0.2.1-rc.5 / node 24.22.1 / win32 x64
phase: ready
principal: u_8f3a...
token: sha256=3d9a1b2c (7d old)
catalog: 6 models (cached 42s ago)
quota: 12,340 available
last error: none
```

---

## 9. 时间线

| 节点 | 内容 |
| --- | --- |
| M5 开始 | 写包内 README + CHANGELOG 0.1.0 |
| M5 中 | `verify-install.mjs` 全绿 |
| M5 末 | 打 tag `v0.1.0`，在 devlog 写发布记录 |
| +1 周 | 自用观察，把踩到的坑补进 troubleshooting |
| +2 周 | 若稳定 → 考虑 0.2.0（识图探测打磨） |
