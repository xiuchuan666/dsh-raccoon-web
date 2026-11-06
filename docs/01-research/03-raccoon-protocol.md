# 小浣熊网关协议手册

最后更新: 2026-11-06（全部字段按真实响应回填，E-030~E-035）
状态: 已定稿

> 一句话：**所有断言都来自一次真实抓包。凡事没标日期的段落，默认它已经过期。**

本文是**规格书**。代码以本文为准，本文以 `05-empirical-findings.md` 为准。

---

## 0. 常量

```ts
export const ORIGIN           = "https://xiaohuanxiong.com";
export const IAM_BASE         = `${ORIGIN}/api/iam/v1`;      // 协议 A
export const WEB_BASE         = `${ORIGIN}/api/web`;          // 协议 B + 账号 + LLM
export const LLM_BASE         = `${WEB_BASE}/llm/v2`;
export const POINTS_BASE      = `${WEB_BASE}/points`;
export const CLIENT_VERSION   = "v1.0.35";                    // 官方 asar 里的值
export const QR_APP_NAME      = "商汤小浣熊";                  // 协议 A
export const WEB_QR_APP_NAME  = "小浣熊官网";                  // 协议 B（官方桌面端用的）
export const CHECKIN_URL      = `${ORIGIN}/work/home`;

export const IAM_TIMEOUT_MS        = 20_000;
export const CATALOG_TIMEOUT_MS    = 15_000;
export const POINTS_TIMEOUT_MS     = 10_000;
export const FIRST_BYTE_TIMEOUT_MS = 60_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const CATALOG_TTL_MS        = 5 * 60_000;
export const QUOTA_TTL_MS          = 60_000;
export const QR_POLL_INTERVAL_MS   = 2_000;
export const LOGIN_TIMEOUT_MS      = 330_000;
export const IMAGE_PIXEL_BUDGET    = 640_000;
export const DEFAULT_CONTEXT_CAP   = 128_000;
```

---

## 1. 凭据来源

### 1.1 官方桌面端的 auth.json（默认路线，[ADR-0008](../02-design/adr/0008-desktop-credential-reuse.md)）

**位置**：`~/.office-raccoon/agent/config/auth.json`
（Windows：`C:\Users\<user>\.office-raccoon\agent\config\auth.json`）

**实测文件**（E-030）：490 字节，`-rw-r--r--`，2026-11-04 13:33 写。

```json
{
  "access_token": "<432 字符 JWT>",
  "office_identity": "personal"
}
```

**JWT claims**（解 payload，不验签）：

```json
{
  "sid": "ses-01a1a50c-96a1-76a2-80ab-1f98cc122f74",
  "ver": 0,
  "iss": "xiaohuanxiong.com/iam",
  "sub": "pu-01a19cd4-974e-7954-a640-f4cc795e3473",
  "aud": ["xiaohuanxiong.com"],
  "exp": 1796362428,
  "nbf": 1793770423,
  "iat": 1793770428,
  "jti": "ak-01a1a50c-96a8-7b2e-a3ba-25c27a5bffd7"
}
```

`exp` = **2026-12-04T05:33:48Z**（签发后约 30 天）。

**路径规则**（从官方 asar 反推）：

```
configDir = $BOX_AGENT_CONFIG_DIR
          || join($BOX_AGENT_HOME || join(homedir(), ".box-agent"), "config")
```

但**桌面端启动时把 profile 目录指到了 `.office-raccoon`**（`clientProfile.js` 的 `WINDOWS_PROFILE_DIRECTORY = '.office-raccoon'`），并把 `BOX_AGENT_CONFIG_DIR` 设成 `...\.office-raccoon\agent\config`。

**所以 `~/.box-agent/config/auth.json` 里没有凭据** —— 项目早期就是因为只查了这个路径，误判成"没装客户端"（E-006 已作废）。

**同目录的其它文件**（我们**一个都不读**）：

| 文件 | 大小 | 内容摘要 |
| --- | --- | --- |
| `config.yaml` | 1444 B | `api_key: box-agent-no-auth`、`api_base: .../llm/v2`、`model: sn-deepseek-v4-1-flash-1017`、`context_window: 1000000`、`max_output_tokens: 100000` |
| `model-profiles.json` | 1281 B | 两个 profile，均 `provider: openai`、`apiKey: box-agent-auth-json`、`authFile: <上面那个路径>` |
| `mcp.system.json` | 4537 B | MCP 连接器配置 |
| `skill-settings.json` | 93 B | — |

**边界**：只读 `auth.json` 这一个文件。不扫全盘、不读浏览器 cookie 库、不碰 Windows 凭据管理器、不 attach 进程内存。

### 1.2 扫码（兜底路线）

两条互不兼容的协议，见 §2。

---

## 2. 登录：两条扫码协议

| | **协议 A：IAM 小程序码** | **协议 B：Web auth（默认）** |
| --- | --- | --- |
| code 从哪来 | 服务端下发，`qr-01a1...` | **本地生成**，`${Date.now()}${randomBytes(16).hex}` = 45 字符 |
| 取码请求 | `POST /api/iam/v1/auth/mp/qrcode` | **无** |
| 二维码 URL | `/login/mp?code=<code>&appname=商汤小浣熊&source=platform` | `/login/mp?code=<code>&appname=小浣熊官网` |
| 轮询 | `POST /api/iam/v1/auth/mp/qrcode/login` | `POST /api/web/auth/v1/login_with_qrcode_code` |
| 拿到什么 | `access_token`（+ 可选 `xhx_token` cookie） | `tokens.accessToken`（IAM JWT） |
| 额外一步 | `POST /api/web/auth/v1/iam/confirm` 换业务 cookie（**失败不致命**） | 不需要 |
| 能被微信小程序扫 | ✅ | ✗ |
| 失败信号 | 有（`AUTH_QRCODE_EXPIRED` 等） | **没有**（对任何合法 code 都回 pending） |
| 官方客户端用哪个 | ✗ | ✅ |

**两个命名空间互不通用**：拿 B 格式的 code 打 IAM 端点，返回
`401 {"code":"AUTH_QRCODE_INVALID","message":"mini-program QR code invalid"}`。

### 2.1 协议 A：取二维码

```
POST /api/iam/v1/auth/mp/qrcode
Content-Type: application/json
body: {}
```

实测 200（E-001）：

```json
{
  "code": "OK",
  "message": "success",
  "request_id": "reqiam-01a1ae79-...",
  "data": {
    "expires_in": 300,
    "poll_interval": 2,
    "qrcode_code": "qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062",
    "scan_path": "/login/mp",
    "status": "pending"
  }
}
```

响应头还带 `set-cookie: INGRESSCOOKIE=...; Path=/api/iam`、`x-raccoon-request-id`、`server: nginx`。

**字段校验**（`createQr` 里硬性要求，否则抛 `INVALID_RESPONSE`）：

- `expiresIn > 0 && <= 3600`
- `pollInterval > 0`
- `scanPath` 必须：`startsWith("/")`、非 `//` 开头、不含 `[\\\s#]`、`new URL(scanPath, ORIGIN)` 后 `protocol === "https:"` 且 `origin === ORIGIN` 且 `hash === ""`

`scanPath` 那五条是**防 SSRF 与协议降级**：上游一旦返回 `//evil.com/x` 或 `https://other.com/x`，我们就把登录码发到别人服务器去了。

### 2.2 协议 A：二维码内容

```ts
function qrContent(session) {
  const url = new URL(session.scanPath, ORIGIN);
  url.search = "";                                        // ← 清掉 scan_path 自带的 query
  url.searchParams.set("code", session.code);
  url.searchParams.set("appname", "商汤小浣熊");
  url.searchParams.set("source", "platform");
  return url.href;
}
```

实测内容（**149 字节**）：

```
https://xiaohuanxiong.com/login/mp?code=qr-01a1ae79-4bcd-7ef7-8062-3f2d1bc46062&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform
```

`source=platform` 是我们加的（参考实现里有，官方 asar 里没有）。实测不影响。

**149 字节 → QR 版本 8**（byte 模式 M 级：v7 = 122 字节不够，v8 = 152 字节）。

### 2.3 协议 A：轮询

```
POST /api/iam/v1/auth/mp/qrcode/login
body: {"qrcode_code": "<code>"}
```

`data.status` 四态 + 两个错误码：

| status | 处理 |
| --- | --- |
| `pending` | 继续轮询，文案「等待扫码」 |
| `logging` | 继续轮询，文案「已扫码，请在手机上确认」 |
| `success` | 取 `data.access_token`，要求非空、`token_type` 为 `bearer` |
| `canceled` | 置 `expired` |

| 业务码 | 处理 |
| --- | --- |
| `AUTH_QRCODE_EXPIRED` | 置 `expired` |
| `AUTH_QRCODE_NOT_FOUND` | 置 `expired` |
| `NETWORK_ERROR` / `TIMEOUT` | **继续 pending，不抛** |
| 其它非 OK | 置 `error` |

**"网络抖动不能杀掉一次登录"** 是硬规矩。参考实现里写得很清楚：轮询期间的瞬时网络错误只 warn 一次再排下一次。

`expires_in` 会递减（实测 300 → 269），说明**服务端自己计时**；但每次成功轮询都应该用返回的新值重置本地 deadline。

### 2.4 协议 A：换业务 token（不致命）

```
POST /api/web/auth/v1/iam/confirm
Authorization: Bearer <access_token>
x-raccoon-language: zh-CN
body: {}
```

从 `Set-Cookie` 里取 `name === "xhx_token"` 或 `name.endsWith("xhx_token")` 的值（要处理引号包裹 + `decodeURIComponent`）。

**失败处理**：整个函数 catch 一切返回 `undefined`，不抛。理由：拿不到 cookie 就继续用 `access_token`，以 `model_catalog` 探测为准（§2.5）。

### 2.5 唯一的权威校验

```
GET /api/web/llm/v2/model_catalog
Authorization: Bearer <token>
Accept: application/json
```

判定"这个 token 能用"的三个条件（缺一不可）：

1. `response.ok`
2. `typeof payload.code !== "number" || payload.code === 0`
3. `Array.isArray(payload.data.categories)`

**只看 `response.ok` 不够** —— 上游可能回 `200` 带业务错误码。

### 2.6 协议 B：生成

```ts
function generateWebCode(now = Date.now()) {
  return `${now}${randomBytes(16).toString("hex")}`;    // 13 + 32 = 45 字符
}

function webQrContent(session) {
  const url = new URL("/login/mp", ORIGIN);
  url.search = "";
  url.searchParams.set("code", session.code);
  url.searchParams.set("appname", "小浣熊官网");
  return url.href;
}
```

实测内容（**139 字节**）：

```
https://xiaohuanxiong.com/login/mp?code=1793936829945a37238b916ec7ca49c6b56406a4725b5&appname=%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91
```

**139 字节也是版本 8**（v7 = 122 不够）。

**code 用 `randomBytes` 而不是 `Math.random`** —— 它等同一次性口令，能换一个账号的完整登录态。

**格式校验**：`/^\d{13}[a-f0-9]{32}$/`（官方 asar 的 `qrStatus` 入口就是这个正则）。

### 2.7 协议 B：轮询

```
POST /api/web/auth/v1/login_with_qrcode_code
body: {"qrcode_code": "<45 字符>"}
```

成功：

```json
{"code": 0, "message": "success", "data": {"status": "success", "tokens": {"accessToken": "...", "refreshToken": "..."}}}
```

其它：

```json
{"code": 0, "data": {"status": "pending"}}
{"code": 0, "data": {"status": "logging", "expired_at": 1793937129}}
{"code": 0, "data": {"status": "canceled"}}
```

**关键事实（E-033）**：这个端点**无状态**。用一个乱编的合法格式 code（`1234567890123` + 32 × `a`）也是 `200 {"code":0,"data":{"status":"pending"}}`。

→ **不能靠它判断 code 有效**，所以 `qrProtocol` 必须是用户显式选择，不能自动探测（[ADR-0009](../02-design/adr/0009-web-auth-qr-protocol.md)）。

`expired_at` 若存在必须是 `Number.isSafeInteger && > 0`（秒），否则按 `INVALID_RESPONSE` 处理。

### 2.8 `GET /login/mp?...` 一律 404

无论 fresh / 过期 / garbage，都返回 6490–6572 字节的 Next.js HTML 骨架，状态码 404（E-003）。

**这个页面只能被微信打开**（靠 User-Agent / 微信 JSSDK 环境判断）。

→ 所以：
- 界面上**绝不能**提供"在浏览器打开登录页"的按钮
- 也不能靠这个端点判断码是否有效

---

## 3. 模型目录

```
GET /api/web/llm/v2/model_catalog
Authorization: Bearer <token>
Accept: application/json
X-Org-Code: <仅当 office_identity !== "personal" 才带>
```

实测 200，4537 字节（E-031）。

### 3.1 完整形状

```jsonc
{
  "code": 0,
  "message": "success",
  "data": {
    "categories": [
      {
        "type": "chat",                 // ← 只有 type，没有 key / name
        "default_model": "raccoon-090dd3",
        "models": [
          {
            "name": "sn-kimi-k3",                       // ← 这是 **id**
            "model_name": "sn-kimi-k3",                 // ← 也是 id
            "description": "Kimi-K3",                   // ← 这才是 **显示名**
            "display_description": "适合复杂办公任务、代码开发、调试和图像识别等任务",
            "visible": true,
            "billing_category": "normal",
            "ability_level": 2,
            "tags": ["general","office","code","vision","debug","analysis","html","reasoning"],
            "params": {                                  // ← context / max_tokens **嵌套在这里**
              "context_window": 1000000,
              "max_tokens": 100000
            },
            "billing_multiplier": 1,                     // ← 倍率
            "billing_effective_multiplier": 1,           // ← 实际生效倍率（优先取这个）
            "billing_status": "normal",                  // "normal" | "discount" | "limited_free"
            "billing_status_note": "",
            "billing_discounts": []
          }
        ]
      }
    ]
  }
}
```

### 3.2 实测模型表（2026-11-06，个人账号）

| id | 显示名 | visible | vision（tags） | 倍率 | ctx / max |
| --- | --- | --- | --- | --- | --- |
| `raccoon-090dd3` | Raccoon-Work | **false** | ✅ | 1 | 1e6 / 65536 |
| `raccoon-19b265` | — | **false** | ✗ | 1 | 1e6 / 65536 |
| `raccoon-405a1c` | — | **false** | ✗ | 1 | 1e6 / 65536 |
| `sn-sensenova-6-8-flash` | SenseNova-6.8-Flash | true | ✅ | 0.5 | 1e6 / 65536 |
| `sn-sensenova-6-8-flash-lite` | — | true | ✅ | 0.5 | 1e6 / 65536 |
| `sn-glm-5-3` | GLM-5-3 | true | **✗** | 0.75 | 1e6 / 65536 |
| `sn-kimi-k3` | Kimi-K3 | true | ✅ | 1 | 1e6 / 65536 |
| `sn-glm-5-3-flash` | GLM-5-3-Flash | true | ✅ | 0.2 | 1e6 / 65536 |
| `sn-deepseek-v4-1-flash-1017` | DeepSeek-V4.1-Flash | true | ✅ | 0.25 | 1e6 / 65536 |

**`visible: false` 的模型能调通** —— 实测 `raccoon-090dd3` 与 `sn-glm-5-3` 直接打 chat 都 200。但官方客户端不显示它们，我们也默认过滤（`includeHidden` 是内部开关，不进 UI）。

### 3.3 四条硬规矩

**规矩 1：`context_window` / `max_tokens` 在 `params` 里，不在顶层。**

早期解析器只读顶层 → 所有模型的 `contextWindow` 都拿不到，全部退到默认 128000。修复方式是 `pickNumberDeep()`：

```ts
pickNumber(obj, keys) ?? pickNumber(obj.params, keys) ?? pickNumber(obj.config, keys) ?? ...
```

**规矩 2：显示名在 `description`，`name` / `model_name` 都是 id。**

早期显示名候选表里没有 `description`，也没有裸 `name` 兜底，结果模型选择器里显示 `sn-kimi-k3` 这种 id。

正确顺序：

```
description → display_description → display_name → displayName → title → label → name → model_name → modelName ?? id
```

**规矩 3：倍率在 `billing_effective_multiplier` / `billing_multiplier`。**

不是 `multiplier`，也不是 `points_multiplier`。

**规矩 4：分组 key 取 `type`。**

分类对象只有 `{type: "chat", default_model: "..."}`，没有 `key` / `name`。

### 3.4 `vision` 标签诚实的程度

`sensenova` 插件的 fallback 名册里 `sn-glm-5-3` 是 `vision: false`，而本次实测 tags 里确实**没有 `vision`** —— 两边一致。

但历史上有过不一致（2026-09-18 别人实测 5 个模型错 2 个，两个方向都错）。所以：

- **默认按 tags 生成 descriptor**
- 提供一个「实测读图」按钮，让用户对某个模型发一张 3×3 纯红 PNG，看它能否说出"红"
- 结果落 `vision-probe.json`，覆盖目录标签
- 探测不确定（既不说红也说不看图）时**不写盘**

见 [ADR-0006](../02-design/adr/0006-vision-detection-by-probe.md)。

### 3.5 响应体不能截断

`dsh-raccoon-connect@0.2.2` 的 bug：把响应体截到 4096 字符，导致新模型永远显示不出来，症状是 UI 里出现 `[object Object]`。

本项目单测 CAT-3：200 个模型 > 4096 字符，断言**最后一个 `m-199` 完整**。

`truncate()` 只允许出现在日志与 `upstream` 字段里。

---

## 4. 对话（SSE）

```
POST /api/web/llm/v2/chat/completions
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer <token>
X-Org-Code: <条件性>
```

### 4.1 请求体

```jsonc
{
  "model": "sn-sensenova-6-8-flash",
  "messages": [ /* OpenAI 格式 */ ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 65536,
  "tools": [ /* OpenAI function calling */ ],
  "extra_body": {
    "thinking": { "type": "enabled" }    // 或 "disabled"
  },
  "reasoning_effort": "high"
}
```

**`max_tokens` 字段名必须是 `max_tokens`**，不是 `max_completion_tokens`。pi-ai 的 `detectCompat()` 对 `raccoon-web` + `xiaohuanxiong.com` 一个分支都不命中 → 默认 `max_completion_tokens`，必须在 `model.compat` 里显式覆盖。

**`extra_body` 是私有扩展**，pi-ai 的 `openai-completions` 不会发。我们通过 `onPayload` 钩子注入（[ADR-0007](../02-design/adr/0007-wrap-openai-completions-api.md)）。

### 4.2 思考控制：五变体 A/B 实测（E-035）

对 `sn-sensenova-6-8-flash` 发 `1+1=?只答数字`，`max_tokens: 48`：

| 变体 | reasoning 出现 | reasoning 字符数 | content |
| --- | --- | --- | --- |
| 基线（只 `authorization` + `content-type`） | 是 | 260 | **空**（token 被思考吃光） |
| `extra_body: {thinking:{type:"disabled"}}` | 是 | **81** | `"2"` ✅ |
| 顶层 `thinking: {type:"disabled"}` | 是 | 49 | `"2"` ✅ |
| `enable_thinking: false` | 是 | 389 | 空（**无效**） |
| `reasoning_effort: "none"` | 是 | 82 | `"2"` ✅ |

四条结论：

1. `extra_body.thinking` **确实生效**
2. 顶层 `thinking` 也生效（如果哪天想省掉 `extra_body`，改成 `compat.thinkingFormat` 分支就行）
3. `enable_thinking` 无效
4. **关了思考也还会回吐少量 `reasoning_content`**（81 字符）—— UI 不能拿"有没有 reasoning"当开关生效的判据，要看**字符数显著变短**

### 4.3 会话 id

```ts
function sessionIdFor(principal: string, model: string): string {
  const hex = createHash("sha256").update(`${principal}\0${model}`).digest("hex");
  return `sess-0-${hex.slice(0, 8)}`;
}
```

`principal` = JWT 的 `sub`。JWT 解不出来时用 `h:<sha256(token).slice(0,12)>`。

**只在 chat 请求带 `x-raccoon-session-id`。** catalog / balance / bills 不带。

理由（来自 `dsh-llm-adapters` 的注释，实测对得上）：官方客户端 26 分钟内 125 次调用都用同一个 `sess-0-53927d74`。每次请求新 id 会让网关看到"一个账号几分钟内开了几百个会话"。

**按模型定型**这点也重要：同一账号在同一模型上 id 稳定，换模型就换 id。所以 `x-raccoon-session-id` 烘进 `model.headers`（`chatModelHeaders()`），而不是运行时算。

### 4.4 SSE 帧

实测形状：

```
data: {"id":"...","object":"chat.completion.chunk","created":1793936829,"model":"sn-sensenova-6-8-flash","choices":[{"index":0,"delta":{"reasoning_content":"好的"},"finish_reason":null}],"request_id":"..."}

data: {"id":"...","choices":[{"index":0,"delta":{"content":"2"},"finish_reason":null}]}

data: {"id":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}

data: [DONE]
```

**三处与标准 OpenAI 不同**：

1. **思考在 `delta.reasoning_content`**（还可能有 `delta.reasoning`、`delta.reasoning_text` 两个别名）
2. **`usage` 与 `finish_reason` 在同一帧**（不是单独的 usage 帧）
3. **error 可能嵌在 200 的流里**，三种形状都要认：
   - A：`data: {"error": {...}}`
   - B：`data: {"code": 200429, "message": "user_model_rate_limited"}`
   - C：`choices[0].delta.error`

**帧解析必须宽松**：不认识的帧 / 非法 JSON / `42` / `null` → 返回 `null`，**绝不抛**。上游随时可能加新帧类型。

### 4.5 限流

**判定（任一命中）**：

```ts
const RATE_LIMIT_CODES = new Set([429, 200429]);
const RATE_LIMIT_WORDS = ["user_model_rate_limited", "rate_limit", "频率超限", "too many requests"];

function isRateLimited(status, text) {
  if (RATE_LIMIT_CODES.has(status)) return true;
  const lower = String(text).toLowerCase();
  return RATE_LIMIT_WORDS.some((w) => lower.includes(w));
}
```

**`200429` 必须在内** —— 上游限流有时是 `HTTP 200 + {"code":200429}`。只看 `status === 429` 会让用户看到"模型突然不说话"。

**用户文案**（原文，不许改写得"更友好"）：

> 小浣熊账号的模型吞吐已达上限（不是每分钟请求数，而是按账号的 token 速率）。一轮对话带的上下文越大越快撞到，撞到后额度按吞吐缓慢回血，上游也没有给恢复时间。稍等一会儿再发；把该模型的上下文窗口调小，同一会话能撑得更久。上游原文：`<detail>`

这段的价值在于**它解释了"为什么我才发了三条就被限流"** —— 真实原因是"三条里塞了 20 万 token 上下文"。

**`RATE_LIMIT` 不重试**（`retryableCodes` 里没有它）：按账号 token 速率限流，重试只延长冷却，且上游不给 `Retry-After`。

### 4.6 首字节超时

`FIRST_BYTE_TIMEOUT_MS = 60_000`。

实测一次正常对话首字节 **1637ms**。`dsh-raccoon-connect@0.2.4` 的 README 记了"首字节中位 1–2 秒，高峰有 60 秒以上无响应"。

没有这个超时，用户看到的是"一直在转圈"；有了它，60 秒就明确报错并可重试。

**注意**：真链路的 60s 首字节超时**目前不在 pi-ai 通路上生效**（`dsh-llm-pi-ai` 的 `profileOptions()` 不透传 `onPayload` 之外的钩子，也不支持首字节超时）。真正生效的是 `profile.streamIdleTimeoutMs = 300_000`（帧间 idle）。这是已知的差距，记在 `06-open-questions.md`。

### 4.7 图片

- 请求体上限 ~10 MB → 超了 `HTTP 413` → 归到 `INVALID_REQUEST`
- **像素预算下调到 640_000**（`IMAGE_PIXEL_BUDGET`）。默认预算会撞 10 MB 上限
- ⚠️ **仍缺实测**（E-018）：图片是否必须 base64 data URL，还是也接受 https URL

---

## 5. 积分

### 5.1 余额

```
GET /api/web/points/v1/balance
```

实测 200：

```json
{
  "code": 0,
  "data": {
    "available_points": 11700,
    "daily_points": 1200,
    "monthly_points": 0,
    "reward_points": 10500,
    "topup_points": 0,
    "enterprise_topup_points": 0,
    "total_chargeable_points": 11700,
    "enterprise_reserved": false,
    "topup_frozen": false,
    "owner_type": "users",
    "owner_id": 7865139
  }
}
```

取值顺序（服务端版本不同字段名不同）：

```
available = available_points ?? availablePoints ?? total_chargeable_points ?? total ?? balance ?? points
permanent = reward_points      // 永久积分
daily     = daily_points       // 每日积分
```

**缺值显示 `—` 而不是 `0`**。`0`（真的没积分）与"不知道"必须能区分。

缓存 60 秒 + inflight 去重。

### 5.2 流水

```
GET /api/web/points/v2/bills?paging.limit=50&type=all
```

实测 `data.items[0]`：

```json
{
  "group_id": "bill_994E...",
  "bill_count": 1,
  "bill_id": "bill_aee23883-...",
  "client_type": "web",
  "event_name": "每日积分发放",
  "biz_type": "daily_grant",
  "biz_id": "19099543",
  "points": 300,
  "created_at": "2026-11-06T09:20:25+08:00",
  "grant_at": "2026-11-06T00:00:00+08:00",
  "expire_at": "2026-11-12T23:59:59+08:00"
}
```

判断今日是否到账：找 `biz_type === "daily_grant"` 且**北京时区当天**的记录。

```ts
function raccoonDay(input): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(input));   // → "2026-11-06"
}
```

单测 PT-4 的边界：`2026-11-06T15:59:00Z` → `"2026-11-06"`；`16:00Z` → `"2026-11-07"`。

### 5.3 每日积分：只读，绝不代领

**没有独立的签到接口。** 每日积分由"当天首次带登录态访问网页"发放，通过 `setting_info` 的 `point_grant_popups` 公告。

重放 `setting_info` 能触发发放 —— 但那是**替用户改变账号状态**，而用户的授权是"看余额"，不是"替我领"。所以：

- 有今日记录 → 「今日每日积分已到账」+ 发放时间 + 数量
- 无今日记录 → 「今日每日积分未到账」，**不给按钮**
- 状态拿不到 → 「今日积分状态未知」

**UI 里不出现"签到"两个字**（这个产品没有这个概念）。

---

## 6. 账号信息

```
GET /api/web/auth/v1/user_info
Authorization: Bearer <token>
```

实测 200：

```json
{
  "code": 0,
  "data": {
    "nation_code": "86",
    "phone": "133****4004",
    "name": "RaccoonElizabeth",
    "id": "7865139",
    "email": "",
    "password_status": "set",
    "wechat_bound": false,
    "created_at": "2026-11-02T23:15:40.634765+08:00",
    "orgs": [],
    "pro_code_enabled": false
  }
}
```

`data.name` = 昵称，`data.id` = 数字 uid。

**官方还有一步 IAM 握手**：`code === 200901 && isIamToken(token) && endpoint === "user_info" && !confirmed` → 自动打一次 `iam/confirm` 再重试。

我们**不用这个端点** —— UI 显示账号用的是 JWT 的 `sub` 前 8 位（`pu-01a19…`）。少一次请求，也少一处可能拿到 PII 的地方。

---

## 7. 错误码总表

| 来源 | 码 | 含义 | kind | 可重试 | 用户文案 |
| --- | --- | --- | --- | --- | --- |
| HTTP | 401 `200001` | 没带 token | `AUTH` | ✗ | 小浣熊登录已失效，请重新扫码 |
| HTTP | 401 `200003` | token 无效/过期（**会话死亡码**） | `AUTH` | ✗ | 同上 |
| HTTP | 403 | 无权限 | `AUTH` | ✗ | 同上 |
| HTTP | 413 | 请求体过大 | `INVALID_REQUEST` | ✗ | 图片太大/数量太多 |
| HTTP | 429 | 限流 | `RATE_LIMIT` | ✗ | 见 §4.5 |
| HTTP | 5xx | 上游故障 | `SERVER` | ✅ | 小浣熊服务端出错了 |
| 流内 | `200429` | 限流（HTTP 200 里） | `RATE_LIMIT` | ✗ | 见 §4.5 |
| 流内 | 其它 `code !== 0` | 未知 | `SERVER` | ✅ | 带上游原文 |
| IAM | `AUTH_QRCODE_EXPIRED` | 二维码过期 | — | — | 二维码已过期，请刷新 |
| IAM | `AUTH_QRCODE_NOT_FOUND` | code 不存在 | — | — | 同上 |
| IAM | `AUTH_QRCODE_INVALID` | 用了另一套协议的 code | — | — | 两种码互不通用，检查协议设置 |
| Web | 业务码非 0 | 轮询失败 | — | — | 带上游原文 |
| 本地 | `TIMEOUT` | 请求超时 | `TIMEOUT` | ✅ | 网络超时，请重试 |
| 本地 | `NETWORK_ERROR` | 网络错误 | `TRANSPORT` | ✅ | 网络异常，请检查网络 |
| 本地 | `INVALID_RESPONSE` | 响应畸形 | `SERVER` | ✅ | 上游返回了无法识别的数据 |
| 本地 | `FIRST_BYTE_TIMEOUT` | 60s 无首字节 | `TIMEOUT` | ✅ | 上游 60 秒没有返回第一个字节 |

`DEAD_SESSION_CODES = new Set([200001, 200003])` —— 这两个是"token 真的不能用了"，其余 AUTH 类可能只是抖动。

**401 时不删 token 文件**。删了用户就得重扫，而多数 401 是瞬时的。

---

## 8. 请求头总表

| 头 | 值 | 哪些请求 |
| --- | --- | --- |
| `authorization` | `Bearer <token>` | IAM 之外全部 |
| `content-type` | `application/json` | POST |
| `accept` | `application/json` / `text/event-stream` | 按端点 |
| `x-org-code` | `""`（空串，**必须存在**）或 office identity | web API |
| `x-raccoon-language` | `zh`（`iam/confirm` 用 `zh-CN`） | 全部 |
| `x-client-platform` | `desktop-windows` \| `desktop-macos` \| `desktop-linux` | web API |
| `x-client-version` | `v1.0.35` | web API |
| `x-raccoon-session-id` | `sess-0-<8hex>` | **仅** chat |

### 官方到底发什么（E-034）

从 `app.asar` 里搜出来的事实：

- 官方 LLM 请求头**只有** `Authorization` + 条件性的 `X-Org-Code`
- `X-Org-Code` 只在 `office_identity !== "personal"` 时发
- **`x-raccoon-language` / `x-client-version` / `x-client-platform` 在 asar 里零命中**

实测带上这三个头也不影响（全部 200，无可观测差异）。**保留的理由**：`dsh-llm-adapters` 用它跑通了很久；去掉要重测一轮，收益只是"少三个头"。

`clientPlatform()` 由 `process.platform` 决定：

```ts
darwin → "desktop-macos"
linux  → "desktop-linux"
其它   → "desktop-windows"
```

---

## 9. 官方登录的另两条路（未实现，记下备查）

### 9.1 授权码深链

```
https://<login-host>/authorize?login_source=desktop&appname=办公小浣熊客户端
   ↓ 用户登录后跳回
office-raccoon://auth/callback?code=<授权码>
   ↓
POST /api/web/auth/v1/login_with_authorization_code {code}
```

业务码 **`200035` = 授权码不存在/过期/已消费**。

需要注册自定义协议处理器 —— 我们做不到（插件没有那个能力），所以不实现。

### 9.2 浏览器登录 + loopback 回调

`createWebLogin`，`mode: "loopback"`，`appname` 随语言变（`webLoginResources[lang].appName`）。

同样需要起一个本地回调服务器并让浏览器信任它。比扫码多三个失败点，不做。

---

## 10. 仍缺的实测

| # | 问题 | 验证方法 | 优先级 |
| --- | --- | --- | --- |
| **E-018** | 图片必须 base64 data URL，还是也接受 https URL | 两种各发一次 | P1 |
| **E-019** | `413` 的确切阈值（10 MB？含 base64 膨胀？） | 逐步加大图片直到 413 | P1 |
| E-036 | SSE error 帧的真实形状（真的撞一次限流） | 用超大上下文触发 | P2 |
| E-037 | `v1.0.35` 版本号是否被校验 | 改成不存在的版本打一次 | P2 |
| E-038 | `x-raccoon-session-id` 到底影响什么 | 同对话用不同 id 看是否更早限流 | P2 |
| E-039 | 桌面端凭据过期后客户端怎么续（我们能否搭车） | 等 12-04 观察客户端行为 | P2 |

---

## 11. 相关文档

- 全部实测记录：[05-empirical-findings.md](./05-empirical-findings.md)
- 未解问题：[06-open-questions.md](./06-open-questions.md)
- 错误模型与文案：[05-error-model](../02-design/05-error-model.md)
- 双协议决策：[ADR-0009](../02-design/adr/0009-web-auth-qr-protocol.md)
- 凭据来源决策：[ADR-0008](../02-design/adr/0008-desktop-credential-reuse.md)
