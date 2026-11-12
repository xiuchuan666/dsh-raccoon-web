# 号池设计：数据模型、选号状态机、签到与独立设备身份

> 决策依据见 [ADR-0010](./adr/0010-account-pool.md)。这份文档只讲**怎么实现**，不复述"为什么"。
>
> 一句话：**号池是并列的第二身份来源**，默认关闭；开启后按五条排序规则选一个账号服务对话；每个账号有自己的设备身份；签到先查后写、单个失败不中断整批。

---

## 1. 数据模型

### 1.1 `accounts.json`

位置：`$DSH_HOME/state/dsh-raccoon-web/accounts.json`（目录 `0700`，文件 `0600`，temp + rename 原子写）

```ts
/** 一个池内账号。**含明文 token，永远不进 status 快照。** */
export interface PoolAccount {
  /** 稳定 id。取 principal 的 40 位 sha256 前 16 位 —— 同一账号重复加入不会产生第二条。 */
  id: string;
  /** 用户可改的显示名。空则用 `principal` 前 8 位。 */
  label?: string;
  /** 明文 access token。 */
  token: string;
  /** 与 `StoredToken.kind` 同义。 */
  kind: "access_token" | "xhx_token";
  /** JWT 的 `sub`。用于算 session id 与显示。 */
  principal: string;
  /** JWT 的 `exp × 1000`。 */
  expiresAt?: number;
  /** 加入时间。 */
  addedAt: number;
  /** **是否参与自动换号与批量签到。** 新加入的账号一律 `false`。 */
  enabled: boolean;
  /** 这个账号的设备身份。加入时生成，终身不变（除非手动重置）。 */
  deviceId: string;
  /** 这个账号是从哪来的。`qr` = 扫码加入；`desktop` = 从客户端凭据导入。 */
  source: "qr" | "desktop";
  /** 最近一次测量的结果。观测，不是草稿。 */
  measure?: PoolMeasure;
}

/** 一次失败/成功的观测。 */
export interface PoolMeasure {
  /** `ok` 成功过；`limited` 被限流；`empty` 余额不足；`dead` 凭据被拒；`flaky` 网络/超时。 */
  state: "ok" | "limited" | "empty" | "dead" | "flaky";
  /** 这次观测的时刻。 */
  at: number;
  /** 冷却解除时刻。`0` 或缺失 = 不在冷却。`dead` 用 `Number.MAX_SAFE_INTEGER`。 */
  until?: number;
  /** 给人看的一句话。 */
  note?: string;
  /** 上游给的重置时间（秒或 epoch），有就照它算 `until`，没有就按默认值。 */
  resetHint?: string;
}

/** 余额读数的缓存。**不落盘**，进程内存里 10 分钟有效。 */
export interface PoolQuota {
  available?: number;
  daily?: number;
  permanent?: number;
  at: number;
}

export interface PoolDocument {
  schemaVersion: 1;
  accounts: PoolAccount[];
}
```

**为什么 `id` 用 `sha256(principal).slice(0,16)` 而不是随机 uuid。** 同一账号被扫两次（比如 token 过期后重新扫码）不该在池里出现两行。用 principal 派生 id，第二次加入就是"更新已有条目"。

**为什么 `measure` 落盘而 `PoolQuota` 不落盘。** 冷却时间是"跨进程仍然成立"的事实（重启之后一个被限流的号不该立刻又被选中）；余额读数是 10 分钟就过期的快照，落盘只会在下次启动时提供一个假的新鲜度。

### 1.2 与既有 `StoredToken` 的关系

| | `token.json` | `accounts.json` |
| --- | --- | --- |
| 数量 | 1 | N |
| 谁写 | 扫码登录（`LoginFlow.complete`）、`setToken` | 号池动作 |
| 语义 | "用户显式登录的那个身份" | "一批候选择" |
| `source: "desktop"` 的 token | **不落盘**（ADR-0008） | 导入时才落盘（用户显式点了"加入池"） |
| 退出登录 | 删文件 | 只删那一行 |

**两者不互相写。** 号池从不改 `token.json`，`LoginFlow` 也不改 `accounts.json`（除了 `poolAddMode` 那条路径）。

---

## 2. 身份解析：`selectPoolAccount()` / `peekPoolAccount()` / `resolvePoolAccount()`（按 `host/index.ts` 实现回填）

设计稿里叫 `resolvePoolToken()`，实现里拆成了**三个**方法 —— 因为它返回的是整个账号对象（要 `deviceId`，不只是 token），而且**读路径与写路径必须分开**：

| 方法 | 谁调 | 有副作用吗 |
| --- | --- | --- |
| `selectPoolAccount()` | 另外两个 | **无**。纯函数：只读 `settings` / `accounts` / `poolQuota` / `poolActiveId`，算完就返回 |
| `peekPoolAccount()` | `poolSnapshot()`（→ `status` 端点 / 诊断第 14 行 / 设置卡）、`displayToken()` | **无**。就是 `selectPoolAccount()` 的别名，存在的意义是让调用点一眼看出"这是只读的" |
| `resolvePoolAccount()` | `activeToken()` / `activeDeviceId()` / `recordMeasure()` / `sessionIdForPublish()` / `syncPublisher()` | **有**：会把 `poolActiveId` 粘住，并在换号时打一条 `pool/pick` |

拆开的理由：`status` 端点每 20 秒被前端轮询一次，它要展示"当前用的是哪个号"。早期版本 `poolSnapshot()` 直接调会写状态的版本，等于把"看一眼"变成了可能改写运行时状态的操作。现在 `snapshot()` 这条路是纯的，写状态只发生在真正要发请求的路径上。

```ts
/** 纯函数：算出该用谁。不改任何字段、不打日志。 */
private selectPoolAccount(): PoolAccount | undefined {
  if (!settings.get().poolEnabled) return undefined;              // 老路径接管
  const enabled = this.accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return undefined;                     // 空池退回老路径

  const now = this.now();

  // ① 先试"粘住"上一个活跃成员
  const pinned = this.poolActiveId === undefined ? undefined : enabled.find((a) => a.id === this.poolActiveId);
  if (pinned !== undefined && !isCooling(pinned, now)) return pinned;

  // ② 否则重新排序
  const ordered = sortForUse(enabled, this.poolQuota, now);
  const pick = ordered[0];
  if (pick === undefined || isCooling(pick, now)) return undefined;
  return pick;
}

/** 只读地看"现在该用谁"。展示路径走这条。 */
private peekPoolAccount(): PoolAccount | undefined {
  return this.selectPoolAccount();
}

/** 把"现在该用谁"定下来：粘住 + 记一次日志。发请求的路径走这条。 */
private resolvePoolAccount(): PoolAccount | undefined {
  const pick = this.selectPoolAccount();
  if (pick === undefined) {
    this.poolActiveId = undefined;
    return undefined;
  }
  if (this.poolActiveId !== pick.id) {
    this.poolActiveId = pick.id;
    logger.info("pool/pick", { id: pick.id.slice(0, 8), candidates: /* enabled 数 */ });
  }
  return pick;
}
```

两条路径用同一个纯函数，所以"界面显示的当前号"与"真正在发请求的号"永远一致 —— 这不是靠两处代码写得像，是靠只有一个实现。

`scripts/smoke-pool.mjs` 第 6.5 段是这条分层的回归护栏：连查五次 `status`，断言报的当前号一致、且 `pool/pick` **至多 1 条**（池刚打开、`poolActiveId` 还是 undefined 时第一次轮询会选一次号，之后必须粘住）。它不声称旧实现"可观测地坏了"（粘住逻辑让旧实现重复轮询也只打一条），只保证这条分层不被改回去。

**为什么要"粘住"（①），不能每次请求都重新排序。** `sortForUse()` 的输入含余额读数，而余额读数会在一轮对话**中途**被 `loadQuota()` 刷新。不粘住就会出现：第 1 帧用 A 号、第 5 帧余额刷新后 A 掉到第二 → 换 B 号 → **会话 id 与设备身份一起变**，上游看到的是"一个人在两台设备上接力说完一句话"。粘住只在"当前号进入冷却"时才让位。

**注意：全部都在冷却时返回 `undefined`。** 设计稿里写过"pick 仍然是最早解锁的那个，请求会失败并再次记测量 —— 用户该看到失败"。实现改成返回 `undefined`，理由是：返回一个确定在冷却的号会让 `syncPublisher()` 把名册指纹绑到它身上，反而在它解锁后不触发重建。返回 `undefined` 时 `Publisher` 退回老路径（`this.token`），用户仍然能对话 —— **这是更符合直觉的行为**：号池不可用时不该让整个插件不可用。

### 2.1 `sortForUse()` —— 五条规则

```ts
export function sortForUse(
  accounts: readonly PoolAccount[],
  quota: ReadonlyMap<string, PoolQuota>,
  now: number,
): PoolAccount[]
```

比较器（**顺序即优先级，前一层不同就不看后一层**）：

```
① 冷却：未在冷却（until ?? 0 <= now）的排前面；
        都在冷却 → 按 until 升序（最早解锁的先试）
② daily 降序：quota.daily ?? -1（未知当最小）
③ available 降序：quota.available ?? -1

④ expiresAt 降序：undefined 当 0（没有过期时间的排最后）
⑤ id 升序
```

②③ 只在 `quota` 读数 `now - at <= 10 * 60_000` 时参与；过期读数当"未知"。

**② 在 ③ 之前是刻意的**，理由见 ADR-0010 §5（workbuddy issue #70：日更积分不先花就作废）。

### 2.2 记录测量 `recordMeasure()`

```ts
private recordMeasure(status: number, bodyText?: string): void
```

**签名与设计稿不同**：设计稿写的是 `recordMeasure(accountId, status, bodyText)`，实现里没有 `accountId` —— 唯一的调用点是 `Publisher.sync()` 传进来的 `PublishAccountResolver.onResponse = (status) => this.recordMeasure(status)`，那一刻"在用哪个号"由 `resolvePoolAccount()` 自己算得出来（粘住逻辑也在同一个类里）。多传一个 `accountId` 只会多一处可能传错的地方。

调用点：`createRaccoonApi()` 的 `onResponse` 钩子 → `Publisher.sync()` 的 `PublishAccountResolver.onResponse` → `host.recordMeasure(status)`。**每发一轮对话都会执行一次。**

| 条件 | state | until |
| --- | --- | --- |
| `status === 200` | `ok` | 清空 |
| `status === 429` 或 body 含 `200429` | `limited` | 上游 `Retry-After` / body 里的重置时间；否则 `now + 30min` |
| `status === 402` 或 body 含余额不足关键词 | `empty` | 次日 `00:00 Asia/Shanghai` |
| `status === 401 \|\| 403` 或 body 含 `200001` / `200003` | `dead` | `MAX_SAFE_INTEGER` |
| `status >= 500` | `flaky` | `now + 30min` |
| 其它（含 400） | **不记** | — |

**400 不记**：请求本身不合法，与账号无关。记了会把好号一个个标成坏的（workbuddy 的教训）。

`onResponse` 只拿到 `{ status, headers }`，**拿不到 body**。所以 body 关键词判定只能在 `chatStream()` 抛出的 `RaccoonError` 路径上做 —— 见下一条。

#### 2.2.1 连续成功不重复落盘 `shouldPersistMeasure()`

`recordMeasure()` 每轮对话都跑，而 `writePool()` 是**整表原子写**（`accounts.json` 里是明文 token）。不拦的话等于每说一句话就把所有账号的 token 往磁盘刷一次，日志也会被 `pool/measure ok` 刷满。规则抽成 `src/host/pool.ts` 的纯函数：

```ts
export function shouldPersistMeasure(previous: PoolMeasure | undefined, next: PoolMeasure): boolean {
  if (next.state !== "ok") return true;
  return previous?.state !== "ok";
}
```

| 从 | 到 | 写盘？ | 为什么 |
| --- | --- | --- | --- |
| 无 | `ok` | ✅ | 首次确认可用，要留痕 |
| `ok` | `ok` | ❌ | **唯一被拦掉的情况** |
| `limited` / `empty` / `dead` / `flaky` | `ok` | ✅ | 解除冷却的唯一记录，丢了号会白躺 |
| 任何 | 非 `ok` | ✅ | 冷却必须立刻落盘，否则重启后又会被选中 |

只比 `state` 不比整个 `measure`：`at` 每次都变，拿它比较等于没比较。单测 PO-36 ~ PO-40 覆盖这五行。

**注意"不写盘"不等于"不做别的事"**：`measure.state !== "ok"` 时仍然 `poolActiveId = undefined` + `syncPublisher()` —— 换号必须发生，被拦掉的只是重复的磁盘写。

### 2.3 失败分类：只有一条通路，`classifyMeasure()` 一个实现

**设计稿写的是两条通路**（`onResponse` 看状态码 + `stream` 抛错时看 `RaccoonError.kind`），**实现里只有一条**：`onResponse` 拿 `{ status, headers }` → `recordMeasure(status)` → `classifyMeasure({ status, now })`。

为什么砍掉第二条：

- `assembleAdapter()` 里**没有** try/catch 包 `stream()`。pi-ai 从不中途抛（`openai-completions.js:479-518` 一律把错误变成 `error` 事件），真正抛 `LlmError` 的是 `dsh-llm-pi-ai` 的 `toStreamChunks()`，那已经在 `createProvider()` 内部，我们插不进手。
- 想在 `adapter.ts` 里 catch，就得把 `stream()` 包一层，而 `Api.stream` **必须同步返回 `AssistantMessageEventStream`**（ADR-0007 的硬约束，`src/provider/api.ts` 的注释专门写了这条）—— 包成 `async` 会直接坏掉整条流。
- 而 `kind` 本来就能从状态码推：`AUTH` ↔ 401/403、`RATE_LIMIT` ↔ 429/200429、`SERVER` ↔ 5xx。`classifyMeasure()` 里 `kind` 参数仍然保留（`src/host/pool.ts` 的 `MeasureInput.kind?` 优先于 status），但**当前没有调用点传它** —— 留着是为了 `pool-test` 那种"手上只有 `RaccoonError`"的场景。

代价照实写：**流中途断开不记测量**。这本来就是刻意的（ADR-0010 的决定）—— 字节已经发给客户端了，这时换号重放会让用户看到两段拼接的回答。

---

## 3. 设备身份注入

### 3.1 生成

```ts
export function newDeviceId(): string {
  return `raccoon-${randomBytes(16).toString("hex")}`;   // "raccoon-" + 32 hex = 40 字符
}
```

加入池时生成一次，之后不变。

### 3.2 注入点

`src/provider/roster.ts` 的 `toDescriptor()` 已经往 `model.headers` 写 `chatModelHeaders(sessionId)`。加一个参数：

```ts
export interface RosterOptions {
  contextCap?: number;
  visionProbe?: ReadonlyMap<string, boolean>;
  sessionIdFor?: (modelId: string) => string;
  /** 号池当前账号的设备身份。不传则不发这个头（老路径）。 */
  deviceId?: string;
}
```

`headers` 变成：

```ts
const headers = sessionId === undefined ? {} : chatModelHeaders(sessionId);
if (deviceId !== undefined) headers["x-client-device-id"] = deviceId;
```

**为什么用 `model.headers` 而不是 `profile.headers`。** `createClient()` 把 `model.headers` 展开进 `defaultHeaders`（`openai-completions.js:539`），而 `PiAiAdapter` 的 `requestHeaders(profile.headers, ...)` 会**剔除同名冲突**（`lib/index.js:1817-1824`）。走 `model.headers` 不会被剔除，且能随名册签名变化。

### 3.3 换号 = 换名册 = 换实例

`Publisher.sync()` 的签名是 `rosterSignature(models) + "|" + reasoningEnabled`。`rosterSignature` 已经包含每个模型的 `id / vision / contextWindow / maxTokens`，但**不含 headers**。

所以换号必须让签名变化，否则 `sync()` 会认为"名册没变"直接返回，device id 换不掉。

**改法**（实现与设计略有出入，以实现为准）：`rosterSignature()` 本身**保持单参不变**，把设备身份拼在 `Publisher.sync()` 的指纹里：

```ts
// host/publish.ts
const signature = `${rosterSignature(input.models)}|${input.reasoningEnabled ? 1 : 0}|dev:${input.deviceId ?? "-"}`;
```

理由：`rosterSignature()` 只有一个职责（把模型列表压成一个串），加可选参会让调用点以为"不传就等于没变"。指纹的组成属于 `Publisher` 的判断，放在 `sync()` 里更直白。

这样换号必然触发"先释放再注册"。

---

## 4. 签到

### 4.1 `protocol/points.ts` 新增

```ts
export interface GrantResult {
  /** 上游说这次真的发了。 */
  granted: boolean;
  /** 上游原文，诊断用。 */
  raw: Record<string, unknown>;
}

export async function grantDaily(token: string, fetchImpl: typeof fetch = fetch): Promise<GrantResult>
```

实现要点：

- `POST ${WEB_BASE}/desktop/v1/login/points/grant`，**无 body**，headers = `webHeaders(token)`。
- 判 `data.granted`；`code !== 0` 且非 `granted:false` → `RaccoonError`。
- 超时用 `POINTS_TIMEOUT_MS`（10s）。
- 401/403/`200001`/`200003` → `AUTH`；`200429` → `RATE_LIMIT`。

同时**改掉文件头那段"只读"注释**，改成"读 + 一个写操作（每日领取），且这个写操作是幂等的"。

### 4.2 `action=pool-checkin`

```
POST /plugins/dsh-raccoon-web/action?action=pool-checkin
→ {
    ok: true,
    pool: { … },
    results: [
      { id, result: "already" | "granted" | "error", message? },
      ...
    ]
  }
```

**实现与设计稿的差异**：设计稿写的是 `rows` 且带 `label` / `principal` / `before` / `after`。
实现里叫 `results`、只带 `{ id, result, message? }` —— `id` 已经能定位账号（前端有完整 `pool.accounts`），
`before` / `after` 两个数字要额外打两次 `balance`，而签到之后本来就会统一刷新一次余额读数，
再多打一轮纯属浪费。**这是有意的减法，不是漏做。**

`result` 三值：

| 值 | 条件 | UI 文案（zh） |
| --- | --- | --- |
| `already` | `todayGranted(bills)` 命中，或 `grantDaily` 返回 `granted:false` | 今日已签 |
| `granted` | `grantDaily` 返回 `granted:true` | 已签到 |
| `error` | 抛错 | 签到失败 · 上游原文第一行 |

**顺序**：先 `fetchBills` 判今日是否已领；已领直接标 `already`，**不发写请求**。再 `grantDaily`。
领到之后顺手 `fetchBalance` 刷新这个号的 `poolQuota`（下次选号排序用）。

**单个失败不中断。** 用 `for...of` + 每行 try/catch，不用 `Promise.all`（并发打 5 个号会更容易触发风控）。

**失败要记测量状态。** 设计稿只把失败塞进 `results`，实现里额外走
`classifyMeasure()` + `shouldPersistMeasure()`（`ACCOUNT_KINDS` 把 `RaccoonErrorKind` 映射到
`MeasureInput.kind`，`INVALID_REQUEST` / `ABORTED` 不映射）：`AUTH` → `dead`、限流 → `limited`、
超时/网络 → `flaky`、余额不足 → `empty`，HTTP 400 之类与账号无关的仍然不记。
理由：签到是**用户主动**发起的、每天一次的动作，它拿到的失败信号比对话中途的 `onResponse`
更可信 —— 凭据真的废了就该在卡片上显示「凭据失效」，而不是继续被选去服务。
写盘走 `savePool()`（合并后整表写），失败不影响结果展示。

**与 `poolEnabled` 无关。** 关着也能签。

---

## 5. HTTP 动作清单（按 `runAction()` 实现回填）

新增八个 action（全部 POST + loopback，走既有 `routes.ts` 的检查）：

| action | body | 作用 |
| --- | --- | --- |
| `pool-add-start` | — | 扫码加号（备用路线）：`loginFlow.start("pool")`；池模式**不写 `token.json`、不改主登录相位** |
| `pool-add-browser` | — | **浏览器 loopback 加号（主路线，ADR-0012）**：本机起一次性回调服务，返回 `browser.url` / `port`，后台等回调 |
| `pool-add-browser-cancel` | — | 收掉在途的 loopback 服务（用户点了「取消等待」） |
| `pool-import-desktop` | — | 把 `readDesktopAuth()` 读到的凭据加进池（只读，不复制文件） |
| `pool-toggle` | `{ id, enabled }` | 勾选/取消勾选；写盘失败**回滚内存** |
| `pool-remove` | `{ id }` | 删一行，同时 `poolQuota.delete(id)` |
| `pool-checkin` | — | 一键签到，遍历**全部**账号（含未启用） |
| `pool-test` | `{ id }` | 打一次 `model_catalog` 验证凭据，写回 measure |

**为什么加号有两条路，且 loopback 是主路线。** 2026-11-12 实测 `GET /login/mp?code=...` 对任何 UA 都返回 404（E-040），Web auth 扫码链路在服务端侧已经断了 —— 用户微信扫完点确认，手机上看到的是「二维码已过期或已被使用」，而 `login_with_qrcode_code` 对任何 body 都恒回 `pending`，我们**没有任何信号**能分辨"码有效但没人扫"与"码根本不存在"。官方桌面端自己换账号也不用扫码：它打开浏览器到 `/authorize`，用户在浏览器里正常登录，完成后重定向到客户端在本机起的一次性回调服务。那条路的两个端点都实测可用（`/authorize` → 200；`login_with_authorization_code` 对假 code → `400 code=200035`，真的在校验）。详见 ADR-0012 与 `protocol/loopback.ts` 的文件头。

**扫码那条不删。** IAM 小程序码（`qrProtocol: "iam"`）走的是另一套命名空间（`POST /api/iam/v1/auth/mp/qrcode`），未受 `/login/mp` 下线影响；而且 `/authorize` 与 `/login/mp` 是同一家公司同一批代码，没有理由认为它不会同样被下线。

**`pool-checkin` 不接收 `ids`。** 设计稿里写过 `{ ids? }`，实现时去掉了：签到是"把所有的账号都一键签到了"（用户原话），传部分 id 只会让 UI 多一层选择，而且失败也要逐个回报。

**为什么 `pool-test` 不是"发一次真对话"。** workbuddy 用真实体积探测（~25k 输入 token）来验证号能不能用。我们这里更保守：`model_catalog` 已经能区分 200 / 401 / 429，而"能不能对话"取决于模型而不是账号。探测成本从 25k token 降到 0 token。

**`pool-test` 请求不带该账号自己的 `x-client-device-id`**（`fetchCatalog(token, fetchImpl, { deviceId })` 里我们**传了**账号的 deviceId —— 见 `host/index.ts` 的 `actionPoolTest`）。测的就是"这个号 + 这台设备的身份"能不能过鉴权，与真实对话路径一致。

**`pool-test` 是唯一能让 `dead` 回池的路径。** 凭据被拒/账号被停权只能人工重测；限流与额度用尽是等冷却到期自动回池。

---

## 6. 快照形状（按 `src/host/status.ts` 实现回填）

```ts
export interface StatusPoolAccount {
  id: string;                 // sha256(principal).slice(0,16)
  label?: string;
  principal: string;          // 只给前 8 位
  expiresAt?: number;
  addedAt: number;
  enabled: boolean;
  device: string;             // 去掉 "raccoon-" 前缀后的前 8 位十六进制
  source: "qr" | "desktop";
  measure?: { state: PoolState; at: number; until?: number; note?: string };
  active: boolean;            // 当前是不是它在服务对话
}

export interface StatusPool {
  enabled: boolean;           // settings.poolEnabled
  ready: boolean;             // accounts.length > 0
  total: number;              // 池里账号总数（含未启用）
  enabledCount: number;       // 勾选了"启用"的数量
  activeId?: string;
  accounts: StatusPoolAccount[];
  note?: string;              // 只在 poolEnabled && 没有活跃账号时给
}
```

`StatusSnapshot.pool: StatusPool`，`settings` 加第八键 `poolEnabled: boolean`。

**`note` 的三句话**（`poolSnapshot()` 里按条件给，别的地方不给）：

- 池空 → `池是空的。先加一个账号。`
- 有账号但 0 个启用 → `有账号但一个都没勾选启用，所以还是用当前账号。`
- 启用的都在冷却或凭据已失效 → `启用的账号都在冷却或凭据已失效，暂时退回当前账号。`

三句都是**陈述当前状态**，不带操作指令 —— 按钮就在下面，不需要文字再指挥一遍。

**诊断块从 13 行变 14 行**，第 14 行由 `status.ts` 的 `poolLine()` 生成，五种形态：

| 开关 | 池状态 | 文案 |
| --- | --- | --- |
| 关 | 池空 | `关（池空）` |
| 关 | 有账号 | `关（N 个账号，未启用自动换号）` |
| 开 | 池空 | `开（池空）` |
| 开 | 0 个启用 | `开（N 个账号，0 个启用）` |
| 开 | 有启用 | `开（N 个启用，当前 xxxxxxxx）` |

`test/host.test.ts` 断言 `text.split("\n").length === 14`，ST-25 / ST-25b / ST-25c 三例分别覆盖三种有代表性的形态。

**`device` 只给 8 位十六进制，且去掉 `raccoon-` 前缀。** 完整 device id 是上游的"安装实例标识"，完整暴露等于把它写进 devtools；前 8 位足够用户区分"这两个号不是同一个设备"。

> **踩过的坑**：第一版写的是 `account.deviceId.slice(0, 8)`，而 `deviceId` 是 `raccoon-<32hex>` —— 前 8 个字符正好是 `raccoon-`，界面上显示 `设备 raccoon-`，看起来像"设备标识是空的"。真宿主实测才发现（2026-11-11）。

---

## 7. UI（按 `client.js` 的 `PoolSection` 实现回填）

### 7.1 位置

`PluginPage` 里插在 `ModelsSection` 与 `SettingsSection` 之间。三个入口（设置对话框左侧菜单 / 插件面板包详情 / 输入框药丸）都能到它 —— 因为它就是同一张 `PluginPage`。

### 7.2 线框

```
账号池                                       3 个账号 · 2 个启用
每个账号有独立的设备标识，互不干扰。成员要显式勾选才会被拿去发请求。

  自动换号                                          [ ●—— ]
  打开后，一个账号额度用完或撞到限流就自动切到下一个。
  关掉只停止自动换号 —— 签到与测试仍然可用。

  ☑ 7b86c892   pu-01a19   [当前使用]              可用
     设备 c9012c1d · 凭据 2026-12-04 到期              [测试] [移除]
  ☐ 3f0a91cc   pu-02b3…                          限流中
     设备 91aa02f1 · 冷却到 21:10                      [测试] [移除]

  [浏览器登录]  [扫码添加]  [导入客户端账号]  [一键签到]
  新加进来的账号默认不启用，勾上才会被拿去发请求。

  ┌──────────────────────────────────────────────┐
  │ 正在等待浏览器完成登录（最多 5 分钟）。          │
  │ 在浏览器里用手机号或微信登录，完成后浏览器会跳回本机。 │
  │ [打开授权页]  [取消等待]                        │
  └──────────────────────────────────────────────┘
```

### 7.3 交互契约

- **勾选是即时的**，不设"保存"按钮。每次勾选打一次 `pool-toggle`，`act()` 无论成败都 `load()` 拉新快照 —— 快照是唯一真相，失败时界面自然回滚。
- **`一键签到` 在 `poolEnabled === false` 时仍然可点。** 禁用条件只有"没有任何账号"。
- **`移除` 二次确认不用 `window.confirm`** —— 某些宿主会拦原生对话框，拦了按钮就彻底没反应。改成**行内两段式**：点"移除"→ 按钮变"确认移除"。
- **二维码跟宿主状态走，不用点击那一刻的快照**：`pendingQr` 只在 `login.phase` 是 `pending`/`logging` 时渲染，相位一变自动收起。不复用主登录段的相位，因为那是"当前账号"的入口。
- **必须用 `login.mode === 'pool'` 认领二维码。** 两个扫码入口（登录区 / 池区）共用一个 `LoginFlow`，`start(mode)` 会先 `cancel()` 再取码 —— 只判 `phase === 'pending'` 会让池区把主登录的码当成自己的显示出来，用户扫完 token 写进 `token.json` 而池里没多号。`mode` 由 `LoginSnapshot.mode` → `loginBlock()` → `StatusLogin.mode` 一路透传，`cancel()` / `markReady()` / `markDead()` / `complete()` 的池分支都把它收回 `"primary"`。反过来登录区在 `mode === 'pool'` 时不显示二维码，改显示 `loginPoolBusy`（"二维码在下面的「账号池」区域"）。详见 `04-ui-surfaces.md` §6.6。
- **当前使用**标记来自 `pool.activeId`，**不是**用户手动选的。
- **浏览器登录的状态从 `status.browser` 读，不在界面里自己记。** 用户可能在浏览器里花一两分钟（输手机号、收验证码），期间会切走设置卡再切回来；自己记的 `pending` 就丢了。宿主那一份 `Host.browserLogin` 才是真相，界面只是投影。`browser.active === false` 且 `browser.message` 有值时，把那句话显示出来（成功 / 超时 / `authorization_code_not_found_error` 都在里面）。
- **同一时刻只允许一轮 loopback。** `pool-add-browser` 会先 `closeBrowserLogin("已重新发起浏览器登录。")` 再起新的 —— 两个回调服务同时等，用户不知道哪个页面在等，而结果都写进同一个池。

### 7.4 文案键（zh / en 各 35 个，实测 `grep` 计数）

`poolTitle` / `poolHint` / `poolEnabledLabel` / `poolEnabledHint` / `poolEmpty` / `poolCount` / `poolAddQr` / `poolAddDesktop` / `poolAddHint` / `poolImportOk` / `poolCheckin` / `poolCheckinBusy` / `poolCheckinAlready` / `poolCheckinGranted` / `poolCheckinFailed` / `poolTest` / `poolTesting` / `poolRemove` / `poolRemoveConfirm` / `poolActive` / `poolDevice` / `poolExpires` / `poolCoolUntil` / `poolStateUnknown` / `poolStateOk` / `poolStateLimited` / `poolStateEmpty` / `poolStateDead` / `poolStateFlaky` / `poolAddBrowser` / `poolAddBrowserBusy` / `poolBrowserHint` / `poolBrowserWaiting` / `poolBrowserOpen` / `poolBrowserCancel`

（比设计稿的 18 个多，因为签到结果要分三态、账号状态要分六态、还要两段式删除的"取消"，2026-11-12 又加了六条浏览器登录的（ADR-0012）。**设计稿里那四个 `poolError` / `poolNeedId` / `poolRemoved` / `poolToggled` 没有落地** —— 错误与结果直接显示宿主返回的 `error` / `message`，不再包一层自己的文案，少一层翻译就少一处对不上。同理 `poolBrowserExpired` 也删掉了：超时的文案由宿主 `browser.message` 给，界面只负责显示。）

---

## 8. 文件改动清单（实际落地）

| 文件 | 改动 |
| --- | --- |
| `src/protocol/consts.ts` | 六常量：`GRANT_PATH` / `POOL_FILE` / `POOL_COOL_LIMITED_MS` / `POOL_COOL_FLAKY_MS` / `POOL_QUOTA_FRESH_MS` / `POOL_DEVICE_PREFIX` |
| `src/protocol/headers.ts` | `webHeaders()` / `chatModelHeaders()` 加可选第三参 `deviceId` |
| `src/protocol/points.ts` | 新增 `grantDaily()` / `GrantResult`；文件头从"只读"改成"读为主 + 一个写操作" |
| `src/protocol/catalog.ts` | `CatalogOptions.deviceId`；`fetchCatalog` 透传 |
| `src/host/pool.ts` | **新文件**（约 330 行）。`PoolAccount` / `PoolMeasure` / `PoolQuota` / `PoolDocument`、`readPool()` / `writePool()` / `upsertAccount()` / `isCooling()` / `sortForUse()` / `classifyMeasure()` / `newDeviceId()` / `poolAccountId()` / `nextRaccoonMidnight()` / `todayKey()` / `poolSummary()` |
| `src/host/store.ts` | `writeJson()` / `readJson()` 导出（让 pool 复用同一套原子写）；`readToken()` 补 `source` 回填（真 bug） |
| `src/host/settings.ts` | 第八键 `poolEnabled`（默认 `false`）+ 归一化 |
| `src/host/login-flow.ts` | `LoginMode = "primary" \| "pool"`；`start(mode)`；`onReady(token, mode)`；池模式不写 `token.json` |
| `src/host/publish.ts` | `PublishInput.deviceId?`；`PublishAccountResolver`；`sync()` 第三参；指纹加 `dev:<deviceId>` |
| `src/host/status.ts` | `StatusPool` / `StatusPoolAccount` / `poolLine()`；诊断第 14 行 |
| `src/host/index.ts` | 三个私有字段 + 八个 action + `addPoolAccount()` / `resolvePoolAccount()` / `activeToken()` / `activeDeviceId()` / `recordMeasure()` / `poolSnapshot()`；`syncPublisher()` 重写成每次重建名册；`sessionIdForPublish()` 按池成员取 principal |
| `src/provider/roster.ts` | `RosterOptions.deviceId`；`toDescriptor()` 注入 `x-client-device-id` |
| `src/provider/api.ts` | `LooseOptions.onResponse`；`createRaccoonApi(effortOf, onStatus)` |
| `src/provider/adapter.ts` | `AdapterOptions.resolveAccount?` / `onResponse?`；`resolveKey()` 统一取 key |
| `client.js` | `PoolSection`（约 200 行）+ 35×2 个文案键 + `loginPoolBusy` + `loginLastPoll`；`CreditPillGate` 改成总是显示；浏览器登录块（`data-raccoon-browser`） |
| `src/protocol/loopback.ts` | **新文件**（405 行，ADR-0012）。`authorizeUrl()` / `newState()` / `parseCallback()` / `startLoopback()` / `exchangeCode()` + 结果页 |
| `test/loopback.test.ts` | **新文件**（LB-1 ~ LB-35）。`authorizeUrl` 参数顺序 / `newState` 形状 / `parseCallback` 的 14 条拒收 reason / `exchangeCode` 六种分支 / `startLoopback` 真起服务打自己回调（一次性、403、400、502、超时、abort、只绑 127.0.0.1） |
| `test/host.test.ts` | ST-4 键集合加 `poolEnabled`；ST-25 改 14 行；新增 ST-25b / ST-25c / ST-18b / ST-18c / ST-28 / ST-29 / ST-30 |
| `test/pool.test.ts` | **新文件**（PO-1 ~ PO-43）。纯函数 12 个 suite：id 派生 / 设备身份 / 五条排序 / 冷却 / 分类 / 北京零点 / 摘要 / upsert / **`shouldPersistMeasure` 去抖** / **`mergePools`** / 落盘往返 |
| `scripts/smoke-client-apply.mjs` | **新脚本**。`node:vm` 离线跑 `apply`，`--twice` 复现重复加载 |
| `scripts/smoke-pool.mjs` | **新脚本**。真 `RaccoonHost` + 假网关跑十三个 action（**13 段 82 条断言**），不碰网络、不碰真实 `~/.dsh` |
| `scripts/revive.mjs` | patch 被手工删掉后的重建路径（靠 `link.mjs` 补回 insert） |

**设计稿里写过、后来补上的两项**：`test/pool.test.ts` 与 `scripts/smoke-pool.mjs`。补的时候发现两件事，都值得记下来：

- **`smoke-pool.mjs` 的假 settings 必须用真的 `normalizeSettings` 做 schema。** 第一版写的是 `(raw) => raw`，结果 `enabled` / `reasoning` / `authSource` 全是 `undefined`，`Publisher.sync()` 第一道门控直接判 `disabled` —— 于是"换号重建名册"这条断言全挂，看着像号池的 bug，其实是夹具的 bug。
- **池里账号的 `id` 不是随手编的字符串。** 它是 `sha256(principal).slice(0,16)`，所以夹具里写 `"aaaaaaaaaaaaaaaa"` 而 principal 是 `"pu-account-a"` 时，`upsertAccount()` 算出来的 id 对不上，`pool-import-desktop` 就变成"追加第 4 个号"而不是"更新已有条目"。夹具必须用真 id（`pu-account-a` → `6e415868f0d0100a`、`pu-account-b` → `e19de1ab797f0b40`、`pu-account-dead` → `67ca1dec16c583c5`）。

---

## 9. 冒烟与验证（实际跑过的）

1. `node node_modules/typescript/bin/tsc --noEmit -p packages/dsh-raccoon-web` → exit 0。
2. `node --test --experimental-strip-types --import ./scripts/test-resolve-register.mjs packages/dsh-raccoon-web/test/*.test.ts` → **263 tests / 52 suites / 263 pass / 0 fail**（其中 `pool.test.ts` 43 条、`chat.test.ts` 51 条、`loopback.test.ts` 35 条、`host.test.ts` 36 条）。
3. `node scripts/smoke-client-apply.mjs` → 3 个 slot；`--twice` 也 3 个，只出一条 `locale registration skipped`。
4. `node scripts/smoke-host.mjs` → ✓ 冒烟全绿；`node scripts/smoke-provider.mjs` → ✓ provider 冒烟全绿。
5. `node scripts/smoke-pool.mjs` → **41 条断言全绿**（10 段）。它验的六件事：
   - `bootstrap()` 读进 3 个账号、`enabledCount: 0`、`note` 给出"有账号但一个都没勾选"、诊断 14 行、`device` 只有 8 位、诊断里没有 `eyJ`。
   - `pool-import-desktop` 对同 principal **不追加第二条**（`total` 仍是 3）。
   - `pool-test` 打的是 `/model_catalog`，且请求头带该账号自己的 `x-client-device-id`（`raccoon-bbbb…`）；401 的号被记成 `dead` 且 `until === 9007199254740991`。
   - 勾选 B → `activeId` 变 B、`publish` 仍 `published`、**触发一次重新注册**（`2 → 3`）、旧 registration 已释放、`handle.replace` 零调用。
   - 再勾选 A → B 的 `daily` 更高（500 vs 100）所以**仍用 B**（第二层排序真的生效，不来回跳）；关掉 B → 退回 A。
   - `pool-checkin` 三行结果（含未启用的号）、A 是 `already`、B 是 `granted`、**写请求只打到 B 与 dead 号，没打到 A**；`accounts.json` 落盘 3 条、`token.json` 没被池模式写过、`status` 里既没有 token 原文也没有 deviceId 全文。
6. 真宿主（端口 52091，build `2026-11-12T01:20`）：
   - `action=pool-import-desktop` → `total:1`、`enabled:false`、`device:"c9012c1d"`（修完 `raccoon-` bug 之后）
   - `action=pool-test` → `healthy:true`、`measure:{state:"ok",note:"正常"}`
   - `action=pool-toggle {enabled:true}` → `enabledCount:1`
   - `set-setting {key:"poolEnabled",value:true}` → `activeId` 非空、`accounts[0].active:true`、`publish:"published"`
   - 诊断末行 → `号池: 开（1 个启用，当前 7b86c892）`
   - **`action=pool-add-browser`**（ADR-0012）→ `browser.active:true`、`browser.url` = `https://xiaohuanxiong.com/authorize?login_source=desktop&appname=…&desktop_callback=loopback&redirect=http%3A%2F%2F127.0.0.1%3A64023%2Fauth%2Fcallback&state=<64hex>`、`browser.port:64023`
   - 回调服务的三条护栏实测：错 state → **400**、错路径 → **400**、合法 state + 假 code → **502** 且 `status.browser.message = "authorization_code_not_found_error"`（真的打到了 `login_with_authorization_code`）

`scripts/smoke-pool.mjs` 现在是 **13 段 82 条断言**（2026-11-12 终值），其中第 6.5 段与第 6.6 段是两条**回归护栏**，写法上有讲究：

- **6.5 只读路径稳定**：连查五次 `status`，报的当前号必须一致，且 `pool/pick` 至多 1 条。造出"第一次选号"的办法是"先用 host action 关池（会清 `poolActiveId`）→ 再绕过 action 直接 `settings.update({poolEnabled:true})` 打开"，否则断言恒真。
- **6.6 池成员凭据坏了不能判死主登录**：靠一个 `killA` 开关让假网关对 A 回 401，而不是用池里那个 DEAD 号 —— DEAD 在第 3 段已被 `pool-test` 标成 `dead`、`until = MAX_SAFE_INTEGER`，`sortForUse()` 不会再选它，"池成员在服务但凭据坏了"这个状态根本造不出来。正反两面都测：池在服务时 `phase` 必须仍 `ready`；关掉池后桌面端凭据失效必须 `expired`，且文案是"打开官方客户端"而不是"重新扫码"。

- **签到失败影响选号**（2026-11-12 补）：假网关的 `/login/points/grant` 对 `DEAD` 回 401 后，
  断言 `DEAD` 那一行是 `error`、`accounts.json` 里它的 `measure.state` 变成 `dead`、
  且写盘没有抹掉别的号（合并后仍 3 条）。没有这条护栏时，"签到失败只进 `results` 不动 `measure`"
  这个缺口在冒烟里完全看不出来 —— 它会一路绿到用户面前。
- **9. 浏览器 loopback 加号**（2026-11-12 新增，ADR-0012）：真起本机服务 → 断言 URL 是 `/authorize` 且带 `desktop_callback=loopback`、`redirect` 指向 `127.0.0.1:<port>/auth/callback`、`state` 是 64 hex；错 state → **400** 且**一次都不打换码端点**；假 code → **502**、页面里有服务端文案、`browser` 收摊、**池没被污染**；合法 code → **200**、池里多一个 `source:"browser"` 的号、默认 `enabled:false`、有独立 8 位 `device`、`active:false`；取消与重复取消各一条。

**没跑过的四件**（写在这里免得下次以为验过）：

- `action=pool-checkin` 打真实网关的"真的领到"分支（当日已领，只验到 `granted:false`）。`smoke-pool.mjs` 里的 `granted:true` 是假网关给的，不算实测。
- **`action=pool-add-browser` 的"真的登进去"分支** —— 需要用户在浏览器里真的登录一次。验过的是：起服务、URL 形状、三条拒收判据、假 code 走完 `login_with_authorization_code` 拿到 `200035`。**"用户登录成功后回调带回真 code、换到真 token、进池"这一段没有人跑过。**
- `action=pool-add-start` 的扫码加号（要用户手机；而且 `/login/mp` 已 404，这条路只在 `qrProtocol: "iam"` 下才有意义）。
- `action=pool-remove` 在真宿主上（`smoke-pool.mjs` 里跑过，但那是假网关）。

---

## 10. 不做的事

1. **不做"并发打多个号"。** 一次对话只用一个账号。并发会在上游留下"同一 IP 同时用多个号"这个更强的关联信号。
2. **不做"号池里的号自动签到定时器"。** 签到是用户动作。定时器会在用户不知情时产生写请求。
3. **不做"按模型选号"。** 目录对所有账号返回同一份（E-038 实测），没有可依据的差异。
4. **不做"账号分组/标签体系"。** 一个 `label` 字段够用。
5. **不显示完整 device id、不显示 token、不显示 token 哈希。**
6. **不自动把桌面端凭据加入池。** 导入必须是用户点的那一下。
