# 实测记录

最后更新: 2026-11-06
状态: 已定稿（持续追加）

> 规矩：任何"网关会返回 xxx"的断言，必须在这里有一条带时间戳的记录。
> 网关行为变了不是 bug，是**假设过期** —— 先改这里，再改代码。

复现环境：Windows 10 x64 / Node v24.22.1 / npm 12.2.0 / 直连（无代理）/ 2026-11-06 09:2x CST。

---

## E-001 扫码取二维码：可用

```bash
curl -sS -X POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode \
  -H 'content-type: application/json' -d '{}'
```

`HTTP 200`

```json
{"code":"OK","message":"success","request_id":"reqiam-01a1ae79-...",
 "data":{"expires_in":300,"poll_interval":2,
         "qrcode_code":"qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062",
         "scan_path":"/login/mp","status":"pending"}}
```

**结论**：`scan_path` 是 `/login/mp`，`expires_in=300`，`poll_interval=2`。字段名全小写下划线。`code` 是字符串 `"OK"`（不是数字 0）。

---

## E-002 轮询：未扫码时返回 pending

```bash
curl -sS -X POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode/login \
  -H 'content-type: application/json' \
  -d '{"qrcode_code":"qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062"}'
```

`HTTP 200`

```json
{"code":"OK","data":{"expires_in":269,"poll_interval":2,"status":"pending"}}
```

**结论**：每次轮询返回的 `expires_in` 在**递减**（300 → 269），说明服务端计时。客户端不能自己算，必须每次重置。

---

## E-003 二维码页面不能直接打开

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  'https://xiaohuanxiong.com/login/mp?code=qr-01a1ae79-...&appname=x&source=platform'
```

`404`

**结论**：这个页面只响应微信内置浏览器的 UA/环境。**设置页不能放"在浏览器打开登录页"的按钮** —— 会 404。
二维码是唯一交互方式。这是设计上的硬约束，写进 [ADR-0001](../02-design/adr/0001-login-via-web-qr.md)。

---

## E-004 未授权访问 model_catalog

```bash
curl -sS -i https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
```

`HTTP 401`

```json
{"code":200001,"message":"authorization_empty_error","details":"authorization empty"}
```

**结论**：没带 `Authorization` → `200001`。`code` 是**数字**（与 IAM 的字符串 `"OK"` 不同格式，两套 API 两套约定）。

---

## E-005 伪造 Bearer

```bash
for p in /api/web/llm/v2/model_catalog /api/web/points/v1/balance /api/web/auth/v1/iam/confirm; do
  curl -sS -o /dev/null -w "$p %{http_code} " -X POST "https://xiaohuanxiong.com$p" \
    -H 'authorization: Bearer fake' -H 'content-type: application/json' -d '{}'
done
```

三个端点全部 `HTTP 401`，body 全部：

```json
{"code":200003,"message":"authorization_verify_error","details":"authorization verify failed"}
```

**结论**：`200003` 是**会话死亡码**。看到它就清缓存 + 提示重新扫码，重试没有意义。

sensenova 的 `RACCOON_DEAD_SESSION_CODES = new Set([401, 200003])` 与此一致。

---

## E-006 桌面端凭据文件不存在（**结论已作废，见 E-030**）

> **⚠️ 过期说明（2026-11-06 追加）**：本节只查了 `~/.box-agent/config/auth.json` 就下了"本机没有桌面端登录态"的结论。**这个结论是错的**——Windows 桌面端把凭据写在 `~/.office-raccoon/agent/config/auth.json`（E-030），那里的文件一直存在且 token 可用（E-031）。本节保留原文，作为"路径找错会导致什么"的记录。

```bash
ls -l ~/.box-agent/config/auth.json
```

```
No such file or directory
```

同机存在的相关痕迹：

```
~/AppData/Roaming/office-raccoon/desktop-device-identity.json
{"schemaVersion":1,"clientDeviceId":"0bbdf36a-97d9-4e31-a354-855cf4103c52","createdAt":"2026-11-04T05:33:50.627Z"}
```

```bash
ls -d ~/AppData/Local/Programs/*raccoon* 
```

```
No such file or directory   # 小浣熊桌面端未安装
```

**结论**：`dsh-raccoon-connect@0.2.4` 依赖的凭据入口在本机**不存在**。这条路线不可用 —— 不是代码 bug，是环境变了。
仅有 `clientDeviceId`（设备标识），没有 token。`office-raccoon` 的凭据若存在，也只可能在别处（浏览器 cookie / 凭据管理器），不在文件系统里。

→ 走网页扫码。见 [ADR-0001](../02-design/adr/0001-login-via-web-qr.md)。

---

## E-007 二维码内容长度

```bash
node -e 'const u=new URL("/login/mp","https://xiaohuanxiong.com");u.search="";u.searchParams.set("code","qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062");u.searchParams.set("appname","商汤小浣熊");u.searchParams.set("source","platform");console.log(u.href);console.log("bytes=",Buffer.byteLength(u.href,"utf8"))'
```

实际输出：

```
https://xiaohuanxiong.com/login/mp?code=qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform
bytes= 149
```

**结论**：**149 字节**。byte 模式 + M 级纠错下：版本 7 = 122 字节（不够），**版本 8 = 152 字节（刚好）**。

→ 二维码编码器必须支持到**版本 8**（`qrcode_code` 长度若变了还要往上浮动，留到版本 10 = 213 字节）。

> ⚠️ **这修正了 `docs/01-research/03-raccoon-protocol.md` §1.2 里"版本 6"的说法** —— 那里按 ~110 字节估的。真实值 149 字节。协议文档已同步改为版本 8。见 [ADR-0002](../02-design/adr/0002-self-contained-qr-encoder.md)。

---

## E-008 内核包只能从安装目录解析

```bash
cd ~/.dsh/profiles/desktop && node -e 'import("@deepseek-ai/dsh-llm").then(m=>console.log("OK",Object.keys(m).length)).catch(e=>console.log("FAIL",e.code))'
```

```
FAIL ERR_MODULE_NOT_FOUND
```

```bash
cd "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh" && \
  node -e 'import("@deepseek-ai/dsh-llm").then(m=>console.log("OK",Object.keys(m).length)).catch(e=>console.log("FAIL",e.code))'
```

```
OK 50+
```

**结论**：内核包由宿主的 loader 提供，插件不能把它们打进 bundle。`peerDependencies` + tsup `external`。

---

## E-009 内核包没有类型声明

```bash
find "C:/.../resources/app/dsh/node_modules/@deepseek-ai" -name '*.d.ts' | wc -l
```

```
0
```

但每个包的 `package.json.types` 都指向 `./lib/types/index.d.ts`（**不存在**）。

**结论**：TS 会报 `Cannot find module` 或直接 fallback 到 `any`。要么自己写 `src/types/dsh.d.ts` 声明模块，要么接受 `any`。我们选**自己写最小声明**，只声明我们真正用到的那几个符号。

---

## E-010 pi-ai 不发射 extra_body

```bash
grep -c -E 'extra_body|extraBody|providerOptions' \
  "C:/.../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
```

```
0
```

```bash
find "C:/.../node_modules/@earendil-works/pi-ai/dist" -name '*.d.ts' | wc -l
```

```
0
```

**结论**：pi-ai 的 `openai-completions` API 是**闭合的**，不接受任意额外字段。要发 `extra_body.thinking` 只有两条路：① 自己写 Api；② 不用 pi-ai 的 openai-completions。

选 ①。见 [ADR-0003](../02-design/adr/0003-reasoning-channel.md)。

---

## E-011 profile 里没有 qrcode 包

```bash
ls "C:/.../resources/app/dsh/node_modules" | grep -i -E 'qr|qrcode'
```

```
(no output)
```

**结论**：不能 `import "qrcode"`。要么新增依赖（拖累整个 app），要么自己实现。见 [ADR-0002](../02-design/adr/0002-self-contained-qr-encoder.md)。

---

## E-012 node-semver 的预发布陷阱

```js
const semver = require("semver");
semver.satisfies("0.2.2-rc.1", ">=0.2.1-rc.1 <0.3");   // false
semver.satisfies("0.2.2-rc.1", ">=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0"); // true
```

**结论**：范围里只要有一个比较符带预发布标签，该范围就只匹配**同 major.minor.patch** 的预发布版。
必须逐段列出。照抄 `dsh-raccoon-connect@0.2.4` 的写法。

---

## E-013 本机 DSH 版本与 profile

```bash
node -p 'require("C:/.../resources/app/dsh/package.json").version'
```

```
0.2.1-rc.5
```

```
~/.dsh/profiles/desktop/node_modules/ 里的相关插件：
dsh-connect-workbuddy            5.17.0
dsh-connect-trae                 4.8.0
dsh-connect-minimaxcode          0.5.4
dsh-connect-sensenova-token-plan 0.8.6
```

**结论**：开发目标版本 `0.2.1-rc.5`；`peerDependencies` 覆盖 `>=0.2.1-rc.1` 起的全部 0.2.x。

---

## E-020 · `pi-ai` 的 `Api` 真实形状与 `reasoning_content` 原生支持（2026-11-06 实测）

从 `C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@earendil-works/pi-ai/dist/` 读出：

**`Api` 的形状**（`dist/api/lazy.js` 全文只有 `lazyApi` 与 `lazyStream` 两个函数）：

```js
lazyApi(load, capabilities) => ({
  stream:       (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
  streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
})
```

`lazyStream(model, setup)` **同步返回** `new AssistantMessageEventStream()`，内部 `.then(inner => forwardStream(outer, inner))` 逐事件 `target.push(event)`。

**所以 `Api.stream` 必须同步返回一个 EventStream 对象，不是 async generator。** ADR-0003 里写的 `async *stream() { yield ... }` 是错的。

**思考内容已被原生解析**（`dist/api/openai-completions.js:397-420`）：

```js
const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
```

命中就 `ensureThinkingBlock(thinkingSignature)` → `block.thinking += delta` → `stream.push({type:"thinking_delta", contentIndex, delta, partial})`。**不需要自己解析。**

**请求体可在发送前改写**（`:188-191`）：

```js
const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) params = nextParams;
```

但 `dsh-llm-pi-ai/lib/index.js:1754-1767 profileOptions()` **不透传 `onPayload`** —— 只给 `apiKey / reasoning / thinkingBudgets / cacheRetention / transport / timeoutMs / websocketConnectTimeoutMs / maxRetries:0`。所以只能在**自己的 Api 包装层**里注入。

**`detectCompat` 对 `raccoon-web` 走默认分支**（`:1225-1304`）：provider 名与 `xiaohuanxiong.com` 的 baseUrl 不命中任何分支 → 默认 `maxTokensField:"max_completion_tokens"`、`supportsDeveloperRole:true`、`thinkingFormat:"openai"`。**必须显式覆盖 `compat.maxTokensField:"max_tokens"` 与 `supportsDeveloperRole:false`。**

---

## E-021 · `getSupportedThinkingLevels` 只给五档（2026-11-06 实测）

`pi-ai/dist/models.js:679-690`：

```js
if (!model.reasoning) return ["off"];
return EXTENDED_THINKING_LEVELS.filter(l => model.thinkingLevelMap?.[l] !== null && (l !== "xhigh" && l !== "max" || model.thinkingLevelMap?.[l] !== undefined));
```

`EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`。

**不设 `thinkingLevelMap` → 只有五档** `["off","minimal","low","medium","high"]`。`smoke-provider.mjs` 已按五档断言。本项目**决定不补 map**（少一个可能被上游拒绝的取值）。

---

## E-022 · `PiAiAdapter` 的两个调用约定（2026-11-06 实测）

`dsh-llm-pi-ai/lib/index.js:1887-1912`：

- `listModels(provider)` **只返回** `{provider, id, name, inputModalities}`，**不含** `contextWindow`。
- `modelInfo(snapshot, provider, model)` 是**三参数内部签名**；外部要调 `resolveModel(provider, model, signal)`。直接 `adapter.modelInfo("p","x")` 会 `TypeError: Cannot read properties of undefined (reading 'get')`。
- `current()` 用 `this.snapshot?.profiles === profiles` **引用相等**做 memo（`:1856-1871`）→ 换名册必须换 adapter 实例。
- `providerRetryPolicy(provider)` 返回 `profile.retryPolicy`；`resolveRetryPolicy(config, path)` 的 `mode` **只接受 `"normal"` 与 `"always"`**（`dsh-llm/lib/index.js:247-347`），写 `"aggressive"` / `"never"` 会直接 throw。

---

## E-023 · `baseUrl` 必须是 base，不能是全路径（2026-11-06 实测）

`pi-ai/dist/api/openai-completions.js:531-565 createClient()` 把 `model.baseUrl` 原样交给 `new OpenAI({baseURL})`，SDK 在 `client.chat.completions.create()` 里**自己拼 `/chat/completions`**。

写成 `.../llm/v2/chat/completions` 会变成 `.../chat/completions/chat/completions` → 404。

**本项目 `roster.ts` 用 `baseUrl: LLM_BASE`**，`LLM_CHAT_URL` 只留给 probe 与测试断言。

---

## E-024 · 自实现 QR 编码器的真解码验证（2026-11-06 实测）

`scripts/verify-qr.mjs` 生成 12 个容量边界用例，`scripts/qr-to-png.mjs` 转 PNG，Python `cv2.QRCodeDetector().detectAndDecode()` 真解码比对：**12/12 通过**。

后续随机内容 fuzz（40 个 149 字节 URL 形状内容）：`cv2.QRCodeDetector` 解出 38/40，`cv2.QRCodeDetectorAruco` 解出 **40/40**（两个检测器并集 40/40）。**结论：编码器没有数据相关 bug；单检测器不通过是检测算法本身对高密度符号的处理问题，不是编码问题。**

真宿主下发的二维码（矩阵 57×57 = v8 + 4 格静默区）用 `QRCodeDetectorAruco` 解码得到 149 字节，与会话 code 完全一致。

> 教训：**验证二维码不要只用一个检测器。** `cv2.QRCodeDetector` 对这个版本的定位图案组合有偏好；`QRCodeDetectorAruco` 更稳。

---

## E-025 · 真宿主加载与端点行为（2026-11-06 实测）

`node scripts/link.mjs` 之后，运行中的 DSH（`http://127.0.0.1:57292`）**热重载即加载**，无需重启：

```
GET  /plugins/dsh-raccoon-web/status                     → 200
POST /plugins/dsh-raccoon-web/action?action=login-start  → 200 {ok:true, login:{phase:"pending", qrSvg:"<svg ... viewBox=\"0 0 57 57\" ...>"}}
```

- 未登录时 `publish: "not-configured"`、`catalogReady: false`，但 `models` 仍返回 5 条 fallback（**"展示"与"注册 provider"是两件事**）。
- `qrSvg` 约 17 KB（1224 个暗模块 × 每模块 14 字节 path 命令）。
- 诊断块九行，不含 token。

---

## E-026 · tsup `onSuccess` 在中文路径下必然失败（2026-11-06 实测）

`onSuccess: "node ../../scripts/copy-client.mjs"` 报 `The system cannot find the path specified.` 并让 tsup 非零退出（产物其实已生成）。原因：tsup 用 shell 拼命令行，`cmd.exe` 按 cp936 解释路径。

**修法：不用 `onSuccess`，改 `package.json` 的 `"build": "tsup && node ../../scripts/copy-client.mjs"`。**

---

## E-027 · Node ESM loader 钩子的两个坑（2026-11-06 实测）

1. `resolve` 返回值里**不能带 `format: "module"`**，否则 `--experimental-strip-types` 不剥类型，`.ts` 里的 `export` 报 `SyntaxError: Unexpected token 'export'`。
2. loader 文件里 `import { dirname, join, resolve }` 与导出的 `resolve` 钩子函数**重名** → `SyntaxError: Identifier 'resolve' has already been declared`。要 `import { resolve as resolvePath }`。

---

## E-028 · 带 query string 的动态 import 会绕过 loader 钩子（2026-11-06 实测）

`await import("./store.js?t=" + Date.now())` 会 `ERR_MODULE_NOT_FOUND` —— query string 让 loader 钩子的 `specifier` 匹配不上。

修法：用静态 `import * as store from "../src/host/store.js"`，靠每次读 `process.env.DSH_HOME` 来隔离测试环境。清理时用 `delete process.env["DSH_HOME"]`（**不是赋 `undefined`**，那会变成字符串 `"undefined"`）。

---

## E-029 · 「二维码刚生成就过期」是我自己的脚本作的（2026-11-06 实测）

连续 4 张码，手机扫完立刻显示「二维码已过期或已被使用，请在 Web/PC 端刷新二维码后重新扫码」。

排错过程排除掉了所有"看起来像"的原因：

- 不是编码器：同一张 SVG 用 OpenCV 双检测器解出来，内容完全正确（E-024）。
- 不是 `appname`：手机端确实识别出了「确认登录商汤小浣熊」，说明 `appname=商汤小浣熊` 是对的。
- 不是请求头：码的生成与手机端解析都不经过我们的 `x-client-*`。

**真实原因是操作顺序**：`scripts/login-qr.mjs` 旧版无条件先打 `POST /plugins/dsh-raccoon-web/action?action=login-start`，而 `LoginFlow.start()` 内部是

```ts
async start() { this.cancel(); const qr = await createQr(...); ... }
```

`cancel()` 之后 `createQr()` 会让服务端把旧码标记为已使用。于是"贴给用户一张码 → 后台再跑一次脚本盯状态"这个操作，**贴出去的那一刻码就已经死了**。

修法（`scripts/login-qr.mjs`）：默认 `--reuse` 语义——只有当前相位不是 `pending|logging` 或本地 `deadline` 剩余不足 3 秒时才换码；新增 `--new` 显式换码、`--wait-only` 只轮询绝不换码。标准顺序固定为：

```bash
node scripts/login-qr.mjs --new        # 取一张，贴给用户
node scripts/login-qr.mjs --wait-only  # 后台盯，绝不换码
```

**教训**：一个"刷新"动作如果是破坏性的，就不能放在只读的观察路径上。这条已写进 `login-qr.mjs` 的文件头注释，防止重犯。

---

## E-030 · 桌面端凭据真实落点是 `~/.office-raccoon/agent/config/auth.json`（2026-11-06 实测）

E-006 当时查的是 `~/.box-agent/config/auth.json`，不存在 → 判定"本机没有桌面端登录态"。**这个判定是错的，因为路径找错了。**

读官方客户端 `C:/Program Files/@raccoonoffice-desktop/resources/app.asar`（336918710 字节，`@raccoon/office-desktop` 1.1.9）里的 `clientProfile.js`：

```js
const PROFILE_MARKER = '.raccoon-lab-client.json';
const PROFILE_CONTENT = '{"application":"@raccoon/office-desktop","version":1}\n';
const PROFILE_DIRECTORY = 'office-raccoon';
const WINDOWS_PROFILE_DIRECTORY = '.office-raccoon';
```

桌面端启动时把 `BOX_AGENT_CONFIG_DIR` 指向 `C:/Users/Administrator/.office-raccoon/agent/config`，于是 `getBoxAgentAuthPath()` 的结果落在 **`.office-raccoon`** 下。

本机实测文件：`C:/Users/Administrator/.office-raccoon/agent/config/auth.json`，490 字节，2026-11-04 13:33 写入。

```json
{"access_token":"<432 字符 JWT>","office_identity":"personal"}
```

JWT claims：

```json
{"sid":"ses-01a1a50c-96a1-76a2-80ab-1f98cc122f74","ver":0,
 "iss":"xiaohuanxiong.com/iam",
 "sub":"pu-01a19cd4-974e-7954-a640-f4cc795e3473",
 "aud":["xiaohuanxiong.com"],
 "exp":1796362428,"nbf":1793770423,"iat":1793770428,
 "jti":"ak-01a1a50c-96a8-7b2e-a3ba-25c27a5bffd7"}
```

`exp` = **2026-12-04T05:33:48Z**。

同目录还有 `config.yaml`（1444B）、`mcp.system.json`（4537B）、`model-profiles.json`（1281B）、`skill-settings.json`（93B）。`model-profiles.json` 里两个 profile 均 `provider:"openai"`、`apiBase:"https://xiaohuanxiong.com/api/web/llm/v2"`、`apiKey:"box-agent-auth-json"`、`authFile` 指向上面那个路径。

**结论**：上一代插件依赖的"桌面端凭据"确实存在，只是路径变了。这也是为什么它们"全部失效"——它们读的是 `~/.box-agent`，而客户端早在某个版本就迁到了 `~/.office-raccoon`。

---

## E-031 · 桌面端 token 对五个端点全部可用（2026-11-06 实测）

拿 E-030 的 token 直接打网关，**不做任何 header 伪装**（只带 `accept` + `authorization: Bearer`）：

| 端点 | 结果 |
| --- | --- |
| `GET /api/web/llm/v2/model_catalog` | **200**，4537B，`code:0`，`data.categories` 1 组 / **9 个模型** |
| `POST /api/web/llm/v2/chat/completions` | **200** `text/event-stream; charset=utf-8`，SSE 逐帧正常 |
| `GET /api/web/points/v1/balance` | **200** `available_points:11700, daily_points:1200, reward_points:10500, topup_points:0` |
| `GET /api/web/points/v2/bills?paging.limit=3&type=all` | **200**，`items[0].biz_type:"daily_grant"`、`points:300`、`grant_at:"2026-11-06T00:00:00+08:00"` |
| `GET /api/web/auth/v1/user_info` | **200** `name:"RaccoonElizabeth"`, `id:"7865139"`, `orgs:[]` |

**目录里 9 个模型**（`visible` 是官方客户端是否展示）：

| id | visible | tags 里有 vision | billing_multiplier |
| --- | --- | --- | --- |
| `raccoon-090dd3` | false | 是 | 1 |
| `raccoon-19b265` | false | 否 | 1 |
| `raccoon-405a1c` | false | 否 | 1 |
| `sn-sensenova-6-8-flash` | true | 是 | 0.5 |
| `sn-sensenova-6-8-flash-lite` | true | 是 | 0.5 |
| `sn-glm-5-3` | true | **否** | 0.75 |
| `sn-kimi-k3` | true | 是 | 1 |
| `sn-glm-5-3-flash` | true | 是 | 0.2 |
| `sn-deepseek-v4-1-flash-1017` | true | 是 | 0.25 |

`raccoon-090dd3`（`description` = `Raccoon-Work`）与 `sn-glm-5-3` 直调 chat 都 200 → **`visible:false` 的模型能调通**，只是官方客户端不展示。插件默认过滤掉，留 `includeHidden` 开关。

---

## E-032 · 目录字段的真实形状（推翻了我们三处解析假设）

`sn-kimi-k3` 的完整对象：

```json
{"name":"sn-kimi-k3","description":"Kimi-K3","visible":true,"billing_category":"normal",
 "model_name":"sn-kimi-k3",
 "display_description":"适合复杂办公任务、代码开发、调试和图像识别等任务",
 "tags":["general","office","code","vision","debug","analysis","html","reasoning"],
 "ability_level":2,
 "params":{"context_window":1000000,"max_tokens":100000},
 "billing_multiplier":1,
 "billing_effective_multiplier":1,
 "billing_status":"normal","billing_status_note":"","billing_discounts":[]}
```

三处必须修（已修）：

1. **`context_window` / `max_tokens` 在 `params` 嵌套对象里**，不在顶层 → 新增 `pickNumberDeep()`（先顶层，再 `params`/`config`/`limits`/`meta`/`spec`）。
2. **显示名在 `description`**（`"Kimi-K3"`），`name` 与 `model_name` 都是 id。
3. **倍率是 `billing_multiplier` / `billing_effective_multiplier`**，不是 `multiplier` / `points_multiplier`。

另外：**分类对象只有 `{type:"chat", default_model:"raccoon-090dd3"}`，没有 `key` / `name`** → 分组 key 必须取 `type`，否则恒为 `"default"`。

---

## E-033 · 官方桌面端用的是另一套扫码协议（`/api/web/auth/v1/login_with_qrcode_code`）

asar 内 `createAccountQrSession`：

```js
const code = `${Date.now()}${randomBytes(16).toString('hex')}`;  // 45 字符，本地生成
const url = new URL('/login/mp', options.baseUrl);
url.searchParams.set('code', code);
url.searchParams.set('appname', '小浣熊官网');                    // 注意不是「商汤小浣熊」
```

轮询 `POST /api/web/auth/v1/login_with_qrcode_code { qrcode_code }`，入口校验正则 `/^\d{13}[a-f0-9]{32}$/`。

与 IAM 协议（E-001）的关键差异见 [ADR-0009](../02-design/adr/0009-web-auth-qr-protocol.md)。实测交叉验证：

- Web 码打 IAM 端点 → `401 {"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid"}` → **两套命名空间完全不通用**。
- `login_with_qrcode_code` 对**任何**格式正确的 code（含 `1234567890123` + 32 个 `a`）都返回 `200 {"code":0,"data":{"status":"pending"}}` → **该端点没有"code 有效性"概念**，别指望用它验证码。
- `GET /login/mp?...` 无论 fresh / 过期 / 垃圾，一律 **404**（6490~6572 字节 Next.js 骨架）→ 页面只能被微信打开，不能靠 HTTP 状态判断。
- 实测 Web 码二维码内容 **139 字节**（`code` 45 + `appname` 编码后 45 + 固定部分）→ 仍落在 QR **版本 8**（版本 7 容量 122 不够）。

---

## E-034 · 官方 LLM 请求头只有两个，`x-client-*` 是多余的

asar 内 `createHostedModels`：

```js
headers: { Authorization: `Bearer ${token}`, ...(orgCode === undefined ? {} : { 'X-Org-Code': orgCode }) }
```

`orgCode` 来自 `NEXT_PUBLIC_IS_TOB === 'true' ? NEXT_PUBLIC_ORG_CODE : (identity && identity !== 'personal' ? identity : undefined)` —— **只有 identity 不是 `personal` 才发**。

在 asar 里搜 `x-raccoon-language` / `x-client-version` / `x-client-platform`：**零命中**。

实测对照：带与不带这三个头 + `x-org-code: ""`，五个端点全部 200，**没有可观测差异**。所以先前"照着网页端补齐客户端头"这个决定**没有官方依据**，属于多余特征；保留（无害）但不作为正确性依据。

---

## E-035 · 思考通道 A/B 实测：`extra_body.thinking` 与顶层 `thinking` 都生效，`enable_thinking` 无效

对 `sn-sensenova-6-8-flash` 跑 `1+1=?只答数字`（`max_tokens: 48`）：

| 变体 | 有 reasoning_content | reasoning 字符数 | 正文 |
| --- | --- | --- | --- |
| 基线（只 authorization + content-type） | 是 | 260 | **空**（思考吃光 token） |
| `extra_body: {thinking:{type:"disabled"}}` | 是 | 81 | `"2"` |
| 顶层 `thinking: {type:"disabled"}` | 是 | 49 | `"2"` |
| `enable_thinking: false` | 是 | 389 | 空 |
| `reasoning_effort: "none"` | 是 | 82 | `"2"` |

结论：

1. `extra_body.thinking` **确实生效**（这正是 [ADR-0007](../02-design/adr/0007-wrap-openai-completions-api.md) 依赖的通道）。
2. 顶层 `thinking` 也生效——如果将来要简化，可以改 `compat.thinkingFormat` 走顶层字段，但那需要 pi-ai 的 `thinkingFormat` 有对应分支（目前没有）。
3. `enable_thinking` 无效，不要用。
4. **关掉思考后仍然会有少量 `reasoning_content`**（81~82 字符 vs 基线 260）。这是上游行为，UI 必须能容忍"关了思考还冒出几行思考"。

---

## 待补的实测

| # | 内容 | 状态 |
| --- | --- | --- |
| E-014 | 登录后 `model_catalog` 完整响应 | ✅ 已由 E-031 / E-032 覆盖（桌面端 token 与扫码 token 是同一类 IAM JWT） |
| E-015 | 带/不带 `x-client-platform` 的对比 | ✅ E-034：无可观测差异 |
| E-016 | `extra_body.thinking` 是否仍接受 | ✅ E-035：生效 |
| E-017 | SSE error frame 形状 | ✅ 三种形状已由 `parseFrame` 覆盖 + 单测；真实限流帧仍待撞一次 |
| E-018 | 图片：base64 vs URL | ⬜ **仍缺**：需要一次真实识图请求 |
| E-019 | 413 的真实阈值 | ⬜ **仍缺**：需要一次大图请求 |

剩下两条都只需要"已有登录态下发一次带图的请求"，不再需要人工扫码。
