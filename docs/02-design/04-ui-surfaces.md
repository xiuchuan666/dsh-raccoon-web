# 界面

最后更新: 2026-11-11（按 `client.js` 实现回填，1,525 行；补账号池 UI、两个扫码入口隔离与 14 行诊断）
状态: 已定稿

> 一句话：**一个药丸 + 一张设置卡（内含账号池）；设置卡同时挂到「插件详情页」与「设置对话框左侧菜单」两个入口；所有文案内联在 `client.js`，所有颜色走 `var(--dsh-*, fallback)` 双写。**

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

### 任何时候都显示（选中的不是小浣熊时标注）

```js
// CreditPillGate：读 projection 只为了"标注"，不再用它决定显不显示。
var projection = props.useProjection && props.useProjection('modelSelection');
var selected = projection === undefined ? undefined : (projection.next || projection.lastUsed);
var selectedProvider = selected === undefined ? undefined : selected.provider;
return h(CreditPill, { t: t, selectedProvider: selectedProvider });
```

`CreditPill` 里 `isCurrent = selectedProvider === undefined || selectedProvider === PROVIDER_ID`：

- `isCurrent` → 药丸常态样式，详情面板不额外提示。
- `!isCurrent` → 按钮 `opacity: 0.72`，详情面板末尾多一行 `pillOtherModel`（"这是小浣熊账号的余额，与当前选的模型无关；切换模型不会改变这个数字。"）。

**为什么改成"总是显示"**：早先只在 `selected.provider === PROVIDER_ID` 时渲染，而用户默认模型是 `workbuddy-global` → 药丸永不出现，用户报"输入框里看不到积分"（2026-11-11 修）。余额是**账号级**属性，与当前选哪个模型无关；藏起来只会让人以为插件坏了。

拿不到 projection（宿主没提供）时**照显** —— "不知道"不该把可能是真的信息藏起来。

### 轮询

| 状态 | 间隔 |
| --- | --- |
| 登录中（`pending` / `logging`） | 1.5 s（`POLL_LOGIN_MS`） |
| 其余一切（含 `expired` / `error`） | 20 s（`POLL_IDLE_MS`） |

按 2026-11-11 的 `client.js` 实现回填。**没有指数退避** —— 早期设计稿写过"出错后 30 s → 60 s"，
实现里没有这条：宿主挂了的时候 `load()` 走 catch、保留上一份快照、按 20 s 继续试，这已经足够，
再加一层退避只会让宿主恢复后界面更慢跟上。

**没有"失焦就停"** —— 定时器照常跑（后台会被浏览器降频，正好是我想要的效果）；
`visibilitychange` 只在**变回可见时**补拉一次，因为用户切回来看到的第一眼不该是十分钟前的余额。

**刷新不丢**：`load()` 发现自己在飞时不再直接 `return`，而是置 `reloadWanted`，本轮返回后补跑一次。
否则 `act()` 结尾那次刷新有可能正好撞上轮询被静默丢弃 —— 用户点完「测试」或勾完开关要等
下一个 20 秒才看到变化，看起来像按钮没生效（2026-11-11 修）。

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
│  │  ...（14 行）                                        │ │
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

**「账号」那一行的数据来自 `displayToken()`，不是 `this.token`。** 号池开着的时候真正在服务的是池成员，而 `this.token`（当前账号）可能恰好是空的（典型：用户装过官方客户端、只用「导入客户端账号」把号加进池，从没扫过码）。早先 `snapshot()` 直接传 `this.token`，那种用户的「账号」永远是 `—`，看着像没登录。`displayToken()` 走 `peekPoolAccount()`（**只读**，不选号、不打日志），池成员在服务就报它的 `principal`/`kind`/`expiresAt`/`source`，否则退回 `this.token`。关掉号池且没有当前账号时必须退回 `—` —— 不能把池成员的 principal 留在展示层，否则用户会以为还在用池里的号（`scripts/smoke-pool.mjs` 第 6.5 段有正反两条断言）。

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
| 自动换号 | `poolEnabled` | `false` | 打开后按号池排序自动选号；关掉立刻退回当前账号（ADR-0010） |

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

### 6.5 账号池（ADR-0010）

设置卡里 `ModelsSection` 与 `SettingsSection` 之间多一块 `PoolSection`：

```
账号池                                       3 个账号 · 2 个启用
每个账号有独立的设备标识，互不干扰。成员要显式勾选才会被拿去发请求。

  自动换号                                          [ ●—— ]
  打开后，一个账号额度用完或撞到限流就自动切到下一个。
  关掉只停止自动换号 —— 签到与测试仍然可用。

  ☑ 7b86c892   pu-01a19   [当前使用]              可用
     设备 c9012c1d · 凭据 2026-12-04 到期              [测试] [移除]
  ☐ 3f0a91cc   pu-02b3...                        限流中
     设备 91aa02f1 · 冷却到 21:10                      [测试] [移除]

  [扫码添加]  [导入客户端账号]  [一键签到]
  新加进来的账号默认不启用，勾上才会被拿去发请求。
```

| 元素 | 动作 | 说明 |
| --- | --- | --- |
| 自动换号开关 | `set-setting` `{key:'poolEnabled'}` | 关掉立刻 `poolActiveId = undefined` 并退回当前账号 |
| 勾选框 | `pool-toggle` `{id, enabled}` | **即时生效**，写盘失败回滚内存并提示 |
| 测试 | `pool-test` `{id}` | 用该号凭据打 `model_catalog`，**零 token 成本**；也是唯一能让 `dead` 回池的路径 |
| 移除 | `pool-remove` `{id}` | **两段式**（第一次点变「确认移除」），不用 `window.confirm` |
| 扫码添加 | `pool-add-start` | 走 `LoginFlow.start("pool")`，**不写 `token.json`、不改主登录相位** |
| 导入客户端账号 | `pool-import-desktop` | 只读 `auth.json` 拿 token，不复制文件 |
| 一键签到 | `pool-checkin` | 遍历**全部**账号（含未启用）；先查流水再写；单个失败只标该行 |

**三条从 workbuddy 学来的硬约束**（写进 `PoolSection` 的文件头注释）：

1. **开关只控制"插件要不要自己决定用谁"，不控制"你能不能操作"** —— 关掉自动换号时签到/测试仍可用。workbuddy 曾把按钮挂在开关上，结果用户关掉后再也没法签到。
2. **勾选即时生效，失败回滚显示** —— `act()` 无论成败都 `load()` 一次，界面永远反映宿主真实状态。
3. **删除两段式，不用 `window.confirm`** —— 某些宿主会拦原生对话框，拦了按钮就彻底没反应。

**二维码跟宿主状态走，不用点击那一刻的快照**：`pendingQr` 只在 `login.phase` 是 `pending`/`logging` 时渲染，相位一变就自动收起。不复用主登录段的相位，因为那是"当前账号"的入口，混在一起会让用户以为加号会顶掉当前账号。

**设备标识只显示 8 位十六进制**（去掉 `raccoon-` 前缀）：用途是让用户看出两个号不是同一个环境，不是让人拿去复刻。

---

## 6.6 两个扫码入口共用一个 `LoginFlow` —— 必须靠 `login.mode` 认领

设置卡里有**两个**扫码按钮：「登录」区的「扫码登录」（换当前账号）和「账号池」区的「扫码添加」（往池里加一个成员）。底下只有**一个** `LoginFlow` 实例，`start(mode)` 会先 `cancel()` 再取码。

于是有一个真实的串台场景（2026-11-11 修掉）：

1. 用户点「账号池 → 扫码添加」→ `start("pool")`，`phase = pending`，池区显示二维码。
2. 用户又去上面点「扫码登录」→ `start("primary")`，把上一轮取消并生成新码，`phase` **仍然是** `pending`。
3. 池区原来的判据是 `pendingQr !== undefined && (phase === 'pending' || 'logging')` —— 依然为真，于是**池区继续显示一张已经属于主登录的二维码**。用户扫完，token 写进 `token.json`，池里什么也没多。

反向同理：池区在等码时，登录区会把池的码显示成"换当前账号"的码。

### 修法：status 里带 `mode`，两个区各自认领

- `LoginSnapshot.mode: "primary" | "pool"`（`src/host/login-flow.ts`），`snapshot()` 一律带上；
- `loginBlock()`（`src/host/routes.ts`）透传成 `StatusLogin.mode`；
- `LoginFlow` 在 `cancel()` / `markReady()` / `markDead()` / `complete()` 的池分支里都把 `mode` 收回 `"primary"` —— 这四个时刻都意味着"这一轮扫码结束了"，留着 `pool` 会让前端以为还有一张池的码在等。

前端两处判据：

```js
// PoolSection：只有这一轮是给池加的，才认领这张码
var scanning = pendingQr !== undefined
    && login.mode === 'pool'
    && (login.phase === 'pending' || login.phase === 'logging');

// LoginSection：反过来，池在等码时不要显示那张码，改说一句"码在下面"
var pendingIsPool = login !== undefined && login.mode === 'pool';
```

`pendingIsPool` 时登录区显示 `t('loginPoolBusy')`：

> 正在为账号池添加账号 —— 二维码在下面的「账号池」区域，扫完不会改变当前账号。

**为什么不用"哪个按钮最后被点"来判断**：点击状态只活在前端内存里，刷新页面、换一个窗口、或者宿主重启过就没了；`mode` 是宿主侧的事实，`status` 每次轮询都带着它，前端重开也能对上。

**为什么 `ready` / `expired` 时必须是 `primary`**：那两个相位描述的是"当前账号"，与上一轮池登录无关。留着 `pool` 会让池区在一个已经结束的会话上继续显示二维码。

---

## 7. 诊断块

14 行 `key: value`，点「复制诊断信息」走 `navigator.clipboard.writeText()`。

```
插件: dsh-raccoon-web 0.1.0
build: 2026-11-11T23:05
平台: win32 / node v24.21.0
登录: ready (access_token)
来源: 官方客户端凭据
桌面端: 已读到 (C:\Users\Administrator\.office-raccoon\agent\config\auth.json)
账号: pu-01a19
provider: published
目录: 6 个模型
余额: 383
上下文上限: 1000000
思考: 开
扫码协议: Web auth（官方桌面端同款）
号池: 关（池空）
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

## 10. 文案（内联，各 117 键：88 + 29 个 `pool*`）

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
| `loginPoolBusy` | 正在为账号池添加账号 —— 二维码在下面的「账号池」区域，扫完不会改变当前账号。 |
| `quotaGranted` | 今日每日积分已到账 |
| `quotaNotGranted` | 今日每日积分未到账 |
| `quotaGrantUnknown` | 今日积分状态未知 |

**`quotaGranted` 的措辞刻意不用"签到"** —— 药丸显示的是余额读数，不是领取动作的回执。真正点按钮领积分的是号池里的「一键签到」（E-036），文案在 `poolCheckinGranted`。两处分开写，用户才不会以为药丸能点。

---

## 11. 不做的六项 UI

1. ~~多账号切换~~ —— **已做，见 §6.5**。原判断「只用一个凭据来源」被 ADR-0010 取代：号池是**并列**的第二身份来源，不替换 `authSource` 三态。
2. **自定义 baseUrl** —— 上游只有一个域名，开放这个等于开放 SSRF。
3. **请求日志面板** —— 日志里不该有用户说了什么。
4. **模型启用/禁用勾选** —— 名册直接跟目录走，多一层状态只会不一致。
5. **历史同步** —— 那是宿主会话管理的事。
6. ~~签到按钮~~ —— **已做**。原判断「上游没有独立签到接口」被 E-036 推翻（`POST /api/web/desktop/v1/login/points/grant` 实测 200），现在有「一键签到」。

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
- 扫码协议：[ADR-0009](./adr/0009-web-auth-qr-protocol.md)
- 账号池：[ADR-0010](./adr/0010-account-pool.md) / [07-account-pool](./07-account-pool.md)
- 排障（界面没显示）：[01-troubleshooting §2](../04-ops/01-troubleshooting.md)
