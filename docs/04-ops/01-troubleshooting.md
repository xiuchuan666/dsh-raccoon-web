# 排障手册

最后更新: 2026-11-06（按实现与真机排障记录重写）
状态: 已定稿

> 一句话：**先看 `/plugins/dsh-raccoon-web/status`，它一行就能分清"没装上 / 没读到凭据 / 目录空 / 供应商没注册"四种状态。**

---

## 0. 三十秒分诊

```
界面里完全没有「小浣熊」
├─ curl /plugins/dsh-raccoon-web/status 返回 404?
│  ├─ 是 → 插件没加载 / 路由没挂          → §1、§3.2
│  └─ 否 → 宿主活着，是浏览器半身没跑      → §2
│
卡片在，但写着"未登录 或 未读到客户端登录态"
├─ status 里 login.phase?
│  ├─ "none" + desktopAuth.found=false → 没凭据     → §4.1
│  ├─ "expired"                       → 凭据过期     → §4.2
│  └─ "ready" 但界面还说未登录        → 前端没拿到   → §4.3
│
显示已登录，但模型选择器里没有小浣熊
├─ status 里 publish?
│  ├─ "not-configured" → 名册空 / 没 token           → §5.1
│  ├─ "disabled"       → 插件开关关了                → §5.2
│  └─ "published"      → 是 DSH 那边没刷新           → §5.3
│
扫码相关
├─ 二维码扫出来说"已过期或已被使用"                   → §6.1
├─ 二维码能扫但一直 pending                          → §6.2
└─ 二维码根本扫不出来                                → §6.3
│
聊天气泡出来就报错                                    → §7
余额 / 积分不对                                      → §8
卸载后还有残留                                        → §9
```

---

## 1. 插件根本没加载

### 症状

- 设置 → 插件里没有「小浣熊」卡片
- `curl http://127.0.0.1:57292/plugins/dsh-raccoon-web/status` → **404**

### 先看一件事：`cordis.patch.yml` 里那条 `name` 写的是什么

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" | Select-String "raccoon" -Context 0,2
```

正常有两种合法形态：

```yaml
- insert:
    - id: llm-raccoon-web
      name: "file:///D:/dsh%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%8F%8D%E4%BB%A3%E5%BC%80%E5%8F%91/packages/dsh-raccoon-web/lib/index.js?v=1793937903234"
```

或裸包名 `name: dsh-raccoon-web`（只在进程启动时解析一次，改代码不会热更）。

`scripts/link.mjs` 默认写**前者**（file URL + mtime 查询串），这样每次 `npm run build && node scripts/link.mjs` 都会让运行中的宿主重新 import。见 [00-dev-environment §3.4](./00-dev-environment.md)。

### 五个检查点

```powershell
# 1. dependencies 里有吗
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" | Select-String "raccoon"

# 2. bundles 列表里有吗
node -e "const p=require(process.env.USERPROFILE+'/.dsh/profiles/desktop/package.json'); console.log(p.dsh.profile.bundles)"

# 3. patch 里有 insert 吗（见上）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" | Select-String "raccoon"

# 4. 包文件在不在
Test-Path "D:\dsh小浣熊反代开发\packages\dsh-raccoon-web\lib\index.js"
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-raccoon-web"

# 5. patch 能被 YAML 解出来吗
node -e "const y=require('yaml'),fs=require('fs');const a=y.parse(fs.readFileSync(process.env.USERPROFILE+'/.dsh/profiles/desktop/cordis.patch.yml','utf8'));console.log(Array.isArray(a),a.length)"
```

| 检查点 | 失败含义 | 解决 |
| --- | --- | --- |
| 1 无 | 没装 | `node scripts/link.mjs` |
| 2 无 `dsh-raccoon-web` | bundles 没登记 | `link.mjs` 会加 |
| 3 无 insert 条目 | patch 没写 | `link.mjs` 会加 |
| 4 无 | 只登记没产物 | `npm run build` 再 `link.mjs` |
| 5 解析失败 | YAML 语法错（缩进 / Tab） | **YAML 里禁止 Tab**，全用空格 |

### file URL 写对了但宿主没重载

- 检查 URL 里的 `/` 是否写成了正斜杠、盘符后是否 `:/`（Windows 上必须是 `file:///D:/...`）
- 中文路径必须是百分号编码（`link.mjs` 用 `pathToFileURL()`，手工写容易漏）
- 换 tag 强制重载：

```powershell
npm run revive -- --tag t1
npm run revive -- --dry       # 只看会改成什么，不写
npm run revive -- --restore   # 退回裸包名（排查 loader 问题时用）
```

改完 5–7 秒再查 `status` 的 `build` 字段有没有变。

### 特殊情况：patch 写对了但被别的条目盖掉

`cordis.patch.yml` 是**顺序应用**的。如果我们的 insert 之后有另一条同 `id: llm-raccoon-web` 且带 `disabled: true`，插件就被关了。

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" | Select-String "llm-raccoon-web" -Context 2,2
```

`link.mjs` 总是追加到文件末尾，正常情况下不会撞。

---

## 2. 宿主加载了但界面没有

### 症状

- `status` 200，`build` 是新值
- 但界面没卡片、输入框旁没药丸

### 定位：F12 → Console

```js
// 1. loader 在不在
typeof globalThis.__ModuleLoader__            // "object" 正常

// 2. 我们的脚本执行过吗
globalThis.__DSH_BUILD_raccoon                // 应等于 src/build.ts 里的 BUILD

// 3. 脚本被下发了吗（Network 面板过滤 client.js）
//    URL 形状是 combo：/plugins/??dsh-raccoon-web/client.js&rev=<12位hex>
```

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `__ModuleLoader__` 是 `undefined` | 页面还没起完 / 不是 DSH web UI | 等加载完；确认打开的是 DSH 打印的那个 URL |
| 有 loader、没 `__DSH_BUILD_raccoon` | **client.js 整文件没执行**（语法错） | Console 往上翻 `SyntaxError`；见下三条硬约束 |
| 两个都有但界面没变 | slot 注册失败 | Console 找 `[raccoon-web] client apply failed` |
| 组件注册了但渲染成空 | `useStatus` 一直 loading | Network 看 `status` 是否 403 / 404；403 见 §3.1 |
| 药丸在、但**设置对话框左侧菜单没有「小浣熊」** | 旧版 `client.js` 只注册了 `conversation.input.left` + `plugins.bundle.config`，**漏了 `settings.section`** | 见下「设置里找不到入口」 |

### 设置里找不到入口（2026-11-06 实测）

用户看的是「设置」对话框（左侧菜单：账号与余额 / 通用设置 / 模型 / 内置插件 / …），但设置卡挂的 `plugins.bundle.config` 只在「插件」面板点开包详情时才渲染 —— 两者不是同一个界面。`settings.section` 才是设置对话框左侧菜单的 slot。

按顺序确认：

1. `globalThis.__DSH_BUILD_raccoon` 是否 ≥ `2026-11-06T15:35`（这版起才注册了 `settings.section`）。旧值说明浏览器是缓存脚本 → Ctrl+Shift+R，必要时 `npm run revive`。
2. 拉 combo URL 看脚本里有没有 `settings.section`：
   ```powershell
   # rev 由 lib/client.js 的 mtime / ctime / size 算出（12 位 hex），见 §2 脚本内容校验
   curl.exe -s "http://127.0.0.1:<PORT>/plugins/??dsh-raccoon-web/client.js&rev=<rev>" | Select-String "settings.section"
   ```
   应命中 3 处（`inject` / `name` / 注释各一）。0 处 → `lib/client.js` 是旧产物，重跑 `npm run build`。
3. 脚本里有但菜单还是没有 → F12 Console 找 `[raccoon-web] client apply failed`，多半是 `ctx.slots.register` 的必填字段缺失（`settings.section` 要 `id`，用 `key` 会静默不显示）。
4. `<PORT>` 以当前 DSH 启动时打印的为准（宿主重启会换端口，别写死 `57292`）。

`settings.section` 与 `plugins.bundle.config` **两个入口并存**：设置对话框左侧菜单 + 插件面板包详情页都能进设置卡。只注册其中一个，另一个界面就找不到调整入口。

### client.js 的三个硬约束

1. **不能有 `import` / `export`** —— 它是 classic script，靠 `globalThis.__ModuleLoader__` 注册
2. **不能有 JSX** —— 用 `React.createElement` 或本地 `h()`
3. **React 与 `h` 必须声明在 IIFE 作用域** —— 组件都定义在 IIFE 里，若把 `var h` 写进 `factory()` 内部，组件里 `h` 就是 undefined

`scripts/verify-install.mjs` 会静态检查前两条（第 12、13 项）。

### 确认脚本内容对不对（不用打开浏览器）

```powershell
# rev 由 lib/client.js 的 mtime / ctime / size 算出（12 位 hex）
# <PORT> 以当前 DSH 打印的为准（宿主重启会换端口）
curl.exe -s "http://127.0.0.1:<PORT>/plugins/??dsh-raccoon-web/client.js&rev=<rev>" | Select-String "BUILD ="
```

`lib/client.js` 改了**会**被热下发（rev 变），但**页面要刷新**；`lib/index.js` 改了**不会**，要靠 `revive`。

### 改了没生效

依次：`npm run build` → Ctrl+Shift+R → 查 `__DSH_BUILD_raccoon` → 还不对就 `npm run revive -- --tag t2`。

---

## 3. status 端点异常

### 3.1 403 `{"error":"loopback only"}`

请求的 `Host` 头不是 `127.0.0.1` / `localhost` / `[::1]`。这是**正确行为**（防止局域网别人读你的状态）。触发场景：

- 从别的机器访问 `http://<你的IP>:57292/...`
- 反向代理没重写 Host
- 用了 `http://0.0.0.0:57292/...`

本机访问就用 `127.0.0.1`。

### 3.2 404

路由没注册。`webServer` 不写在顶层 `inject` 里（因为它只有桌面 / web 宿主才有），而是嵌套注入：

```ts
ctx.inject(["settings"], (sub) => {
  sub.inject(["webServer"], (web) => web.effect(() => host.mount(web.webServer), "dsh-raccoon-web: routes"));
});
```

漏了 `sub.inject(["webServer"], ...)` 就 404。手工验证：

```powershell
node -e "fetch('http://127.0.0.1:57292/plugins/dsh-raccoon-web/status').then(r=>console.log(r.status))"
```

### 3.3 200 但内容不对

```powershell
curl.exe -s "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status" > .tmp\s.json
node -e "const s=require('./.tmp/s.json');console.log(JSON.stringify({build:s.build,publish:s.publish,phase:s.login.phase,source:s.login.source,models:s.models.length,desktop:s.desktopAuth},null,1))"
```

期望形状：

| 字段 | 期望 |
| --- | --- |
| `build` | 等于 `src/build.ts` 的 `BUILD`（不等就是没热更，见 §1） |
| `version` | 等于 `package.json` 的 `version` |
| `login.phase` | `none` / `pending` / `logging` / `ready` / `expired` / `error`（**没有 `dead`**） |
| `login.source` | `desktop`（读客户端凭据）或 `qr`（自己扫码） |
| `publish` | `disabled` / `not-configured` / `published` |
| `catalogReady` | `true` 表示真目录已拉到（`false` 时 `models` 是内置 fallback 名册） |
| `models` | **未登录也非空**（5 条 fallback），这是有意的 |
| `settings` | 七个键：`enabled` / `reasoning` / `visionProbeOverride` / `contextCap` / `debugLog` / `authSource` / `qrProtocol` |
| `desktopAuth` | `{found, path?, expiresAt?, reason?}` |
| `diagnostics` | 13 行，真换行，**不含 token** |

`phase: "ready"` 且 `catalogReady: false` → 目录没拉到，去 §5.1。

---

## 4. 未登录 / 凭据问题

### 4.1 `phase: "none"` 且 `desktopAuth.found: false`

插件没找到官方客户端的登录态。先确认它到底在哪：

```powershell
# 官方客户端真正的凭据文件（注意是 .office-raccoon 不是 .box-agent）
Test-Path "$env:USERPROFILE\.office-raccoon\agent\config\auth.json"

# 只打印来源 / 账号 / 过期时间，不打 token
node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs -e "import('./packages/dsh-raccoon-web/src/protocol/desktop-auth.ts').then(async m=>{const a=await m.readDesktopAuth();console.log(a===undefined?'未读到':{source:a.source,principal:a.principal,expiresAt:new Date(a.expiresAt).toISOString(),len:a.token.length})})"
```

| 结果 | 含义 | 解决 |
| --- | --- | --- |
| `auth.json` 不存在 | 官方客户端没登录过 | 打开「商汤小浣熊」客户端登录一次；或把 `authSource` 改 `qr` 走扫码 |
| 存在但解析出 `undefined` | 格式变了 / 文件被截断 | 打开文件看是不是 `{"access_token":"...","office_identity":"..."}`；把实际形状记进 `05-empirical-findings.md` |
| 解析出来 `expiresAt` 已过 | 凭据过期 | 见 §4.2 |

**注意**：`~/.box-agent/config/auth.json` 是 box-agent CLI 的路径，桌面端用的是 `~/.office-raccoon/agent/config/auth.json`（E-030）。只查前一个会误判成"没登录"—— 项目早期就判错过一次（E-006 已作废）。

### 4.2 `phase: "expired"` 或 `desktopAuth.reason` 提到过期

官方客户端的 IAM JWT 有效期约 30 天，**过期了插件不会自动续**（IAM token 没有 legacy refresh grant，`isIamToken()` 为真时官方自己也不走 refresh）。

解决：打开官方客户端，它会自己续；或者把 `authSource` 切成 `qr` 扫码。

### 4.3 `phase: "ready"` 但界面还说未登录

前端拿到的 `login` 块里 `phase` 没更新：

```powershell
node scripts/login-qr.mjs --wait-only --port 57292
```

它会只读轮询、**绝不换码**。若这里已经 `ready`，说明是浏览器缓存 → Ctrl+Shift+R。

### 4.4 `authSource` 设成 `desktop` 但读不到

`authSource: desktop` 是**严格模式**：读不到就明确报错，不会偷偷回落到扫码 token。切回 `auto`（默认）才会回落。改法：

```powershell
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=set-setting" -H "content-type: application/json" -d "{\"key\":\"authSource\",\"value\":\"auto\"}"
```

改 `authSource` 会自动重跑一次凭据解析（`actionSetSetting` 里特判），不用手动 `refresh-auth`。

---

## 5. 已登录但模型不出现

### 5.1 `publish: "not-configured"`

三元门控里第二态：**开关开着、但没有 token 或名册为空**。

```powershell
# 强制重新解析凭据 + 重新拉目录 + 重新注册
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=refresh-auth"
```

返回：

- `{"ok":true,"phase":"ready"}` → 好了
- `{"ok":false,"error":"没读到可用的登录态：先登录官方小浣熊客户端，或在下面扫码。"}` → 去 §4.1
- `{"ok":false,"error":"当前设置只允许扫码登录，请先扫码。"}` → `authSource` 是 `qr`，改成 `auto` 或扫码

### 5.2 `publish: "disabled"`

设置里 `enabled` 被关了：

```powershell
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=set-setting" -H "content-type: application/json" -d "{\"key\":\"enabled\",\"value\":true}"
```

### 5.3 `publish: "published"` 但选择器里没有

名册是真的注册了，问题在 DSH 侧：

1. 模型选择器有没有切到「小浣熊」这个 provider（`raccoon-web`）
2. `refresh-catalog` 之后 `syncPublisher()` 会重新发布 —— 直接打一次
3. 还不行就看 `status.models` 的 `id` 与选择器里的名字对不对得上（显示名是 `${description} · x${billing_multiplier}`）

```powershell
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=refresh-catalog" | Select-String '"ok":true'
```

### 5.4 目录里少了模型

`visible: false` 的模型默认被过滤（上游有 3 个 `raccoon-*` 是这种）。这是**刻意的**：官方客户端也不显示它们。它们的 `tags` 里可能带 `vision`，但既然官方不列，我们也不列。

### 5.5 上下文窗口显示 1M，实际却按 128K 发

`contextCap` 默认 128000，`toDescriptor()` 与 `statusModels()` 用同一套截断（`Math.min(upstream, cap)`）。设置卡改 `contextCap` 会同时改两边：

```powershell
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=set-setting" -H "content-type: application/json" -d "{\"key\":\"contextCap\",\"value\":256000}"
```

改完 `status.models[].contextWindow` 应该立刻跟着变（`set-setting` 内部会 `refresh-catalog` 并重新注册）。

---

## 6. 扫码相关

### 6.1 「二维码已过期或已被使用」（手机扫出来就这句）

**先看操作顺序**。这是项目早期踩过的坑（E-029）：

- `LoginFlow.start()` 的实现是**先 `cancel()` 再取新码** → 新码生成的一瞬间，旧码在服务端就作废了
- 所以**贴给用户一张码之后，不能再跑任何会触发 `login-start` 的命令**（包括旧版 `login-qr.mjs` 的默认行为）

正确顺序：

```powershell
node scripts/login-qr.mjs --new         # 只在这一步换码
# 把 PNG 贴给用户
node scripts/login-qr.mjs --wait-only   # 后台盯状态，绝不换码
```

在界面里也一样：点了「扫码登录」拿到码之后，**不要重复点**。

### 6.2 手机确认了但一直 `pending`

| 检查 | 现象 | 解决 |
| --- | --- | --- |
| `settings.qrProtocol` 是 `web` 还是 `iam` | 两种码**互不通用** | 微信小程序只认 `iam`；官方客户端同款是 `web` |
| `web` 协议下 code 是本地生成的 45 字符 | 正常 | `pollWebSession` 对任何合法 code 都回 `pending`，**没有失败信号**，只能等用户确认 |
| 状态卡在 `logging` | 用户扫了但没在手机上点确认 | 等；`logging` 与 `pending` 文案不同 |
| 一直 `expired` | 5 分钟到了 | 重新 `--new` 一张 |

切协议：

```powershell
curl.exe -s -X POST "http://127.0.0.1:57292/plugins/dsh-raccoon-web/action?action=set-setting" -H "content-type: application/json" -d "{\"key\":\"qrProtocol\",\"value\":\"iam\"}"
```

切换会作废在途会话（`start()` 每轮重新读协议）。

### 6.3 二维码扫不出来

编码器是自己实现的（byte 模式 + M 级 + 版本 1–10），出错概率最高的是三处：**版本 ≥7 的版本信息块**、**版本 ≥5 的分块交错**、**8 种掩码选优**。

```powershell
# 拿一张真码落成 PNG
node scripts/login-qr.mjs --new --out research/captures/qr.png

# 用两个检测器交叉验证（只用其中一个会误判，见 E-024）
node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/verify-qr.mjs
```

判定标准：解出来的 URL 必须含

- `code=`（`web` 是 45 字符 `\d{13}[a-f0-9]{32}`；`iam` 是 `qr-...`）
- `appname=`（`web` 是 `小浣熊官网`，`iam` 是 `商汤小浣熊`）

两个都不对说明编码器坏了；只有一个不对说明是协议选错。

---

## 7. 对话报错

### 7.1 文案对照

| 界面文案（开头） | kind | 真实原因 |
| --- | --- | --- |
| 小浣熊登录已失效… | AUTH | 401 / 403 / 业务码 200003 |
| 小浣熊账号的模型吞吐已达上限… | RATE_LIMIT | HTTP 429，或 **HTTP 200 + `{"code":200429}`**，或响应体含 `user_model_rate_limited` |
| 小浣熊服务端出错了… | SERVER | 5xx，或流里带 error 帧 |
| 小浣熊响应超时… | TIMEOUT | 60s 无首字节 / 120s 无新帧 |
| 网络连接中断… | TRANSPORT | fetch 抛 `ECONNRESET` / `ENOTFOUND` |
| 请求被拒绝… | INVALID_REQUEST | 400，或 413（图片太大） |

`classifyPiAiError()`（`dsh-llm-pi-ai/lib/index.js:1448`）是**按 `errorMessage` 文本正则**分类的。所以我们的中文文案里**不能出现 `400`、`timeout`、`rate limit` 这类词**，否则会被重新归类。

### 7.2 已修过的两个 bug（看到这些字样说明跑的是旧构建）

| 报错 | 根因 | 已修 |
| --- | --- | --- |
| `providers is not iterable` | 内核 `replace(providers: string[]): void` 返回 void，旧代码当成返回 handle 并赋回 `this.handle` | 改成「先释放再注册」（CHANGELOG「修复」段第 1 条） |
| `Provider is not configured: raccoon-web` | `auth.apiKey.resolve()` 恒返回 `undefined` | 改成返回 `{auth:{apiKey}}`（同段第 3 条） |

确认构建：

```powershell
curl.exe -s "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status" | Select-String '"build"'
```

### 7.3 首字节超时（60s）

```
[raccoon-web] stream first byte timeout after 60000ms (model=sn-xxx, msgs=12)
```

**这不是 bug**，是上游高峰期的真实表现（`dsh-raccoon-connect` 的 README 也记了"首字节中位 1–2 秒，高峰有 60s+ 无响应"）。本项目实测一次正常对话首字节 **1637ms**。

| 情况 | 处理 |
| --- | --- |
| 偶发（<10%） | 重试一次即可 |
| 频繁（>30%） | 换模型（`sn-sensenova-6-8-flash` 最稳）或缩上下文 |
| 每次都超时 | `node scripts/probe-gateway.mjs --from-profile` 确认网关本身 |

### 7.4 思考内容不出现

三个可能：

1. `settings.reasoning` 关着 → 我们发的是 `extra_body.thinking.type = "disabled"`
2. 模型本身不思考（`tags` 里没 `reasoning`）
3. **正常情况下即使关了也还会回吐少量 `reasoning_content`**（E-035 实测：`disabled` 后仍有 81 字符）。UI 必须容忍这一点，不要拿"有没有 reasoning"当作开关生效的判据 —— 要看**字符数显著变短**（基线 260 → 81）。

验证：

```powershell
npm run smoke:chat
```

它跑真对话并打印事件序列（期望 `block-start → reasoning-delta ×N → block-start → text-delta → block-end ×2 → usage → finish`）。

### 7.5 工具调用参数拼错

`tool_calls` 的 `index` 必须**累积**（同一 index 的多次 delta 拼起来）。这块**不用我们实现** —— 由 pi-ai 的 `openai-completions` 处理（[ADR-0007](../02-design/adr/0007-wrap-openai-completions-api.md)）。如果我们只做 `onPayload` 注入，却出现参数拼接错，说明是 pi-ai 版本变了。

---

## 8. 余额 / 积分不对

### 8.1 显示 `—`

```powershell
# 用自己的 token 打（不要贴进聊天）
node scripts/probe-gateway.mjs --from-profile
```

| 返回 | 含义 |
| --- | --- |
| `data.available_points` | 正常 |
| `data` 是别的键名 | 字段名变了 → `fetchBalance` 有五个候选键，补进去 |
| 401 / 403 | token 失效 |

界面在**没有值**时显示 `—` 而不是 `0` —— 这是刻意的，`0` 与"不知道"必须能区分。

### 8.2 数字对但"今日已到账"判断错

判定依赖 `GET /api/web/points/v2/bills?paging.limit=50&type=all` 里找 `biz_type === "daily_grant"` 且 `raccoonDay(grant_at) === 今天`（`Asia/Shanghai`）。

| 原因 | 检查 |
| --- | --- |
| `biz_type` 值变了 | 抓一份 bills 看实际值 |
| 时区算错 | PT-2 / PT-3 单测（`15:59Z` 应算今天、`16:00Z` 应算明天） |
| 当天流水超 50 条 | 加大 `limit` |

### 8.3 界面上出现"签到"

**不应该出现**。这个小浣熊没有独立签到接口，每日积分是"当天首次带登录态打开网页时发放"。插件**只读不写，不代领**（[ADR-0006](../02-design/adr/0006-vision-detection-by-probe.md) 同族决策）。出现"签到"字样是文案 bug，改成"今日积分已到账 / 未到账"。

---

## 9. 卸载后的残留

### 症状

卸载后重启 DSH 报 409，或路由冲突。

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" | Select-String "raccoon"
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" | Select-String "raccoon"
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-raccoon-web"
```

### 解决

```powershell
node scripts/unlink.mjs            # 清四处：dependencies / bundles / patch 块 / node_modules junction
node scripts/unlink.mjs --dry      # 先看会改什么
node scripts/unlink.mjs --purge-data   # 连 $DSH_HOME/state/dsh-raccoon-web 一起删
```

默认**保留** `token.json`（重装不用重新登录），要清得显式 `--purge-data`。

`unlink.mjs` 的 patch 清理是行扫描状态机，同时认裸包名与 `file://...lib/index.js?v=...` 两种 `name` 形态。

### 根因（如果真发生了）

说明某个资源没挂在 `ctx.effect` 上。必须挂的六类：

```ts
ctx.effect(() => webServer.register({...}))        // 路由
ctx.effect(() => llm.registerAdapter([...], a))     // adapter 注册
ctx.effect(() => settings.register(...))           // settings ns
ctx.effect(() => () => { unwatch(); host.dispose(); })  // 宿主（含定时器）
ctx.effect(() => ..., "label")                     // 旧式写法（三个参考插件都用）
```

`Publisher.dispose()` 必须能重复调用（幂等），并且要在注销后把 `handle` 置空。

---

## 10. 性能

| 症状 | 检查 | 解决 |
| --- | --- | --- |
| DSH 启动变慢 | `apply` → `bootstrap` 的耗时 | `apply()` 必须**同步返回**，异步全走 `void bootstrap()`；不能有 `await fetch` |
| 内存持续涨 | 任务管理器看宿主进程 | `TtlCache` 有 inflight 去重但无上限（模型数量有限，可接受）；检查订阅有没有 `off` |
| 界面卡顿 | 药丸 20s 轮询 | 失焦应暂停（`document.visibilityState`），登录中才 1.5s |
| 长时间不用后第一次对话慢 | 正常（凭据解析 + 目录刷新） | 不用管 |
| 每 20 秒一次 `/status` 请求 | 正常 | 药丸轮询；设置卡 5s；出错退避 30s→60s |

---

## 11. 收集诊断信息

设置卡点「复制诊断信息」得到 13 行：

```
插件: dsh-raccoon-web 0.1.0
构建: 2026-11-06T12:35
平台: win32 x64 / node v24.21.0
登录: ready
来源: 官方客户端凭据
桌面端: 已读到 (C:\Users\Administrator\.office-raccoon\agent\config\auth.json)
账号: pu-01a19…
provider: published
目录: 6 个模型
余额: 11,682（永久 10,500 / 每日 1,182）
上下文上限: 128000
思考: 开
扫码协议: Web auth（官方桌面端同款）
```

**里面没有 token**。设计上 token 从不进浏览器，所以这段天然安全。

要更细的信息：

```powershell
# 完整 status（含 qrSvg，别整段贴出来）
curl.exe -s "http://127.0.0.1:57292/plugins/dsh-raccoon-web/status" > .tmp\s.json

# 真对话事件序列
npm run smoke:chat

# 真网关五端点
node scripts/probe-gateway.mjs --from-profile
```

> `~/.dsh/logs/` 里**没有当前实例的日志**（最后写于 2026-11-03）。排障走 HTTP 端点，不要翻日志目录。

---

## 12. 这张表之外的问题

按顺序做四件事：

1. **`node scripts/probe-gateway.mjs --from-profile`** —— 确认网关没变
2. **看 `docs/01-research/05-empirical-findings.md`** —— 是不是某个"仍缺"的实测现在有答案了
3. **看 `devlog/` 最近三篇** —— 是不是刚改了什么
4. **记一条实测** —— 不管解没解决，把现象和时间写进 `05-empirical-findings.md`

第 4 条是这个项目的核心纪律：**网关行为变了不是"代码有 bug"，是"假设过期了"**。先把新事实记下来，再改代码。
