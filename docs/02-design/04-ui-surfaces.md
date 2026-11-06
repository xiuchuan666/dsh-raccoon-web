# 界面

最后更新: 2026-11-06（按 `client.js` 实现回填，1146 行；补 `settings.section` 注册）
状态: 已定稿

> 一句话：**一个药丸 + 一张设置卡；设置卡同时挂到「插件详情页」与「设置对话框左侧菜单」两个入口；所有文案内联在 `client.js`，所有颜色走 `var(--dsh-*, fallback)` 双写。**

---

## 1. 三个 slot

| slot | 什么时候出现 | 注册方式 |
| --- | --- | --- |
| `conversation.input.left` | 对话输入框左侧的工具行 | `id: 'raccoon-credits'`，`order: 4` |
| `plugins.bundle.config` | 插件面板 → 已安装列表 → 点开 `dsh-raccoon-web` 包详情 | `key: BUNDLE_NAME`（**注意是 `key` 不是 `id`**） |
| `settings.section` | **设置对话框左侧菜单**（与「模型 / 内置插件 / 侧边卡片」同列） | `id: BUNDLE_NAME`，`order: 95`，`label: () => t('title')` |

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
  { name: 'conversation.input.left', id: 'raccoon-credits', order: 4,
    locale: NAMESPACE, inject: () => ({ t }) },
  CreditPillGate));

ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
  { name: 'plugins.bundle.config', key: BUNDLE_NAME,
    locale: NAMESPACE, inject: () => ({ t }) },
  PluginPage));

// 设置对话框左侧菜单。用一层包装组件闭包捕获 t，不依赖内核把 inject 返回值
// 合成 props 的具体方式；同时透传 sectionProps（宿主给的 close 等）。
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: BUNDLE_NAME, order: 95,
    label: () => t('title'), locale: NAMESPACE },
  sectionProps => h(PluginPage, Object.assign({}, sectionProps, { t }))));
```

**为什么 `conversation.input.left` 用 `id`、`plugins.bundle.config` 用 `key`**：两个 slot 的契约不同（前者是"往同一行塞一个渲染器"，后者是"按包名找设置页"）。写混了会静默不显示。

**为什么 `settings.section` 必须单独注册**（2026-11-06 实测，用户报「设置里并没有找到调整的入口」）：设置对话框左侧菜单走 `settings.section`（kind=list, scope=root），与 `plugins.bundle.config` **不是同一个界面**。`plugins.bundle.config` 只在「插件」面板里点开某个包详情才渲染，用户看的是「设置」对话框，两者不互通。早先只注册了前两个 slot，所以 `contextCap` 输入框（§5 设置项）虽然写好了却没地方显示。

- `id` 是 required（cell key，驱动 `only` 过滤）；`order` 升序（内置项 `account -10` / `models 10` / `plugins 15`，`agent-presets` 无 order；第三方 `dsh-better-sidebar` 用 `100`），我们取 `95` 排在内置之后、侧边卡片之前；
- `label` 用 thunk `() => t('title')`，跟随 locale 切换（每次投影重读）；
- `PluginPage` 只依赖模块级 store + `props.t`，**不碰宿主 ctx**，所以能同时挂到两个不同契约的 slot；用包装组件闭包捕获 `t` 是**必需**的：`dsh-client-ui-settings-general/lib/client.js:337` 用 `renderSlot("settings.section", { close: onClose }, { only: active })` 渲染，组件只拿到 `{ close }`；菜单投影（同文件 `:1151-1156`）只读注册项的 `id` / `order` / `label` 三个字段，`inject` 不参与组件 props 合成。所以 `t` 只能靠闭包带进去，加 `inject` 也不会自动变成 props。

同款写法可在 `profile/node_modules/dsh-better-sidebar/lib/client.js:33050` 看到（截图里「侧边卡片」就是它）。

---

## 2. 积分药丸

```
┌──────────────────────────────────────────────────┐
│  [ 小浣熊 · 11,682 ]   ← 24–28px 高的按钮          │
└──────────────────────────────────────────────────┘
        ↓ 点击展开
┌──────────────────────────────────────────────────┐
│  可用        11,682                              │
│  永久        10,500                              │
│  每日         1,182                              │
│  Provider    published                           │
└──────────────────────────────────────────────────┘
```

### 五种文案

| 条件（按优先级） | 文案 |
| --- | --- |
| `status === undefined` 且无 error | `小浣熊 · 读取中` |
| `status === undefined` 且 error | `小浣熊 · 未登录` |
| `login.phase` 是 `expired` / `error` | `小浣熊 · 登录失效` |
| `publish === "not-configured"` | `小浣熊 · 未登录` |
| `quota.available !== undefined` | `小浣熊 · {千分位}` |
| 其它 | `小浣熊 · —` |

**缺值显示 `—` 而不是 `0`**：`0`（真的没积分）与"不知道"必须能区分。

### 只在选中小浣熊时显示

```js
var projection = props.useProjection?.('modelSelection');
var selected = projection?.next || projection?.lastUsed;
if (selected?.provider !== undefined && selected.provider !== PROVIDER_ID) return null;
```

拿不到 projection（宿主没提供）时**照显** —— "不知道"不该把可能是真的信息藏起来。

### 轮询

| 状态 | 间隔 |
| --- | --- |
| 登录中（`pending` / `logging`） | 1.5 s |
| 空闲 | 20 s |
| 出错后 | 30 s → 60 s |
| 页面失焦（`document.visibilityState === 'hidden'`） | **停** |

失焦恢复时立刻拉一次。

**药丸不显示错误** —— 输入框旁边弹红字会干扰输入，错误只出现在设置卡里。

---

## 3. 设置卡

```
┌─ 小浣熊 ────────────────────────────────────────────────┐
│                                                          │
│  登录                                                    │
│  ┌────────────────────────────────────────────────────┐ │
│  │  已登录                      [退出登录]              │ │
│  │  账号        pu-01a19                               │ │
│  │  来源        官方客户端                              │ │
│  │  令牌类型    access_token                            │ │
│  │  到期        2026-12-04 13:33                        │ │
│  │  这份凭据是官方客户端在维护的，插件只读。要真正退出，  │ │
│  │  请到客户端里退出登录。                              │ │
│  │  [读取客户端登录态] [扫码登录]                       │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  积分                                                    │
│  ┌────────────────────────────────────────────────────┐ │
│  │  可用     11,682        永久  10,500   每日  1,182  │ │
│  │  今日每日积分已到账                                  │ │
│  │  [刷新]                                             │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  模型 · 6                                                │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Kimi-K3 · x1.00                    识图 [实测读图] │ │
│  │  128K 上下文                                        │ │
│  │  GLM-5-3 · x0.75                    文本 [实测读图] │ │
│  │  128K 上下文                                        │ │
│  │  ...                                                │ │
│  │                                    [刷新模型目录]   │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  设置                                                    │
│  ┌────────────────────────────────────────────────────┐ │
│  │  登录来源   [自动（客户端优先）▾]                    │ │
│  │  自动：先读官方客户端；读不到再扫码。                │ │
│  │  扫码协议   [Web auth（官方客户端同款）▾]            │ │
│  │  Web auth：code 本地生成…两种码互不通用。            │ │
│  │  ☑ 启用为 provider                                  │ │
│  │  ☑ 开启思考（extra_body.thinking）                  │ │
│  │  上下文上限 [128000]                                 │ │
│  │  ☐ 详细日志                                          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  诊断                                                    │
│  ┌────────────────────────────────────────────────────┐ │
│  │  插件: dsh-raccoon-web 0.1.0                        │ │
│  │  构建: 2026-11-06T12:35                             │ │
│  │  ...（13 行）                                        │ │
│  │                                     [复制诊断信息]  │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 登录段的四个相位

| `login.phase` | 显示 |
| --- | --- |
| `ready` | 已登录 + 四行明细（账号 / 来源 / 令牌类型 / 到期）+ 桌面端时多一行只读说明 + 两个入口按钮 |
| `pending` | 「等待扫码」+ 倒计时 + 二维码 + **[重新获取] [取消] [读取客户端登录态]** |
| `logging` | 「已扫码，请在手机上确认」+ 倒计时 + **同一张二维码**（不重置）+ 三个按钮 |
| `expired` / `error` / `none` | 对应标题 + `desktopHint()` + `login.message`（若有）+ 两个入口按钮 |

**`pending` 与 `logging` 的文案必须不同**。用户看到"等待扫码"会以为没扫上，可能重扫一张 —— 而重扫会 `cancel()` 掉当前会话（E-029）。

**`logging` 时不能重置二维码** —— 手机端正在确认，换一张图会让用户以为自己扫错了。

### `desktopHint()` 的两种判据

```js
if (desktopAuth.found === true) return null;
var text = reason.indexOf('过期') >= 0 ? t('loginDesktopExpired') : t('loginDesktopMissing');
```

- 找不到 / 没登录 → `未读到官方客户端的登录态：先在「商汤小浣熊」客户端里登录，或改用扫码。`
- 找到了但过期 → `官方客户端的登录态已过期：打开客户端重新登录一次，或改用扫码。`

两种处置完全不同，所以必须分开。

### 两个入口永远并列

```js
function entryButtons() {
  return h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    h('button', { onClick: () => run('refresh-auth') }, t('loginRefreshAuth')),  // 主按钮
    h('button', { onClick: () => run('login-start')  }, t('loginStart')));       // 次按钮
}
```

**不根据"有没有客户端"动态隐藏按钮** —— 用户可能刚在客户端里登录完，我们上次探测还是 `found: false`。让两个入口永远在，用户自己选。

---

## 4. 二维码面板

```js
h('div', { style: qrBoxStyle },
  h('div', {
    style: { width: '168px', height: '168px', lineHeight: 0 },
    dangerouslySetInnerHTML: { __html: login.qrSvg },
  }),
  h('div', { ...dimStyle, fontSize: '11.5px', textAlign: 'center' }, t('loginScanHint')));
```

**为什么用 `dangerouslySetInnerHTML`**：SVG 由 `protocol/qr.ts` 的 `renderQrSvg()` 本地生成，输入是它自己拼的字符串（`origin` + `code` + `appname`），颜色参数走白名单（`#rgb` / `#rrggbb`）。没有任何外部输入进到 HTML 里。

**尺寸固定 168px**：二维码矩阵是 57×57（含 4 格静默区），`viewBox` 让它自适应；`lineHeight: 0` 是防止 SVG 底部多出几像素行高。

**倒计时归零自动刷新一次**：

```js
var seconds = useCountdown(phase === 'pending' || phase === 'logging' ? login.deadline : undefined);
```

`useCountdown` 每 1000ms 更新；归零时**不自动 `login-start`** —— 因为那会作废用户可能正在扫的码。显示"已过期"，让用户自己点。

---

## 5. 模型列表

每行三段：

```
[ 名称 · x倍率 ]                 [识图] [实测读图]
[ 128K 上下文 ]  ← 11px 灰字
```

| 标记 | 含义 |
| --- | --- |
| `识图` | `model.vision === true`（来自 `tags` 含 `vision`，或探测结果为 true） |
| `文本` | `model.vision === false` |
| `已实测` | `model.probed === true`（有人点过「实测读图」并且得出结论） |

**「实测读图」按钮**：调 `POST ?action=probe-vision {model}`。它会用 3×3 纯红 PNG 问模型"这张图是什么颜色？只回答一个词"（[ADR-0006](./adr/0006-vision-detection-by-probe.md)）。

理由：目录的 `vision` 标签**不可信** —— 2026-09-18 有人实测 5 个模型错 2 个，两个方向都错（有标签但不读图、无标签但能读图）。

**上下文显示按 `contextCap` 截断**：与真正发给模型的值一致，不然用户会以为截断没生效。

---

## 6. 设置项

| 控件 | 键 | 默认 | 影响 |
| --- | --- | --- | --- |
| 登录来源 `<select>` | `authSource` | `auto` | 改它 → 立刻重跑凭据解析（`actionRefreshAuth`） |
| 扫码协议 `<select>` | `qrProtocol` | `web` | 只影响**下一次** `login-start`（在途会话不受影响） |
| 启用 `<input type=checkbox>` | `enabled` | `true` | 关掉 = 释放 provider 注册（模型选择器里消失） |
| 开启思考 | `reasoning` | `true` | 关掉 = `extra_body.thinking.type = "disabled"` |
| 上下文上限 `<input type=number>` | `contextCap` | `128000` | 区间 8192–2000000；改它 → `refresh-catalog` + 重新注册 |
| 详细日志 | `debugLog` | `false` | `logger.setDebug()` |

`contextCap` 的输入框 `onBlur` 与 `Enter` 提交；非法值回填原值并显示 `8192 – 2000000`。

**为什么 `contextCap` 默认 128000 而不是上游的 1e6**：小浣熊按**账号 token 速率**限流，一轮对话上下文越大越快撞到（上游无恢复时间）。主动降到 128K 是拿"窗口"换"能用"。

### 五个开关连起来看

| 场景 | 建议 |
| --- | --- |
| 只有官方客户端、没打算扫码 | `authSource: auto`（默认），什么都不用改 |
| 客户端没登录/不想用 | `authSource: qr` + 微信扫码 → `qrProtocol: iam` |
| 就想用官方客户端那套码 | `authSource: auto` + `qrProtocol: web`（默认） |
| 长文档要 1M 上下文、能接受偶尔限流 | `contextCap: 1000000` |
| 只想省钱（快问快答） | `contextCap: 32000` + 用 `x0.2` 的 `sn-glm-5-3-flash` |

---

## 7. 诊断块

13 行 `key: value`，点「复制诊断信息」走 `navigator.clipboard.writeText()`。

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

**不含 token**，有单测断言不含 `eyJ`。账号只给前 8 位。

`build` 与 `client.js` 的 `BUILD` 不一致时，页面顶部显示 ⚠ —— 这是判断"浏览器加载的是不是新版本"最快的方法。

---

## 8. 样式约定

全部 inline style，颜色一律 **`var(--dsh-*, fallback)` 双写**：

```js
var dimStyle = { color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '12px' };
```

**为什么不用 CSS 文件**：classic script 没法 `import` CSS，而动态 `<style>` 注入会与宿主样式冲突。inline + 主题变量是唯一在两个世界里都工作的方案。

**不写死背景色**：深色主题下写死 `#fff` 会让卡片变成一块白斑。

---

## 9. 无障碍

五项（都做到了）：

1. 药丸是 `<button>` 而不是 `<div onClick>` —— 可 Tab 聚焦、Enter 触发
2. 每个按钮都有 `title`（药丸的 `title` 是 `t('title')`）
3. `qrSvg` 带 `role="img"` 与 `aria-label="登录二维码"`
4. 所有 `<select>` 与 `<input>` 都有可见 `<span>` 标签（同行的 left 侧）
5. 状态变化走文案，不只靠颜色（`已登录` / `未登录` / `登录失效`）

**没做**：`aria-live` 播报余额变化（每秒打扰一次比不播报更糟）。

---

## 10. 文案（内联，各 86 键）

```js
var zh = { pillLoading: '小浣熊 · 读取中', ... };
var en = { pillLoading: 'Raccoon · loading', ... };
```

**为什么不用 `locale/*.json`**：宿主的 locale 加载有异步时序，key 缺失时会显示原始 key 名。内联的最坏情况是显示中文（用户能看懂）。

**`package.json` 的 `dsh.client.inject` 仍然列了 `@deepseek-ai/dsh-client-locale`** —— 因为 `ctx.locale.register()` / `ctx.locale.bind()` 这两个 API 本身要那个服务在场。

### 关键文案对照（必须精确，不是措辞问题）

| key | 中文 |
| --- | --- |
| `loginPending` | 等待扫码 |
| `loginLogging` | 已扫码，请在手机上确认 |
| `loginDesktopReadonly` | 这份凭据是官方客户端在维护的，插件只读。要真正退出，请到客户端里退出登录。 |
| `loginDesktopMissing` | 未读到官方客户端的登录态：先在「商汤小浣熊」客户端里登录，或改用扫码。 |
| `loginDesktopExpired` | 官方客户端的登录态已过期：打开客户端重新登录一次，或改用扫码。 |
| `settingQrHint` | Web auth：code 本地生成，不先请求服务端；官方桌面客户端用的就是这一种。IAM：需要先向服务端取码，是唯一能被微信小程序识别的一种。两种码互不通用。 |
| `quotaGranted` | 今日每日积分已到账 |
| `quotaNotGranted` | 今日每日积分未到账 |
| `quotaGrantUnknown` | 今日积分状态未知 |

**`quotaGranted` 的措辞刻意不用"签到"** —— 这个产品没有独立签到接口，每日积分是"当天首次带登录态打开网页时发放"。写"签到"会让用户以为有个按钮能点。

---

## 11. 不做的六项 UI

1. **多账号切换** —— 只用一个凭据来源（`authSource` 三态）。
2. **自定义 baseUrl** —— 上游只有一个域名，开放这个等于开放 SSRF。
3. **请求日志面板** —— 日志里不该有用户说了什么。
4. **模型启用/禁用勾选** —— 名册直接跟目录走，多一层状态只会不一致。
5. **历史同步** —— 那是宿主会话管理的事。
6. **签到按钮** —— 见上。

---

## 12. `BUILD` 与缓存

```js
var BUILD = '2026-11-06T12:35';        // client.js:41
globalThis.__DSH_BUILD_raccoon = BUILD; // 文件末尾
```

`src/build.ts` 的 `export const BUILD` 必须与它一致（`verify-install.mjs` 检查两处）。

**为什么要有这个常量**：
- `lib/client.js` 改了宿主会自动下发新 `rev`，但**页面不刷新就不会执行新代码**
- 在 Console 敲 `__DSH_BUILD_raccoon`，一秒分清"是构建没跑"还是"是浏览器缓存"

**为什么手写而不读 `package.json`**：ESM 读 JSON 要 import assertion，tsup 打包会把它变形。

---

## 13. 相关文档

- 整体架构：[00-architecture](./00-architecture.md)
- 时序：[02-data-flow](./02-data-flow.md)
- 状态存储：[03-state-and-storage](./03-state-and-storage.md)
- 识图探测：[ADR-0006](./adr/0006-vision-detection-by-probe.md)
- 凭据来源：[ADR-0008](./adr/0008-desktop-credential-reuse.md)
- 排障（界面没显示）：[01-troubleshooting §2](../04-ops/01-troubleshooting.md)
