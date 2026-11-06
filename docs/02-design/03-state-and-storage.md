# 状态与存储

最后更新: 2026-11-06（按实现回填）
状态: 已定稿

> 一句话：**我们自己扫码得来的 token 单独放；官方客户端的凭据只读进内存、不落盘；其余全进内存。**

---

## 1. 存储清单

| 数据 | 位置 | 格式 | 生命周期 | 敏感 |
| --- | --- | --- | --- | --- |
| 扫码得到的 access token | `$DSH_HOME/state/dsh-raccoon-web/token.json` | JSON | 跨重启，直到失效/登出 | 🔴 是 |
| 桌面端凭据 | **只在内存**（源文件 `~/.office-raccoon/agent/config/auth.json`） | JWT 字符串 | 仅本次进程 | 🔴 是 |
| 识图自检结果 | `$DSH_HOME/state/dsh-raccoon-web/vision-probe.json` | JSON | 跨重启 | 🟢 否 |
| 插件开关 | `settings-legacy.yaml` 的 `dsh-raccoon-web` ns | YAML | 跨重启 | 🟢 否 |
| 模型目录 | 进程内存 | — | 5 分钟 TTL | 🟢 否 |
| 积分 | 进程内存 | — | 60 秒 TTL | 🟢 否 |
| 二维码会话 | 进程内存 | — | 5 分钟（本地 deadline） | 🟡 短期 |
| 登录相位 | 进程内存（`LoginFlow`） | — | 进程生命周期 | 🟢 否 |

数据目录 = `$DSH_HOME/state/dsh-raccoon-web/`，其中 `$DSH_HOME` 缺省是 `~/.dsh`（`host/store.ts` 的 `dshHome()`）。

> **为什么目录名是包名而不是 `raccoon-web`**：设置页里显示的插件名就是 `dsh-raccoon-web`，用 `state/raccoon-web` 会让人以为这是谁的私有目录。provider id 与数据目录刻意分开命名（`PROVIDER_ID = "raccoon-web"`，`DATA_DIR = "raccoon-web"`，但 `dataDir()` 用的是包名）。

> **这条与早期设计不同**：原稿写的是 `<profileHome>/raccoon-web/`，实现时改成 `$DSH_HOME/state/dsh-raccoon-web/`，与 `dsh-connect-sensenova-token-plan` 的 `stateDir()` 位置一致。理由是 token 属于"用户级"而不是"profile 级"：用户换 profile 不该被迫重新扫码。

---

## 2. 两个凭据来源（关键设计）

`StoredToken.source` 区分来源，`"qr" | "desktop"`：

| 来源 | 落盘？ | 谁维护 | 退出登录怎么做 |
| --- | --- | --- | --- |
| `qr` | ✅ 写 `token.json` | 本插件 | 删文件 + 清缓存 |
| `desktop` | ❌ **只在内存** | 官方客户端 | 只能"本会话不再读它"（`desktopIgnored = true`），**绝不删客户端的文件** |

`authSource` 设置决定用哪个（`auto` / `desktop` / `qr`，见 [§4](#4-settings)）。`auto` 时先试桌面端，读不到或过期回落扫码。

**为什么桌面端 token 不落盘**：那是客户端在维护的东西。如果我们复制一份存起来，客户端换账号 / 退出登录后，插件里就留着一个旧 token，用户会看到"明明退出去了但插件还能用"——这个状态既难解释也难排查。直接每次启动重读，永远拿最新的。

细节与三条边界（只读 / 不上传 / 读不到就明说）见 [ADR-0008](adr/0008-desktop-credential-reuse.md)。

---

## 3. token.json

### 结构

```jsonc
{
  "schemaVersion": 1,
  "token": "<IAM JWT>",
  "kind": "access_token" | "xhx_token",   // 从哪条路拿到的
  "savedAt": 1793947200000,               // epoch ms
  "expiresAt": 1796362428000,             // 可选，来自 JWT exp × 1000
  "principal": "pu-01a19cd4-...",         // JWT sub，用于算 session id
  "account": "RaccoonElizabeth",          // 可选，昵称，仅展示
  "source": "qr"                          // 可选；旧文件没有这个键，当作 "qr"
}
```

`kind` 的意义：`iam/confirm` 能换到 `xhx_token` 就用它（更接近网页端），否则用 `access_token`。**记下来是为了排障** —— 两种 token 的行为可能有差异。Web auth 协议（`qrProtocol:"web"`）拿到的是 IAM JWT，官方客户端直接当 Bearer 用，所以走这条时 `kind` 恒为 `access_token`。

`principal` 从 JWT payload 解出来（base64url → JSON → `sub`），**不验签**：

```ts
// protocol/chat.ts
export function jwtClaims(token: string): Record<string, unknown> { ... }
export function principalOf(token: string): string {
  // JWT 的 sub / user_id / uid；都不是就退 h:<sha256(token).slice(0,12)>
}
```

非 JWT 时 principal 退成 `h:<sha256(token) 前 12 位>`。反正是内部用来算 session id 的，只要**同一账号同一模型**稳定即可。

### 写入

```ts
// host/store.ts
async function writeJson(file, value) {
  const dir = dirname(file);
  await ensureDir(dir);                     // mkdir 0700
  const temp = temporaryOf(dir, basename(file));
  try {
    await writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);               // 原子替换
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
```

**原子写**：先写 `.tmp` 再 rename。直接覆写的话，写到一半断电会留下半个 JSON，下次启动解析失败 → 用户莫名"登出"。

**临时文件名必须带随机后缀**：`temporaryOf()` 用 `${base}.${pid}.${Date.now()}.${sha256(pid:now:Math.random()).slice(0,8)}.tmp`。少了随机段，同一 tick 里的两次写会让第二次 `writeFile` 截断第一次还没 rename 的 temp。

**`mode: 0o600` 在 Windows 上被忽略。** 这是 Node 的行为，不是我们的 bug。文件权限由 `%USERPROFILE%` 的 ACL 决定（默认其他用户不可读）。

### 读取

```ts
async function readToken(): Promise<StoredToken | undefined> {
  // 三个"当没有"：文件不存在、JSON 坏了、schemaVersion !== 1
  // 另加两个字段校验：token 非空字符串、kind ∈ {access_token, xhx_token}
}
```

**读取永不抛。** 任何异常都返回 `undefined` → 走"未登录"路径。文件坏了不能让插件起不来。

### 过期判断

```ts
// host/index.ts 的 resolveToken()
const expired = auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= this.now();
```

留 60 秒余量。**但过期不等于失效** —— 服务端的 `expires_in` 和 JWT 的 `exp` 未必同步。所以：

- 本地判断过期 → 桌面端路线直接不用它（回落扫码）；扫码 token 仍**试着用**（catalog 探测）
- 服务端返回 `401` / `200003` → 清 catalog/quota 缓存 + `loginFlow.markDead()`，**但不删 token 文件**

这个区别很重要：**本地时钟不准是常态**，因为时钟偏差就删 token，用户会莫名其妙要重扫。

`DEAD_SESSION_CODES = new Set([200001, 200003])`（`protocol/errors.ts`）。实测：无 Authorization → `200001 authorization_empty_error`；假 Bearer → `200003 authorization_verify_error`。

---

## 4. vision-probe.json

```jsonc
[
  { "modelId": "sn-glm-5-3", "supported": false, "at": 1793947200000, "note": "网关丢图，模型回我看不到这张图片" },
  { "modelId": "sn-kimi-k3", "supported": true, "at": 1793947300000 }
]
```

数组，按 `modelId` 去重取最新（`readProbes()` 返回 `Map<string, VisionProbe>`，逐行跳过坏行）。

**为什么要持久化**：识图自检要真发一次请求（花钱），用户不会愿意每次都测。存下来，下次直接用。

UI 上标出"这个结论是什么时候测的"，并提供"重新测"（`probe-vision` action）。

`supported` 是**三态中的两态**：探测返回 `null`（既没说红也没说看不到）时**不写文件** —— 不把不确定的结论固化下来。descriptor 里 `const vision = probed?.supported ?? model.vision`。

---

## 5. settings

ns = `dsh-raccoon-web`（符合 `/^[a-z][a-z0-9-]*$/`）。**`schema` 是一个手写归一化函数**，不是 JSON Schema、也没用 `schemastery`：

```ts
// host/settings.ts
settings.register(SETTINGS_NS, normalizeSettings, { applies: "live" });
```

理由：`dsh-settings/lib/index.js:371-391` 把 `schema` 当**普通函数**调用（`plainConfig(schema(mergeLayers(base, user)))`）。参考插件用 `@deepseek-ai/schemastery` 的 `Schema.object({...})` 来造这个函数，但 schemastery 是宿主依赖、不在我们的 `dependencies` 里，引它等于把插件绑死在宿主内部的某个包上。30 行手写归一化就够。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就释放 adapter，模型选择器里消失 |
| `reasoning` | `true` | 关掉就不注入 `extra_body.thinking`（实测仍会有少量 reasoning 回吐，E-035） |
| `visionProbeOverride` | `false` | 开了才用 probe 结果改 descriptor |
| `contextCap` | `128000` | 上限。上游给 1M 的模型也按这个截，防止一次塞爆限流 |
| `debugLog` | `false` | 开 debug 级日志 |
| `authSource` | `"auto"` | `auto` / `desktop` / `qr`（ADR-0008） |
| `qrProtocol` | `"web"` | `web`（官方桌面端同款）/ `iam`（小程序码）（ADR-0009） |

归一化规则（`normalizeSettings`）：

- 未知键忽略；缺失键用默认值。
- 布尔：接受 `true/false`，以及 `"true"/"false"/"1"/"0"`。
- `contextCap`：区间 **8192 – 2 000 000**，越界回默认；非数字回默认。
- `authSource` / `qrProtocol`：`trim().toLowerCase()` 后命中白名单才用，否则回默认（所以 `"QR"` → `"qr"`、`"  Auto "` → `"auto"`、`"bogus"` / `42` → `"auto"`）。
- 不设 `options.validate` —— `register` 的 `validate` 抛错会让整个注册失败，而设置项填错不该让插件加载不起来。

**`contextCap` 是刻意的默认值。** 目录里 `sn-kimi-k3` 的 `params.context_window` 是 1 000 000，但真按 1M 塞上下文，一次请求就撞限流（限流按账号 token 吞吐算，不是按请求数）。128K 是能连续问几轮的量级。

> ⚠️ 128 000 这个数是从 `dsh-raccoon-connect` README 的限流描述推的，**没有精确定位到阈值**。登记为 P1，见 [06-open-questions](../01-research/06-open-questions.md)。

**token 不进 settings。** 理由：`settings-legacy.yaml` 是明文、可能被同步工具带走、用户会打开看。

---

## 6. 内存缓存

```ts
// host/cache.ts
createTtlCache<T>(ttlMs, load, now = Date.now)
  → { get(fresh?), peek(), clear() }
```

三个行为：

1. **命中不重复 load**；`get(true)` 强制重取。
2. **并发去重**：同时多个 `get()` 只发一次 `load()`。
3. **失败不进缓存**：`finally` 里清 inflight，错误照常抛给调用方。
4. `ttlMs <= 0` 表示永不命中。

**两个实例**：`catalogCache`（`CATALOG_TTL_MS = 5 * 60_000`）、`quotaCache`（`QUOTA_TTL_MS = 60_000`）。

`clear()` 在收到 401/200003、`refresh-auth`、`refresh-catalog --force` 时调。

---

## 7. 迁移

`schemaVersion` 只认 1。读到别的版本 → 当作不存在（返回 `undefined`），**不尝试解析**、**不尝试迁移**。

理由：这个文件里只有 token。丢了代价是"重新扫一次码 / 重新读一次客户端凭据"，30 秒的事。写迁移代码的收益远小于风险（迁移写错 → 静默用错 token → 更难查）。

未来如果真需要迁移，加一个 `migrations/` 目录 + 显式版本链，而不是在一个 `parseToken` 函数里塞 if。

---

## 8. 清理

| 触发 | 动作 |
| --- | --- |
| `logout` action（`qr` 来源） | 删 `token.json`，清 catalog/quota 缓存，`publisher.dispose("not-configured")` |
| `logout` action（`desktop` 来源） | **只设 `desktopIgnored = true`**，不删任何文件；UI 明说"要真正退出请到客户端里退出" |
| 401 / 200003 | 清缓存 + `loginFlow.markDead()`，**保留文件不删**（可能是临时的网关抖动），只把相位标成 `expired` |
| 插件卸载 | `host.dispose()` 只清内存、撤销路由、释放 registration，**不动磁盘** |
| 用户手动"清除所有数据" | 删整个 `state/dsh-raccoon-web/` 目录（目前没做 UI，只能手动） |

**卸载时不动磁盘**这条很重要。参考实现里有插件在卸载时清凭据，用户重装后发现要重新扫码，体验很差。

**桌面端凭据在任何路径下都不删。** 那是客户端的东西，删了等于把用户从小浣熊客户端里登出。

---

## 9. 文件权限与安全边界

| 事实 | 说明 |
| --- | --- |
| `token.json` 是明文 | 不上加密。加密要管密钥，密钥又要存 —— 只是把问题挪一层 |
| Windows 上 `0o600` 无效 | Node 在 Windows 忽略 mode。权限由 `%USERPROFILE%` 的 ACL 决定 |
| 不写注册表 | 不碰 `HKCU` / `HKLM` |
| 不写环境变量 | 不污染用户 shell |
| 不读浏览器 cookie | 见 [ADR-0001](adr/0001-login-via-web-qr.md)（这条仍然成立） |
| **读** `~/.office-raccoon/agent/config/auth.json` | ✅ **只读这一个文件**，见 [ADR-0008](adr/0008-desktop-credential-reuse.md)。不扫全盘、不读同目录其它文件、不写回 |
| 不碰 Windows 凭据管理器 | 不用 `wincred` / `DPAPI` |
| 不 attach 进程内存 | 不读官方客户端的运行时内存 |
| 日志不打 token | 只打 `sha256(token).slice(0,8)`（`tokenTag()`） |

**这是刻意的取舍**：一个 DSH 插件如果去翻浏览器的 cookie 库，就是在越界。用户给这个插件的授权是"帮我把小浣熊接进 DSH"。读官方客户端那一个 `auth.json` 是"复用登录态"的最小必要动作；再往外扩一步（读浏览器、读凭据管理器、读内存）就越界了。

---

## 10. 数据目录定位

```ts
// host/store.ts
export function dshHome(): string {
  const fromEnv = process.env["DSH_HOME"];
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

export function dataDir(): string {
  return join(dshHome(), "state", "dsh-raccoon-web");
}
```

**不用 `ctx.profile.home`。** 早期设计（[06-open-questions](../01-research/06-open-questions.md) Q11）打算读 `ctx` 上的 profile 路径，实现时发现没必要：`$DSH_HOME` 缺失时 `~/.dsh` 就是本机实测的默认值（E-013），而 token 本来就该是用户级的、不该随 profile 变。

桌面端凭据的定位是另一套（`protocol/desktop-auth.ts` 的 `authCandidates()`），六条候选路径按顺序探测：

| # | 路径 | 依据 |
| --- | --- | --- |
| 1 | `$BOX_AGENT_CONFIG_DIR/auth.json` | 官方 asar `getBoxAgentAuthPath()` 的第一优先 |
| 2 | `$BOX_AGENT_HOME/config/auth.json` | 同上 |
| 3 | `~/.office-raccoon/agent/config/auth.json` | **Windows 桌面端实际用的**（E-030） |
| 4 | `~/office-raccoon/agent/config/auth.json` | 非点号变体 |
| 5 | `~/.office-raccoon/config/auth.json` | 少一层 `agent` 的变体 |
| 6 | `~/.box-agent/config/auth.json` | 老版本/跨平台默认值 |

`readDesktopAuth()` **永不抛**，逐候选 `try`；过期也返回（由上层给"已过期"文案）。测试用 `HostOptions.desktopHome` 把临时目录当用户主目录，避免读到开发机真实凭据。
