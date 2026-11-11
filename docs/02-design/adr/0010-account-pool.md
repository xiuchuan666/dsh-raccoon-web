# ADR-0010 · 账号池：多账号、自动换号、一键签到、每账号独立设备身份

- 状态: Accepted
- 日期: 2026-11-11
- 决策者: 项目所有者
- 相关: [ADR-0008](./0008-desktop-credential-reuse.md)、[ADR-0009](./0009-web-auth-qr-protocol.md)、[E-036](../01-research/05-empirical-findings.md)、[E-037](../01-research/05-empirical-findings.md)、[E-038](../01-research/05-empirical-findings.md)、[07-account-pool](../07-account-pool.md)

---

## 背景

到 0.1.0 为止，这个插件只有**一个**身份来源：`authSource: auto|desktop|qr` 三态里选一个，最终落到**一个** token。这个形状对"我就一个号"是对的，但对下面三个真实需求都不成立：

1. **单号额度会见底。** 每日 1200 分、永久 10500 分，重度使用一天就能撞到底。撞到底之后的表现是 `402` 或限流 `200429`，用户看到的是"对话失败"，而不是"换一个号继续"。
2. **多号要能一起签到。** 每日积分是**登录后由服务端发放**（`POST /api/web/desktop/v1/login/points/grant`，E-036 实测 200），官方客户端每次启动都会打一次。有 3 个号就要开 3 次客户端，或者写 3 个脚本。
3. **多号共用一个设备身份是不合理的。** 上游用 `X-Client-Device-ID` 区分安装实例（E-038），三个账号在同一个 device id 上轮着用，等于自己把"这三个号是同一台机器上的同一批"写在了请求头里。

用户的原话（m05082）：

> 我想建立一个号池，插件的设置页面应该能统一管理这些账号，可以参考当前已经安装的 workbuddy 插件。其中一个账号用完了额度，可以自动切换下一个账号。然后带有一键签到功能，把所有的账号都一键签到了。每个账号尽量像 workbuddy 插件一样，给他一个独立的环境，防止封号。

## 决策

### 1. 号池是**并列**的第二身份来源，不是替换

`authSource` 三态保留原样，语义不变。新增一个**独立开关** `poolEnabled`（默认 `false`）：

| `poolEnabled` | 用哪个身份 |
| --- | --- |
| `false`（默认） | 完全走 ADR-0008 的老路径：桌面端凭据 → 扫码兜底。**号池里的账号一个都不碰。** |
| `true` 且池里至少一个 `enabled` 账号 | 号池按排序规则选一个。老路径的 token 变成"池外账号"，只在池全不可用时兜底 |
| `true` 但池为空 / 全被禁用 | 退回老路径，并在设置卡里明说"号池已开启但没有可用账号" |

**为什么默认关。** workbuddy 的教训写得很直白：「本机有登录 ≠ 要拿它去签到和花积分」。号池会自动**花掉**账号的积分，这必须是用户显式打开的动作，不能因为"你机器上有凭据"就默认接管。

**为什么空池不自动变成"全部账号"。** 同上。workbuddy 的原话是"那是唯一会花掉你没授权过的积分的解读"。我们照抄这条。

### 2. 成员是**显式勾选**，加入 ≠ 入池

加账号（扫码）只把它写进 `accounts.json`，`enabled` 初始为 `false`。用户要在列表里勾上它，它才参与自动换号与签到。

这条是为了让"我只是想存一个备用号"和"我愿意让它花钱"分开。

### 3. 存储：`accounts.json` 一个文件，多 token，`0600`

```
$DSH_HOME/state/dsh-raccoon-web/accounts.json
```

理由：

- **不拆成一账号一文件。** 号池的排序要跨账号比较（余额、过期时间），拆文件就要 N 次读 + 自己保证一致性。一个文件一次读、一次原子写。
- **不并进 `token.json`。** `token.json` 是"当前生效的单个凭据"，语义被 ADR-0008 定死了（`source: "desktop"` 的 token 不落盘）。号池是"一批候选择"，两者混在一起会让"退出登录"的语义变得无法解释。
- **权限 `0600`、目录 `0700`**，沿用 `store.ts` 的 `writeJson()`（temp + rename 原子写）。文件里是**明文 token**，和 `token.json` 同级同权限 —— 这个项目的边界一直是"token 落在用户自己的 `$DSH_HOME` 里"，不引入新的信任面。

**`status` 端点一个字节的 token 都不出现**（沿用 status.ts 头部的硬规则 1）。号池在快照里只暴露：`id` / `label` / `enabled` / `principal`（前 8 位）/ `expiresAt` / `deviceId`（前 8 位 + 省略号）/ `measure` / `dailyGranted`。

### 4. 自动换号：在 `resolveApiKey` 选号，在 `onResponse` 记测量

**选号点**：`Provider.auth.apiKey.resolve()` → host 的 `resolvePoolToken()`。每次对话请求开始前跑一次排序，选出当前账号。

**记测量点**：`createRaccoonApi()` 的 `onResponse` 钩子（pi-ai 的 `dist/api/openai-completions.js:202` `await options?.onResponse?.({ status, headers }, model)`）。按 status 分类：

| 观测 | 记为 | 效果 |
| --- | --- | --- |
| `200` | `ok` | 清空冷却，`until = 0` |
| `429` / 带 `200429` 的 body | `limited` | 冷却到上游给的重置时间；没给就 30 分钟（**不编造倒计时**） |
| `402` / 余额不足文案 | `empty` | 冷却到**次日 00:00 Asia/Shanghai**（每日积分刷新点） |
| `401` / `403` / `200001` / `200003` | `dead` | **不自动回池**，只能手动"测试"或重新扫码 |
| 其它 4xx | 不记 | 与账号无关，记了会白白闲置好号 |
| 网络/超时 | `flaky` | 30 分钟自动回池 |

**HTTP 400 不换号**这条是从 workbuddy 抄的关键判断：请求本身不合法时换号只是多等几轮看到同一个错，还会把好号一个个标成坏的。

**流中途断开不换号**：字节已经发给客户端了，重放会让用户看到两段拼接的回答。这条我们本来就做不到重放（pi-ai 的 retry 只在流建立前），所以是自然满足的，但写下来。

### 5. 排序：五条，顺序即优先级

```
① 可用优先         measure.state ∈ {ok, flaky} 且未在冷却中 → 参与选择；
                   冷却中的排最后，全部冷却时选"最早解锁"的那个
② 日更积分先花     daily 高者优先（daily_points 每天清零，不花就没了）
③ 余额高者优先     available 高者优先；**只在新鲜读数（10 分钟内）时参与**
④ 凭据更晚过期     expiresAt 大者优先（少一次重新扫码）
⑤ id 字典序        保证全序可复现，不依赖 Map 迭代顺序
```

**为什么 ② 排在 ③ 前面。** 这是 workbuddy issue #70 的教训：它原本把"快过期先花"排在"余额高"之后做严格字典序比较，结果"快过期优先"**实际从未生效**（两个账号的余额几乎从不恰好相等，第二层比较永远轮不到）。真实病例是一个账号 196.4 分在当天作废。代价是"临期 1 分会排到余额 5 万前面" —— 这是刻意的，因为那 1 分确定损失。

浣熊的对应物是 `daily_points`（每日 1200 分，次日清零）与 `reward_points`（永久）。所以 ② 的比较键是 **daily 降序**，③ 是 **available 降序**。

**为什么 ③ 要"新鲜读数"。** 排序不能为了排序去打上游。余额读数来自 `refreshQuota()` 的 60 秒缓存与签到/测试动作的顺带刷新；超过 10 分钟的读数当"未知"，不参与比较（退化成 ④ 比较）。

### 6. 一键签到：先查后写，单个失败不中断整批

`action=pool-checkin`：

```
for each account where enabled:
    bills = fetchBills(token, 50)        // 只读
    if todayGranted(bills): 该行 = "今日已领"，**不发写请求**
    else: POST /api/web/desktop/v1/login/points/grant
          granted === true  → 该行 = "已领取 +N"
          granted === false → 该行 = "今日已领"（幂等，见 E-036）
          抛错              → 该行 = 错误文案，继续下一个账号
```

**为什么先查。** 签到接口是**写**操作。对已经签过的号再打一次虽然幂等（E-036 实测两次都返回 `granted:false`），但那是"上游恰好幂等"，不是契约。先查后写让"批量签到"这个动作在最坏情况下也只产生必要的写请求。

**为什么单个失败不中断。** 5 个号里第 2 个 token 过期了，剩下 3 个仍然应该被签。整批中断等于让一个坏号连累四个好号。

**签到与开关无关。** `poolEnabled = false` 时签到按钮**仍然可用**。workbuddy 踩过这个坑：它曾把签到按钮挂在"账号池开关"上，结果关掉开关后再也没法签到。开关只控制"插件要不要自己决定用哪个号"，不控制"你能不能操作自己的账号"。

### 7. 独立环境：每账号一个 `X-Client-Device-ID`

**上游到底认什么**（E-038，asar 内 SDK CHANGELOG 原文）：

- `X-Client-Device-ID` 是**唯一**的设备身份头。
- 普通 App/Desktop **必须传真实 install ID**。
- 重新登录时须带**与可信设备绑定一致的** `X-Client-Platform` 与 `X-Client-Device-ID`，否则新 session 可能不是 trusted device。
- `DEVICE_LINK_REVOKED / 4003` → 重新扫码；`SESSION_REVOKED / 4004` → 重新登录。

**决策**：每个账号在**加入池的那一刻**生成一次 `deviceId = "raccoon-" + 32 位 hex`，落盘，此后终身不变（除非用户手动"重置设备身份"）。

- **为什么是随机生成而不是抄客户端的 install ID。** 抄客户端等于三个号共用客户端那一个 device id，正好是我们要避免的。而且客户端换机会导致我们的 id 跟着变，历史测量全废。
- **为什么不伪造平台指纹。** 上游 SDK 文档**没有**要求设备指纹签名（这点与 workbuddy 的 Turing SDK 路线不同）。它要的只是"同一个账号每次带同一个 install ID"。所以我们的"独立环境"是**身份隔离**，不是**指纹伪造** —— 这个区别必须写清楚，不要给用户一个"能防封"的错误承诺。
- **`x-client-platform` 保持 `desktop-windows`**（与真实客户端一致），不按账号变。变了反而可疑。
- **`x-raccoon-session-id` 天然隔离**：它由 `sessionIdFor(principal, modelId)` 算，principal 不同 → session id 不同。这条不用改。

**注入点**：`model.headers`（`roster.ts` 的 `toDescriptor`）。因为 `createClient()` 把 `model.headers` 展开进 `defaultHeaders`（`openai-completions.js:539`），而 `optionsHeaders` 最后合并。device id 变化 → 名册签名变化 → `Publisher.sync()` 走"先释放再注册"换实例。这是既有机制，不用新加通路。

**代价**：换号会触发一次 `registerAdapter` 重建。这是可接受的 —— 换号本来就发生在一次请求失败之后，不在流中间。

### 8. 加账号复用扫码流程，但不覆盖主 token

`action=pool-add-start` → 复用 `LoginFlow.start()`，但 host 置 `poolAddMode = true`。`onReady` 时：

- `poolAddMode === false`（默认）→ 老行为：`setToken()` 写 `token.json`
- `poolAddMode === true` → 写进 `accounts.json`（新账号 `enabled: false`），**不动** `token.json`，然后 `poolAddMode = false`

**为什么不做"账号池专用登录流程"。** 扫码状态机有 4 个容易写错的点（见 `login-flow.ts` 头部），复制一份就是复制四个 bug。一个布尔标志足够。

**桌面端凭据也能"加入池"。** `action=pool-import-desktop`：读 `readDesktopAuth()`，把它作为一个 `source: "desktop"` 的账号写进池。这样"我就一个号，但我想让它进池以便签到"也能用。

## 后果

### 正面

- 单号见底不再等于"对话失败"，自动换到下一个。
- 一键签到把 N 次开客户端变成 1 次点击。
- 每个号有独立 device id，避免"三个号在同一台机器同一实例"这个最直白的关联信号。
- 号池的观测（余额、冷却、签到状态）在设置卡里全部可见，不用猜。

### 负面

- **`accounts.json` 里是明文 token。** 与 `token.json` 同级别（`0600`），但账号越多，这个文件越值钱。UI 必须能一眼看到"这个文件在哪"。
- **自动换号会花掉你没盯着看的账号的积分。** 这是开关默认关闭的唯一理由，也是它最容易被误解的地方。
- **`dead` 状态不自动回池。** 用户可能觉得"过一会儿自己就好了"，但凭据被拒不可能是暂时现象，自动重试只会反复失败。要手动点"测试"。
- **换号会重建 adapter 实例。** 极短窗口内（微秒级同步段）provider 处于"已释放未注册"状态。既有 `Publisher` 已经是这个形状，不是新引入的风险。
- **"独立环境"不承诺防封。** 它只做到"身份隔离"。真正的风控维度（IP、行为、并发）不在这个插件的可控范围内，文档里不能暗示它能。

### 中性

- `poolEnabled` 是第八个 settings 键，`normalizeSettings()` 要加一条白名单。
- 诊断块从 13 行变 14 行（加一行"号池"），`test/status.test.ts` 的 `assert.equal(text.split("\n").length, 13)` 要同步改。

## 被否决的方案

1. **把号池塞进 `authSource` 变成第四态 `"pool"`。** 否决：`authSource` 回答的是"token 从哪来"，号池回答的是"用哪个账号"。合并之后"我想用桌面端凭据但我还想签到三个号"这种组合表达不出来，而且会让 ADR-0008 的三态语义变形。
2. **号池开启时把池里第一个账号当成"主 token"写进 `token.json`。** 否决：`token.json` 的语义是"用户显式登录的那个身份"。号池的选择是**运行时覆盖**，workbuddy 明确要求"手动选择不被改写"—— 它通过运行时覆盖决定谁服务，**从不写回保存的选择**；关掉号池立刻恢复。
3. **失败时立刻同步换号并重放请求。** 否决：流已经建立/字节已经发出的情况下重放会让客户端看到两段拼接的回答。换号只在**下一次请求**生效。
4. **每账号一个 `deviceId` 且每次请求随机。** 否决：上游要的是"同一账号稳定 install ID"，随机化正好破坏这个契约，比共用还糟。
5. **签到用"打开网页版首页"来触发服务端发放。** 否决：那是 `points.ts` 原来的猜测，已被 E-036 证伪 —— 有独立的写接口，为什么要用一个副作用不可控的页面访问去触发。
6. **把账号池做成独立插件。** 否决：它需要 `resolveApiKey` 的同一个注入点、同一份 `status` 快照、同一个设置卡。拆出去要么重复实现，要么造一个跨插件私有协议。

## 复审条件

出现以下任一情况时，这篇 ADR 需要重新审视：

1. 上游给 `X-Client-Device-ID` 加了签名/挑战（那"随机 install ID"就不再成立，需要真实设备 SDK 路线）。
2. `POST /api/web/auth/v1/refresh` 的 body 字段被逆向出来（那"凭据过期"可以从"重新扫码"降级为"自动续期"，号池的 ④ 排序权重会变）。
3. 上游开始对"同一 IP 多账号"做联合风控（那"独立环境"的承诺范围要重新界定，可能需要在文档里明确写出这条不在插件能力内）。
4. 出现按账号区分的模型可见性（`model_catalog` 目前对所有账号返回同一份，若将来按账号变，名册发布就要按账号走）。
