# 观测与日志

最后更新: 2026-11-06（事件名按源码 34 处 log 调用逐一核对）
状态: 已定稿

> 一句话：**三个观测面各管一件事 —— 日志管"发生了什么"，status 管"现在是什么"，诊断块管"用户能贴给我什么"。**

---

## 0. 三个观测面

| 面 | 位置 | 谁看 | 存活期 |
| --- | --- | --- | --- |
| 日志 | 宿主日志流（`ctx.logger`） | 开发者 | 进程生命周期 |
| `status` | `GET /plugins/dsh-raccoon-web/status` | 开发者 + 客户端轮询 | 实时快照 |
| 诊断块 | `status.diagnostics`，UI 里可一键复制 | **用户** | 实时快照 |

**没有第四个面。** 不写本地日志文件、不上报、不埋点、不发遥测。

---

## 1. 日志

### 1.1 格式

```
[raccoon-web] <event> k=v k=v
```

实现（`src/host/log.ts`）：

```ts
const PREFIX = "[raccoon-web]";

function formatLine(event: string, fields?: LogFields): string {
  const parts = Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length === 0 ? `${PREFIX} ${event}` : `${PREFIX} ${event} ${parts.join(" ")}`;
}
```

**`undefined` 字段跳过** —— 这样可选字段不会在日志里留 `path=undefined`。

### 1.2 `createLogger` 的硬约束

```ts
createLogger(sink: LogSink | undefined, debugEnabled = false): Logger
```

- **`sink` 缺失时什么都不做，绝不退回 `console`。** 宿主 stdout 会被吞，`console.log` 写了也是白写，还会污染别的输出。
- `debug` 级别默认关，由 `settings.debugLog` 控制（`logger.setDebug(enabled)`）。
- 四种级别：`debug` / `info` / `warn` / `error`。

### 1.3 全部 34 个事件（源码逐条核对）

**插件生命周期（`src/index.ts`）**

| 事件 | 级别 | 字段 | 什么时候 |
| --- | --- | --- | --- |
| `apply` | info | `version`, `build` | 插件加载，第一行 |
| `apply/no-inject` | error | `message` | 宿主上下文没有 `inject()` |
| `apply/settings-failed` | error | `message` | settings 服务注册失败 |
| `settings/changed` | info | 变化字段 | 设置被改 |
| `mount/routes` | info | — | 路由挂上 |

**凭据解析（`src/host/index.ts`）**

| 事件 | 级别 | 字段 | 说明 |
| --- | --- | --- | --- |
| `token/desktop` | info | `token`(tag), `path`, `exp`, `reason` | 读到桌面端凭据并采用 |
| `token/desktop-expired` | warn | `path`, `reason` | 读到了但过期，回落扫码 |
| `token/desktop-missing` | info | `reason` | 六条候选路径都没读到 |
| `token/qr` | info | `token`(tag), `principal`, `reason` | 用了落盘的扫码 token |
| `bootstrap/failed` | error | `message` | 冷启动整体失败（不致命，插件仍加载） |

**登录流程（`src/host/login-flow.ts`）**

| 事件 | 级别 | 字段 | 说明 |
| --- | --- | --- | --- |
| `login/start` | info | `phase` | 开始一次扫码 |
| `login/qr` | info | `protocol`, `code`(前 6 位 + `…`), `expires` | 二维码生成（**两种协议都会打**） |
| `login/ready` | info | `token`(tag), `kind`, `principal` | 扫码成功 |
| `login/ready-desktop` | info | — | 桌面端凭据就绪（不走扫码） |
| `login/expired` | info | — | 二维码到期 |
| `login/dead` | warn | `message` | 平台判死（`markDead()`，**不删 token 文件**） |
| `login/error` | warn | `message` | 状态机进 error |
| `login/poll-threw` | warn | `message` | 轮询异常（**网络抖动，继续 pending**） |
| `login/logout` | info | — | 用户点了退出 |

**名册发布（`src/host/publish.ts`）**

| 事件 | 级别 | 字段 | 说明 |
| --- | --- | --- | --- |
| `publish/register` | info | `models` | 首次注册 provider |
| `publish/replace` | info | `models` | 换名册（先释放再注册） |
| `publish/replace-failed` | error | `message` | 释放后注册失败 → provider 短暂消失 |
| `publish/release` | info | `reason` | 主动释放（三元门控关掉） |
| `publish/dispose` | info | `reason` | 卸载时释放 |
| `publish/dispose-threw` | debug | `message` | 重复 dispose（正常，降级成 debug） |

**目录与配额（`src/host/index.ts`）**

| 事件 | 级别 | 字段 | 说明 |
| --- | --- | --- | --- |
| `catalog/loaded` | info | `models` | 目录拉到了 |
| `catalog/failed` | warn | `kind`, `message` | 目录失败（AUTH 时会 `markDead`） |
| `quota/failed` | warn | `message` | 余额失败（不致命） |
| `probe/vision` | info | `model`, `verdict`(`yes`/`no`/`unknown`) | 识图探测结果 |

**动作与路由（`src/host/index.ts` / `src/host/routes.ts`）**

| 事件 | 级别 | 字段 | 说明 |
| --- | --- | --- | --- |
| `logout` | info | `desktopIgnored` | 退出登录（含"本会话不再用桌面端凭据"标记） |
| `action/failed` | warn | `action`, `message` | action 抛异常 |
| `route/status-failed` | error | `message` | status 端点内部错误 |
| `route/action-failed` | error | `action`, `message` | action 端点内部错误 |

### 1.4 token 脱敏硬规则

```ts
function tokenTag(token: string | undefined): string {
  if (token === undefined || token.length === 0) return "-";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
```

**允许出现在日志里的**：

- `tokenTag()` 的 8 位 hex（**不是 token 的片段**）
- `principal`（JWT 的 `sub`，形如 `pu-01a19cd4-…`）
- `kind`（`access_token` / `xhx_token`）
- `exp`（过期时间戳）
- `path`（凭据文件路径 —— 是本机路径，不是秘密）

**禁止**：

- 任何 token 片段（前 6 位、后 4 位都不行）
- 完整 JWT payload
- `authorization` 头的值
- `Set-Cookie` 原文
- 用户输入的内容

`login/qr` 里的 `code` 是**二维码的一次性码**（不是 token），只打前 6 位 + `…`，且它 5 分钟就失效。

### 1.5 请求体只摘要不全文

**"日志里不该有用户说了什么。"** 一个对话助手把用户提问写进日志，等于给自己造了一个隐私问题。

需要时只打：`messages` 条数、总字符数、有没有图片、`max_tokens`、`model`。

### 1.6 三个典型序列

**正常冷启动（桌面端凭据）**

```
[raccoon-web] apply version=0.1.0 build=2026-11-06T12:35
[raccoon-web] mount/routes
[raccoon-web] token/desktop token=a1b2c3d4 path=... exp=1796362428000 reason=bootstrap
[raccoon-web] catalog/loaded models=6
[raccoon-web] publish/register models=6
```

**扫码登录**

```
[raccoon-web] login/start phase=none
[raccoon-web] login/qr protocol=web code=179393… expires=300
[raccoon-web] login/ready token=e5f6a7b8 kind=access_token principal=pu-01a19
[raccoon-web] publish/register models=6
```

**换 contextCap（换名册）**

```
[raccoon-web] settings/changed contextCap=64000
[raccoon-web] catalog/loaded models=6
[raccoon-web] publish/release reason=publish/replace
[raccoon-web] publish/replace models=6
```

**限流（正常降级）**

```
[raccoon-web] catalog/failed kind=RATE_LIMIT message=...
```

**读卡住但连接没断**

```
[raccoon-web] login/poll-threw message=TypeError: fetch failed
（下一条仍是 pending，不换码）
```

---

## 2. `status` 端点

### 2.1 契约

```
GET /plugins/dsh-raccoon-web/status
```

**只认 loopback。** 非 `127.0.0.1` / `localhost` / `[::1]` 的 `Host` 头 → `403 {"error":"loopback only"}`。

响应头带 `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`。

### 2.2 完整形状

```jsonc
{
  "build": "2026-11-06T12:35",          // 与 client.js 里的 BUILD 对照
  "version": "0.1.0",
  "login": {
    "phase": "ready",                    // none|pending|logging|ready|expired|error（**没有 dead**）
    "source": "desktop",                 // qr|desktop，未登录时缺省
    "principal": "pu-01a19",             // 只给前 8 位
    "kind": "access_token",
    "expiresAt": 1796362428000,
    "qrSvg": "<svg ...>",                // 仅 pending|logging
    "deadline": 1793937129000,           // 仅 pending|logging
    "message": "..."                     // 仅 expired|error
  },
  "publish": "published",                // disabled|not-configured|published
  "catalogReady": true,
  "catalogError": "...",                 // 可选，仅在失败时
  "models": [                            // **未登录时也非空**（走 fallback 名册）
    {
      "id": "sn-kimi-k3",
      "name": "Kimi-K3",
      "vision": true,
      "multiplier": 1,
      "contextWindow": 128000,           // 已按 contextCap 截断
      "maxTokens": 64000,
      "probed": true                     // 可选，实测过才有
    }
  ],
  "quota": {
    "available": 11682,
    "permanent": 10500,
    "daily": 1182,
    "dailyGranted": true,                // true|false|null（null = 不知道）
    "at": 1793936829945,
    "error": "..."                       // 可选
  },
  "settings": {
    "enabled": true,
    "reasoning": true,
    "visionProbeOverride": false,
    "contextCap": 128000,
    "debugLog": false,
    "authSource": "auto",                // auto|desktop|qr
    "qrProtocol": "web"                  // web|iam
  },
  "desktopAuth": {
    "found": true,
    "path": "C:\\Users\\...\\auth.json",
    "expiresAt": 1796362428000,
    "reason": "..."                      // 可选
  },
  "diagnostics": "插件: ...\nbuild: ...\n..."
}
```

### 2.3 字段规则

| 规则 | 理由 |
| --- | --- |
| `models` 未登录也非空 | 否则用户第一次打开以为插件坏了 |
| `models[].contextWindow` 已截断 | 与 `roster.ts` 的 `toDescriptor` 用同一算法，否则"显示 1M、实际 128K" |
| `login.principal` 只给前 8 位 | 够区分账号，不够拿来当身份 |
| `login.qrSvg` 只在 pending/logging 给 | 其它相位留着会让人误以为还能扫 |
| `quota` 缺值给 `null` 不给 `0` | `0`（真没积分）与"不知道"必须能区分 |
| `desktopAuth.found: false` 时给 `reason` | 用户要知道是"没装客户端"还是"文件坏了" |
| `build` 必须存在 | 用来判断浏览器加载的是不是新版本 |

### 2.4 为什么要有 `build`

改完 `client.js` 后最尴尬的情况：宿主是新的、浏览器里跑的还是旧的。

UI 拿到 `status.build` 与自己的 `BUILD` 常量对比，不一致就在标题旁显示 ⚠。

`client.js` 还额外往 `globalThis.__DSH_BUILD_raccoon` 挂一份，方便 F12 里一行确认。

---

## 3. 客户端轮询策略

| 场景 | 间隔 |
| --- | --- |
| 空闲（无登录中） | 20 s |
| 设置卡打开 + 登录中 | 1.5 s |
| 出错后 | 30 s → 60 s 退避 |
| 页面重新可见（`visibilitychange`） | 立刻拉一次，然后回正常节奏 |

实现要点：

- **共享一个 store**：多个组件订阅同一份快照，只有一个 setTimeout 链
- **`inflight` 去重**：并发 `load()` 只发一次请求
- **失败保留上一份快照**：不要因为一次网络抖动把界面清空
- **第一个订阅者启动轮询，最后一个退出时停**：没有组件在用时不该继续打端点
- **失焦暂停**：`document.visibilityState === "hidden"` 时不排下一次

### 3.1 药丸不显示错误

输入框旁边的积分药丸反映的是"余额"，不是"连接状态"。

余额拿不到时显示 `—` 或 `pillUnknown` 文案，**不在输入框旁边弹错误** —— 那个位置离用户的注意力太近，一条红字会打断正在写的输入。

错误只在设置卡里显示。

---

## 4. 诊断块

### 4.1 十三行（2026-11-06 `npm run smoke` 的真实输出）

```
插件: dsh-raccoon-web 0.1.0
build: 2026-11-06T12:35
平台: win32 / node v24.22.1
登录: none
来源: -
桌面端: 未读到 (未找到桌面客户端登录态，已回退到扫码)
账号: -
provider: not-configured
目录: 未就绪
余额: 未知
上下文上限: 128000
思考: 开
扫码协议: Web auth（官方桌面端同款）
```

**固定 13 行，不随登录状态增删。** 未知值用 `-` / `未知` / `未读到 (原因)` 占位，行数恒定 —— 这样用户截图对比时不会数错。

顺序由 `src/host/status.ts:133-147` 的 `lines[]` 定死，改顺序要同步改单测 ST-25 的 `assert.equal(text.split("\n").length, 13)`。

登录就绪后同一份样例会变成：

```
登录: ready (access_token)
来源: 官方客户端凭据
桌面端: 已读到 (C:\Users\Administrator\.office-raccoon\agent\config\auth.json)
账号: pu-01a19
provider: published
目录: 6 个模型
余额: 11682
```

**注意"来源"与"桌面端"是两行**：`来源` 说的是当前 token 从哪来（`desktop` / `qr` / `-`），`桌面端` 说的是那个文件读没读到。二者会不一致 —— 例如用户把 `authSource` 设成 `qr` 时，文件读得到但来源仍是"扫码"。

### 4.2 硬规则：诊断块不含任何 token 派生值

早期设计里有一行 `token: sha256=3d9a1b2c (7d old)` —— 已删掉。

理由：用户会把这段贴到 issue / 群里。8 位哈希本身不危险，但它诱导出"那我贴完整 token 是不是也行"的行为。

**现在诊断块里一个 token 相关的值都没有。**

单测 ST 里有一条断言：诊断块文本不含 `eyJ`（JWT 的前缀）。

### 4.3 一键复制

UI 里「复制诊断信息」按钮走 `navigator.clipboard.writeText()`。

失败（非 https / 无权限）时不弹错，退回"请手动选中复制"的提示 —— 这段文本本来就可见。

---

## 5. 可算的四项指标

不需要埋点，从日志就能算：

| 指标 | 算法 | 健康值 |
| --- | --- | --- |
| 首字节中位数 | 真链路冒烟里的 `firstByteMs` | 1–2 s（实测 1637 ms） |
| 重试率 | 含 `retry` 的对话 / 总对话 | < 5% |
| 限流率 | `catalog/failed kind=RATE_LIMIT` + 流内 200429 / 总对话 | 看用法，> 30% 说明上下文开太大 |
| 平均输出长度 | 真链路里 `usage.output` | 无基准，只用来对比改动的效果 |

真链路冒烟（`npm run smoke:chat`）会打印首字节、思考字符数、正文长度、finish kind。

---

## 6. 不做的事

| 不做 | 理由 |
| --- | --- |
| 本地日志文件 | 宿主管日志；自己再写一份会出现"两份不一致" |
| OpenTelemetry / metrics 端点 | 一个个人插件不需要，且多一个要维护的协议 |
| 请求 / 响应录制 | 会把用户提问和图片落到磁盘 |
| 崩溃上报 | 同上，还多一个出网点 |
| 任何遥测 | **"不往外发任何数据"是承诺，不是取舍** |

---

## 7. 发版前自检

```powershell
# 1. 日志里不该有 token
Select-String -Path packages\dsh-raccoon-web\src\**\*.ts -Pattern "xhx_|eyJ|authorization: Bearer"

# 2. client.js 里不该有 console
Select-String -Path packages\dsh-raccoon-web\client.js -Pattern "console\."

# 3. 诊断块不含 token
node -e "const s=require('./.tmp/status.json'); console.log(/eyJ|xhx_/.test(s.diagnostics) ? 'LEAK' : 'clean')"
```

三条都应该零命中 / clean。

---

## 8. 相关文档

- 日志实现：[log.ts](../../packages/dsh-raccoon-web/src/host/log.ts)
- 状态形状：[status.ts](../../packages/dsh-raccoon-web/src/host/status.ts)
- 路由：[routes.ts](../../packages/dsh-raccoon-web/src/host/routes.ts)
- 排障手册：[01-troubleshooting](./01-troubleshooting.md)
- 存储与安全边界：[03-state-and-storage](../02-design/03-state-and-storage.md)
