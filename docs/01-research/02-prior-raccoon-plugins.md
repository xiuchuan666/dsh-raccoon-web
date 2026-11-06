# 已有的小浣熊反代：逐个盘点与失效归因

最后更新: 2026-11-06
状态: 已定稿

## 盘点

| # | 包/仓库 | 版本 | 作者 | 框架 | 取凭据方式 | 现在能用吗 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `dsh-raccoon-connect` | 0.2.4 | zhlcba | DSH 原生 | `~/.box-agent/config/auth.json` | ❌ |
| 2 | `dsh-llm-adapters`（含小浣熊） | 1.2.4 | k1-h2 | DSH 原生 | 网页微信扫码 | ✅ 协议可用 |
| 3 | `magpie-raccoon-auth` | 0.3.2 | an0119 | magpie（非 DSH） | 网页微信扫码 | ⚠️ 框架不同 |
| 4 | `dsh-raccoon` | 0.0.1 | dushaobindoudou | — | — | ❌ 占位包 |
| 5 | `dsh-raccoon-checkin` | — | Ckarefulon | 给别人打补丁 | 继承宿主插件 | ❌ 上游一变就碎 |
| 6 | `dsh-connect-sensenova-token-plan` 内建的浣熊 | 0.8.6 | — | DSH 原生 | 网页微信扫码 | ✅ |

> 编号 6 不在"小浣熊反代"这个类目里，但它是目前**最好用的一份浣熊 provider 实现**，必须算进来。

---

## 一、`dsh-raccoon-connect@0.2.4` —— 最有参考价值的那一个

下载量 1346/月，是这个品类的事实标准。fork 自 `liudapeng0311/dsh-raccoon-work`，上游只支持 DSH 0.1.5。

### 结构

```
lib/index.js             1345 行
lib/client.js            1637 行
lib/bin.js                241 行
lib/version-Bdhdp2uE.js  1944 行
cordis.patch.yml
README.md / README.en.md / CHANGELOG.md / LICENSE
```

`version-Bdhdp2uE.js` 是打包时被 split 出来的 chunk —— 说明它用 esbuild/tsup 打包但没设 `noExternal`，把某个依赖切了出去。**这是个教训：分包会让插件在 loader 里多一次相对路径 `import()`，路径一错就整个插件起不来。** 新插件用单文件输出（`tsup --no-splitting`）。

### 它的核心 bug（`0.2.2` 修的，但方向仍然错）

`textOf()` 把响应体截断到 4096 字符：

```js
// 修复前的形状（复现自 CHANGELOG 描述）
const text = body.slice(0, 4096);
```

症状是**新模型永远显示不出来**，UI 里看到 `[object Object]`。原因是 `model_catalog` 的响应超过 4 KB 之后被截断成非法 JSON，解析失败，回退到内置的旧名册。

**教训**：任何对外部响应的"防御性截断"都必须只用于**日志**，不能用于**解析**。

### 它的致命问题（本项目要解决的）

```js
// 凭据路径
const AUTH_FILE = path.join(os.homedir(), ".box-agent", "config", "auth.json");
```

本机实测：

```bash
$ ls ~/.box-agent/config/auth.json
ls: cannot access '...': No such file or directory
```

而小浣熊桌面端（`office-raccoon`）在本机留下的痕迹只有：

```
~/AppData/Roaming/office-raccoon/desktop-device-identity.json
{"schemaVersion":1,"clientDeviceId":"0bbdf36a-97d9-4e31-a354-855cf4103c52","createdAt":"2026-11-04T05:33:50.627Z"}
```

**只有设备标识，没有 token。** 桌面端把凭据挪去了别处（或压根没在这台机器上登录过）。

→ 这条路不是"代码有 bug"，是**入口消失了**。修不了。

### 它做对的事（要继承）

| 做法 | 说明 |
| --- | --- |
| `streamFirstByteTimeoutMs` 默认 60_000（0.2.4 新增） | 实测首字节中位 1–2 秒，高峰有 60s+ 无响应。**没有首字节超时，用户会以为卡死。** |
| 识图判定按**逐个模型实测**，不信目录 `vision` 标签 | 2026-09-18 实测 5 个模型错 2 个，两个方向都错 |
| 思考内容读 `delta.reasoning_content`（非标准字段） | 网关不按 OpenAI 规范发 `reasoning` |
| `peerDependencies` 用逐段预发布并集 | 见下 |

### `peerDependencies` 的写法（必须抄）

```jsonc
">=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-rc.1 <0.2.4-0 || ... || >=0.2.9-rc.1 <0.3"
```

**不能**写成 `>=0.2.1-rc.1 <0.3`。原因：node-semver 的预发布规则 —— 一个范围里只要有任何比较符带预发布标签，该范围就**只匹配同 major.minor.patch 的预发布版**。`>=0.2.1-rc.1 <0.3` 能匹配 `0.2.1-rc.5`，但匹配不到 `0.2.2-rc.1`。

它的 README 里专门写了一节解释这个坑。**照抄，并在 ADR 里记一笔。**

---

## 二、`dsh-llm-adapters@1.2.4` —— 协议逆向的最佳来源

8973 行的 `lib/index.js`，把 Loomy / 商汤小浣熊 / Trae / 华为云 CodeArts 四个接进 DSH。

**它的浣熊部分是**当前最完整的参考实现**：IAM 扫码、`xhx_token` 换取、catalog 探测、SSE 流、限流识别、积分、每日积分只读查询，全都有，而且**不依赖桌面端凭据**。

`src/raccoon-login.ts` 编译后在 `lib/index.js:5950-6240`。`src/raccoon.ts` 在 `:6240` 之后。

### 它做对的事（要继承）

1. **登录态校验只认 catalog 探测。** `raccoonAccessTokenValid(token)` 打 `GET /llm/v2/model_catalog`，要求 `data.categories` 是数组。不信任 `iam/confirm` 的返回值（那个失败也不致命）。
2. **网络抖动不杀登录。** `pollRaccoonQr` 里 `NETWORK_ERROR` / `TIMEOUT` → 继续 `pending`。只有明确的 `AUTH_QRCODE_EXPIRED` / `AUTH_QRCODE_NOT_FOUND` 才判过期。
3. **每次轮询重置 deadline。** 服务端返回新的 `expires_in` 就按它重算，而不是死守第一次的。
4. **会话 id 稳定化。** `sess-0-<sha256(principal + "\0" + model).slice(0,8)>`，同一账号同一模型永远同一个会话 id。理由写在代码注释里：官方客户端 26 分钟 125 次调用都用同一个 `sess-0-53927d74`，每次请求新 id 会让网关看到"一个账号几分钟内开了几百个会话"。
5. **限流错误分类。** `isRaccoonRateLimited(status, text)`：`status === 429` 或响应体含 `user_model_rate_limited` / `rate_limit` / `频率超限`。**200 的 SSE 流里也会出现 error frame**，所以判定要看帧内容，不能只看 HTTP 状态。
6. **每日积分只读。** 明确拒绝"重放 `setting_info` 触发发放"，理由写在 README：等于未经用户当时同意改变账号状态。

### 它的缺陷（本项目要改进）

| 缺陷 | 后果 | 本项目做法 |
| --- | --- | --- |
| 把四个 provider 塞进一个 9K 行的文件 | 改浣熊要动到别的 provider 的代码 | 单 provider 单包 |
| 二维码编码器只有 byte 模式 + M 级 + 版本 1–10，超 213 字节抛错 | 我们的 URL ~90 字节，够用；但这是隐性上限 | 保留同样的限制，但**在文档里写明**并在超限时给出可读错误 |
| 本地登录页用 `startLoginPage()` 起一个临时 HTTP server | 端口随机，杀软可能拦 | 改为走 DSH 自己的 `webServer`，不另开端口 |
| 没有 `x-client-platform` / `x-client-version`？ | 有，`raccoonHeaders` 带了 | 继承 |

---

## 三、`magpie-raccoon-auth@0.3.2`

单文件 `index.mjs`，**magpie 框架插件，不是 DSH 插件**。移植自 `aimod-cc/agent2api`。

价值：它的 `chat` / `models` / `points` / 每日积分四个函数是**最干净的协议参考** —— 因为 magpie 的插件协议比 DSH 简单得多，作者没花篇幅在框架适配上。

**不能直接用**：magpie 的 `ctx` 与 DSH 的 cordis `ctx` 完全不同。

---

## 四、`dsh-raccoon@0.0.1` 与 `dsh-raccoon-checkin`

- `dsh-raccoon@0.0.1`（dushaobindoudou）：**名字占位，没有实现**。`npm view dsh-raccoon` 能查到，装下来是空壳。留个记录，避免以后有人以为"这个包能用"。
- `dsh-raccoon-checkin`：不发布到 npm，是给 `dsh-providers-hub` 的 `node_modules` 打补丁加签到功能。**这种做法的生命周期 = 上游下一次发版。** 本项目把"每日积分只读展示"做进自己的 UI，不去改别人的包。

---

## 五、`dsh-connect-sensenova-token-plan@0.8.6` 内建的浣熊 provider

### 装配

`lib/raccoon-llm-adapter.js`（62 行）+ `lib/llm-adapter-core.js`（514 行）+ `lib/raccoon-models.js`（1116 行）。

provider id 写死 `sensenova-raccoon`，显示名 `SenseNova Raccoon`，模型 id 带 `sn-` 前缀（`sn-glm-5-3` 等）。

### 它的两个已知缺陷

**缺陷 1：请求头不完整。**

```js
function raccoonRequestHeaders(officeIdentity = "") {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Org-Code": officeIdentity,
    "X-Raccoon-Language": "zh",
  };
}
```

少了 `x-client-platform` 与 `x-client-version`。而 `dsh-llm-adapters` 的 `raccoonHeaders()`：

```js
{
  authorization: `Bearer ${token}`,
  "x-org-code": "",
  "x-raccoon-language": "zh",
  "x-client-platform": "desktop-windows",   // 按 process.platform
  "x-client-version": "v1.0.35",
}
```

**两个独立实现对同一网关，一个带一个不带。** 带的那份更可能是对的（官方网页端一定发）。缺头可能：被网关降级、被计入"非官方客户端"限流桶、或直接在某些端点 400。

→ 本项目**带上**，并在实测记录里注明"带与不带都能通，但带上更接近官方行为"。

**缺陷 2：思考通道被放弃。**

```js
reasoning: false,  // 网关唯一思考通道是 extra_body.thinking，pi-ai openai-completions 不发射它
```

注释是诚实的，但结论是"放弃"。而 `dsh-llm-adapters` 的做法是：

```js
if (effort === "off" || effort === "none") {
  body.extra_body = { thinking: { type: "disabled" } };
  if (effort === "none") body.reasoning_effort = "none";
} else {
  body.extra_body = { thinking: { type: "enabled" } };
  if (effort !== "on") body.reasoning_effort = effort;
}
```

它自己写了 `openAiStream()`，所以能塞任意字段。

→ 本项目用**自定义 pi-ai Api** 把 `extra_body` 塞进去。见 [ADR-0003](../02-design/adr/0003-reasoning-channel.md)。

### 它做对的事（要继承）

- **`RACCOON_REQUEST_IMAGE_PIXEL_BUDGET = 640_000`**。网关单请求体上限 ~10 MB，超了 `HTTP_413`。默认像素预算会撞上限，必须下调。
- **`QUOTA` / `ACCOUNT_QUOTA` 不重试**。共享积分池，重试只延长冷却。
- **模型目录里有 `multiplier` 就拼进显示名**（`GLM-5.3 · x0.75`）。用户能直接看到"这个模型贵不贵"。
- **内置 fallback 名册**（2026-10 快照，6 个模型）。目录拉不到时不至于空白。

---

## 六、失效归因总结

把六份实现的失效原因归类：

| 归因 | 涉及 | 本质 |
| --- | --- | --- |
| **凭据入口消失** | #1 #4 #5 | 桌面端把 token 挪走 / 上游改包结构 |
| **框架绑定** | #3 | magpie ≠ DSH，ctx 不通 |
| **分包路径错** | #1 的 `version-*.js` | 打包配置问题，与网关无关 |
| **响应体防御性截断** | #1 的 `textOf()` | 防御代码用错地方 |
| **请求头不完整** | #6 | 未对齐官方客户端 |
| **思考通道放弃** | #6 | 受限于 pi-ai 的 openai-completions API |

**前三条是"环境变了"，后三条是"实现妥协"。**

新插件要同时解决两类：

- 环境层 → 换入口（网页扫码）+ 单文件输出 + 不解析截断
- 实现层 → 补齐请求头 + 自定义 Api 打开思考 + 限流/积分/名册都做到位

## 七、四个"必须比前辈做得更好"的点

1. **凭据入口可探测。** 插件启动时主动探测"当前用哪条路"，而不是假设某条路存在。状态端点里直接告诉用户"扫码可用 / 桌面端凭据不存在"。
2. **首字节超时。** 60 秒（对齐 `dsh-raccoon-connect@0.2.4` 的实测结论）。没有它，高峰期的静默会变成"DSH 卡住了"。
3. **思考通道打开。** 用自定义 Api 发 `extra_body.thinking`，让 DSH 的 `reasoningEffort` 真正生效。
4. **失败可诊断。** 每个错误都带"下一步做什么"，而不是"出错了"。
