# 数据流

最后更新: 2026-11-06（按实现回填，含桌面端凭据与双扫码协议）
状态: 已定稿

> 一句话：**读凭据 → 拉目录 → 注册名册 → 发对话，四条链路；每条都在失败点有明确的降级路径。**

---

## 1. 冷启动（插件加载 → 可用）

```
DSH 启动 / cordis 装载 llm-raccoon-web
   │
   │  import(lib/index.js)        ← name 是 file:// URL（见 dev-environment §3.4）
   ▼
apply(ctx)                       ← 必须同步返回
   │
   ├── createLogger(ctx.logger)
   ├── ctx.inject(["settings"], sub => {
   │      const settings = registerSettings(sub.settings)   ← ns: dsh-raccoon-web
   │      const host = new RaccoonHost({...})
   │      const unwatch = settings.watch(onChange)
   │      sub.effect(() => () => { unwatch(); host.dispose() }, "...: host")
   │      void host.bootstrap()                             ← fire & forget
   │      sub.inject(["webServer"], web => web.effect(() => host.mount(web.webServer)))
   │   })
   ▼
bootstrap()
   │
   ├── storedToken = await readToken()          ← $DSH_HOME/state/dsh-raccoon-web/token.json
   ├── probes = await readProbes()
   ├── await resolveToken("bootstrap")          ← 见 §2
   ├── syncPublisher()                          ← 三元门控，可能注册 fallback 名册
   ├── if (token) {
   │      await refreshCatalog({ force: false })   ← TtlCache 5min
   │      await refreshQuota({ force: false })     ← TtlCache 60s
   │      syncPublisher()                          ← 名册变了才重新发布
   │   }
   └── 全程 try/catch，任何一步失败都只 logger.warn，不抛
   ▼
可用（status 端点 200，models 非空）
```

**关键约束**：`apply()` 里不能有 `await`。DSH 的插件加载是同步链，`await` 会让整棵树卡在 pending。

**失败降级**：

| 失败点 | 结果 |
| --- | --- |
| 读 token 抛 | `readToken()` 内部 catch，返回 `undefined` |
| 桌面端凭据读不到 | `desktopStatus = {found:false, reason:"未找到桌面客户端登录态，已回退到扫码"}` |
| catalog 401 | 清缓存、`loginFlow.markDead()`、**不删 token** |
| catalog 网络错 | `catalog.error` 记文案，`models` 退到 fallback |

---

## 2. 凭据解析（`resolveToken`）

```
resolveToken(reason)
   │
   ├── source = settings.authSource        ← "auto" | "desktop" | "qr"
   ├── wantDesktop = (source !== "qr") && !desktopIgnored
   │
   ├── if (wantDesktop) {
   │      auth = await readDesktopAuth({ home, now })     ← 永不抛
   │      ├── 读到 && 未过期（留 60s 余量）
   │      │      token = {...auth, source: "desktop"}
   │      │      loginFlow.markReady()                    ← phase = "ready"
   │      │      logger.info("token/desktop", {token: tokenTag, path, exp, reason})
   │      │      return                                    ← 不落盘！
   │      └── 读到但过期
   │             desktopStatus = {found:true, expiresAt, reason:"登录态已过期"}
   │             logger.warn("token/desktop-expired")
   │             if (source === "desktop") { token = undefined; return }   ← 严格模式不回落
   │             ↓ 继续往下（auto 才回落）
   │   }
   │
   ├── if (storedToken) {
   │      token = storedToken
   │      loginFlow.markReady()
   │      logger.info("token/qr", {token: tokenTag})
   │   }
   └── else token = undefined, phase 保持 none
```

`desktopIgnored = true` 的三个触发点：

1. 用户扫码成功（`onReady` 回调里）—— 扫码是明确选择，覆盖桌面端
2. 用户点「退出登录」（`actionLogout`）而当时用的是桌面端凭据
3. 无（`refresh-auth` 会把它重置回 `false`）

**桌面端凭据不落盘**的理由：客户端换账号我们下次启动自然跟着变，不需要同步逻辑。

---

## 3. 扫码登录（两条协议共用一个状态机）

```
none
 │  POST ?action=login-start
 ▼
start()
 ├── cancel()                          ← 作废在途会话（**这就是"刚生成的码立刻失效"的根因**）
 ├── protocol = settings.qrProtocol    ← 每轮重读，支持中途切换
 │
 ├── protocol === "web"  （默认）
 │     session = createWebSession()    ← **纯本地，不发网络请求**
 │     code = `${Date.now()}${randomBytes(16).hex}`   （45 字符）
 │     content = webQrContent(session)  → appname=小浣熊官网
 │
 └── protocol === "iam"
       session = await createQr()      ← POST /api/iam/v1/auth/mp/qrcode
       code = session.code             （qr-01a1...）
       content = qrContent(session)     → appname=商汤小浣熊
 ▼
qrSvg = renderQrSvg(content)            ← 本地编码，v8（139 或 149 字节）
phase = "pending"
deadline = now + min(expiresIn, 330s) * 1000
schedule(pollInterval * 1000)
 ▼
tick(generation)
 ├── generation 不匹配 → 直接 return（丢弃过期回调）
 ├── now > deadline    → phase = "expired"
 │
 ├── protocol === "web" → pollWebSession(code)   POST /api/web/auth/v1/login_with_qrcode_code
 └── protocol === "iam" → pollQr(code)           POST /api/iam/v1/auth/mp/qrcode/login
 │
 ├── 网络错误 / TIMEOUT / 非 JSON  → **当 pending 继续排**（不能因抖动杀登录）
 ├── pending   → 保持，文案"等待扫码"
 ├── logging   → 保持，文案"已扫码，请在手机上确认"（**区分很重要，否则用户会重扫打断**）
 ├── canceled  → phase = "expired"
 ├── expired   → phase = "expired"
 └── success
       ├── protocol === "web"：token = accessToken（IAM JWT）
       └── protocol === "iam"：cookie = await confirmSession(accessToken)  ← 失败不致命
                              token = cookie ?? accessToken
       ▼
     validateToken(token)             ← GET model_catalog，要求 data.categories 是数组
       ├── 不过 → message = "小浣熊账号已授权，但模型网关拒绝了这次登录令牌。请重新扫码…"
       └── 过   → saveToken({...})    ← 只对来源 qr 落盘
                  phase = "ready"
                  onReady(token) → host.setToken() + desktopIgnored = true + refreshCatalog
```

**`deadline` 每次轮询成功都按返回到 `expiresIn` 重置** —— 服务端会自己续期。

**为什么 `web` 协议不发网络请求**：code 是本地生成的，二维码内容就是纯本地拼的字符串。少一次往返，也就少一个失败点。

---

## 4. 目录刷新与名册发布

```
refreshCatalog({ force })
   │
   ├── catalogCache.get(force)         ← TtlCache 5min，inflight 去重
   │      load → fetchCatalog(token)
   │        ├── 401 / 403 / isDeadSessionCode(200001|200003) → throw RaccoonError("AUTH")
   │        ├── isRateLimited → throw RaccoonError("RATE_LIMIT")
   │        └── 200 → parseCatalog(payload, { includeHidden: false })
   │                 ├── 分组 key 取 categories[].type
   │                 ├── 显示名取 description
   │                 ├── 倍率取 billing_effective_multiplier ?? billing_multiplier
   │                 ├── context/maxOutput 用 pickNumberDeep（params 嵌套）
   │                 ├── visible === false → 过滤
   │                 └── 空目录 → throw RaccoonError("SERVER", "小浣熊返回的模型目录为空")
   ▼
toDescriptors(models, { contextCap, visionProbe: probes, sessionIdFor })
   │   contextWindow = min(upstream, contextCap)
   │   maxTokens     = min(maxOutput, contextWindow / 2)
   │   headers       = chatModelHeaders(sessionId)   （按模型定型）
   ▼
catalog = { models, descriptors, ready: true }
   ▼
syncPublisher()
   │
   ├── signature = rosterSignature(descriptors)
   ├── signature === lastSignature → 什么都不做（**这条很重要，不然每次轮询都换实例**）
   ├── !enabled         → releaseHandle() → "disabled"
   ├── !token || 空名册  → releaseHandle() → "not-configured"
   └── 否则
         assembled = assembleAdapter({ resolveToken, models, displayName, reasoningEnabled })
         releaseHandle("publish/replace")        ← 先释放
         handle = llm.registerAdapter(assembled.providerIds, assembled.adapter)   ← 再注册
         lastSignature = signature
         → "published"
```

**释放与注册必须在同一个同步段**，中间不能 `await`，否则 DSH 的监听者会看到 provider 短暂消失。

**AUTH 错误不删 token**：401 可能只是抖动。要等服务端明确回 `200003`（会话死亡码），或者用户主动重新登录。

---

## 5. 流式对话

```
DSH 发一轮请求
   │
   ▼
PiAiAdapter.streamWithSnapshot()
   ├── profileOf(provider)     ← 找不到 → LlmError("NO_ADAPTER")
   ├── modelOf(model)          ← 找不到 → LlmError("UNKNOWN_MODEL")
   └── adapter.stream({ provider, model, messages, maxTokens, ... })
   ▼
pi-ai 的 models.js → provider.stream(model, context, options)
   ├── applyAuth()  → apiKey = options.apiKey ?? auth.apiKey
   │     ↑ 我们的 auth.apiKey.resolve() 返回 { auth: { apiKey: token } }
   │        恒返回 undefined 会抛 "Provider is not configured"（已修）
   ▼
provider/api.ts 的 wrap("stream")
   └── inner.stream(model, context, { ...options, onPayload })
   ▼
pi-ai 的 openai-completions.js
   ├── createClient({ apiKey, baseURL: LLM_BASE, defaultHeaders: {"User-Agent", ...model.headers} })
   ├── buildParams()  → { model, messages, stream:true, stream_options:{include_usage:true}, max_tokens, ... }
   │     ├── compat.maxTokensField === "max_tokens"     ← 我们显式覆盖了
   │     ├── compat.supportsDeveloperRole === false     ← 我们显式覆盖了
   │     └── thinking 走 OpenAI 式 reasoning_effort（**不会发 extra_body**）
   ├── onPayload(params)  ← 我们的钩子
   │     └── applyThinking(params, effort)
   │           off/none → params.extra_body = { thinking: { type: "disabled" } }
   │                       （none 再加 params.reasoning_effort = "none"）
   │           其它     → params.extra_body = { thinking: { type: "enabled" } }
   │                       （非 "on" 时加 params.reasoning_effort = effort）
   ▼
POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions
   headers: authorization / x-org-code / x-raccoon-language / x-client-platform / x-client-version / x-raccoon-session-id
   ▼
SSE 帧（text/event-stream）
   data: {"choices":[{"delta":{"reasoning_content":"..."}}],"usage":null}
   data: {"choices":[{"delta":{"content":"2"}}]}
   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
   data: [DONE]
   ▼
pi-ai 解析（`reasoningFields = ["reasoning_content","reasoning","reasoning_text"]` 原生支持）
   ├── reasoning → thinking_start / thinking_delta / thinking_end
   ├── content   → text_start / text_delta / text_end
   ├── tool_calls→ toolcall_start / toolcall_delta / toolcall_end（index 累积）
   └── 结束      → { type: "done", reason: stopReason, message }
   ▼
dsh-llm-pi-ai 的 toStreamChunks()
   reasoning-delta → { type: "reasoning-delta", index, text }
   text-delta      → { type: "text-delta", index, text }
   done            → usage 事件 + finish 事件
   error           → usage + finish{kind:"error", failure:{code: classifyPiAiError(msg)}}
   ▼
DSH 界面渲染（思考区 + 正文）
```

**实测一次正常对话**（`npm run smoke:chat`）：

```
block-start → reasoning-delta ×27 → block-start → text-delta → block-end ×2 → usage → finish
首字节 1637ms / 思考 324 字 / 正文 "2" / finish {"kind":"stop"}
```

### 帧翻译表

| 上游 SSE 字段 | `RaccoonFrame` | pi-ai 事件 | DSH 事件 |
| --- | --- | --- | --- |
| `delta.content` | `text` | `text_delta` | `text-delta` |
| `delta.reasoning_content`（含 `reasoning` / `reasoning_text`） | `reasoning` | `thinking_delta` | `reasoning-delta` |
| `delta.tool_calls[i]` | `toolCall.{index,id,name,argumentsDelta}` | `toolcall_delta` | `tool-call-delta` |
| `usage` | `usage.{input,output,total}` | — | `usage` |
| `finish_reason` | `finishReason` | `done` | `finish` |
| `data: [DONE]` | `finishReason: "stop"` | 结束 | — |
| 带 `error` / `code !== 0` | `error.{message,code,rateLimited}` | — | `finish{kind:"error"}` |

**注意**：我们自己的 `parseFrame`（在 `protocol/chat.ts` 里）只在 `smoke-chat-live.mjs` 与单测里用；**真实链路走的是 pi-ai 的解析器**，不经过我们的。这是 ADR-0007 的直接结果。

---

## 6. 超时与重试

```
applyThinking 之前
   └──（没有超时，纯同步）

pi-ai 的 fetch
   ├── 首字节 60s：由 pi-ai 的 timeoutMs? 不，由我们…… 见下
   └── 帧间 120s：由 dsh-llm-pi-ai 的 idleWatchdog 管（streamIdleTimeoutMs = 300s）
```

**实际情况**（照实写，别照设计文档写）：

| 超时 | 归谁管 | 值 |
| --- | --- | --- |
| 首字节 | `protocol/chat.ts` 的 `chatStream`（**只在 smoke / 单测走**）；真链路由 pi-ai 默认（无首字节超时） | 60_000 |
| 帧间 idle | `dsh-llm-pi-ai` 的 `idleWatchdog` | `profile.streamIdleTimeoutMs` = 300_000 |
| 流内无终态 | `dsh-llm-pi-ai` 抛 `LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED")` | — |

**重试**（`providerRetryPolicy`）：

```ts
{ mode:"normal", maxRetries:2,
  retryableCodes: ["EMPTY_RESPONSE","SERVER","TIMEOUT","TRANSPORT"],
  backoff: { initialDelayMs:1500, maxDelayMs:10000, jitterRatio:0.25 } }
```

**`RATE_LIMIT` 不在列表里** —— 按账号 token 速率限流，重试只延长冷却，且上游不给 `Retry-After`。

**错误分类**由 `dsh-llm-pi-ai/lib/index.js:1448` 的 `classifyPiAiError()` 按 `errorMessage` 正则做。所以我们的中文文案里**不能出现 `400`、`timeout`、`rate limit`** 这类词。

---

## 7. 积分查询

```
refreshQuota({ force })
   │
   ├── quotaCache.get(force)            ← TtlCache 60s，inflight 去重
   │      load → loadQuota()
   │        ├── balance = await fetchBalance(token)
   │        │     available = available_points ?? availablePoints
   │        │             ?? total_chargeable_points ?? total ?? balance ?? points
   │        │     permanent = reward_points
   │        │     daily     = daily_points
   │        ├── bills = await fetchBills(token, 50)    ← 失败不影响余额
   │        └── dailyGranted = todayGranted(bills, now)
   │              bills 里找 biz_type === "daily_grant" 且 raccoonDay(grant_at) === 今天
   ▼
quota = { available, permanent, daily, dailyGranted, at, error? }
```

`raccoonDay()` 用 `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year/month/day: "2-digit" })`。

单测 PT-4：`raccoonDay("2026-11-06T15:59:00Z") === "2026-11-06"`，`16:00Z → "2026-11-07"`。

**只读，不代领。**

---

## 8. 识图探测

```
POST ?action=probe-vision {"model":"sn-glm-5-3"}
   │
   ├── chatStream(token, {
   │      model,
   │      max_tokens: 24,
   │      messages: [{ role:"user", content: [
   │         { type:"text", text:"这张图是什么颜色？只回答一个词" },
   │         { type:"image_url", image_url:{ url: "data:image/png;base64,<3×3 纯红>" } }
   │      ]}]
   │   }) → applyThinking(body, "off")     ← 关思考，省 token
   ▼
judgeVision(answer)
   ├── /红|red|#?(ed1c24|ff0000)/i        → true
   ├── /看不到|看不见|无法|不能|cannot|can't|no image|not able/i → false
   └── 其它                              → null（不确定，不写盘）
   ▼
recordProbe({ modelId, supported, at })    ← 只写 true/false，null 不落盘
syncPublisher()                             ← 名册的 input 变了要换实例
```

**为什么用 3×3 纯色不用文字图**：文字图会把"OCR 不行"误判成"看不到图"。

---

## 9. 设置变更的传播

```
用户在设置卡改一项
   │  POST ?action=set-setting {"key":"contextCap","value":64000}
   ▼
actionSetSetting()
   ├── normalizeSettings({ ...current, [key]: value })   ← 白名单 + 区间校验
   ├── settings.update(patch)                            ← 落 settings-legacy.yaml
   └── 特判
        ├── key === "authSource" → actionRefreshAuth()   ← 重跑凭据解析
        └── 其它                  → refreshCatalog({force:true}) + syncPublisher()
   ▼
settings.watch 回调（内核通知，可能是自己触发的）
   ├── debugLog 变 → logger.setDebug()
   └── enabled / reasoning / contextCap 变 → void runAction("refresh-catalog")
```

**为什么 `contextCap` 要触发 `refresh-catalog`**：名册里的 `contextWindow` / `maxTokens` 是它在 `toDescriptor` 时算的，改了 cap 必须重算并重新注册。

**为什么 `set-setting` 里还显式 `syncPublisher()`**：`refreshCatalog` 只更新 `this.catalog`，不负责发布。**这条踩过** —— 症状是设置卡显示 64000 而模型选择器背后还是 128000。

---

## 10. 卸载

```
DSH 卸载插件 / cordis 释放节点
   │
   ▼
sub.effect 的 disposer 依次执行
   ├── unwatch()              ← settings.watch 的订阅
   ├── host.dispose()
   │     ├── loginFlow.dispose()      ← 清定时器
   │     ├── publisher.dispose("unload") → releaseHandle() → llm 注销 adapter
   │     ├── routes 的 disposer       ← webServer 路由下线
   │     └── disposed = true（幂等）
   └── settings.register 的 disposer（内核自己管）
```

**必须幂等**：`Publisher.releaseHandle()` 会被 `dispose()` 与换名册两条路径调用，重复注销要 catch 掉。

**不删 token 文件**（重装不用重新登录）。

---

## 11. 四个时序坑（都真实发生过）

1. **登录成功但 adapter 没注册** —— `onReady` 里必须先 `setToken()` 再 `refreshCatalog()`，否则 `syncPublisher()` 看到 `token === undefined` 会释放注册。
2. **快速连点扫码** —— `start()` 里的 `cancel()` 会作废旧码。`generation` 自增保证旧 tick 不会污染新会话。
3. **边扫码边对话** —— 扫码成功瞬间 token 换了，在途对话用的还是旧 token。目前不处理（旧 token 在其 `exp` 前仍有效）。
4. **卸载时在途 fetch** —— `LoginFlow.dispose()` 清定时器，在途 fetch 由 `AbortSignal` 自然结束；`fetch` 的 reject 被 `tick()` 的 catch 吞掉。

---

## 12. 相关文档

- 模块职责：[01-module-map](./01-module-map.md)
- 存储细节：[03-state-and-storage](./03-state-and-storage.md)
- 错误模型：[05-error-model](./05-error-model.md)
- 思考通道决策：[ADR-0007](./adr/0007-wrap-openai-completions-api.md)
- 凭据来源决策：[ADR-0008](./adr/0008-desktop-credential-reuse.md)
- 扫码协议决策：[ADR-0009](./adr/0009-web-auth-qr-protocol.md)
