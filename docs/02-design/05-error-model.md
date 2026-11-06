# 错误模型与重试

最后更新: 2026-11-06
状态: 已定稿

> 三条规矩：
> ① 每个错误有 `kind`（程序看）和 `hint`（人看）。
> ② 决定"重不重试"的只有 `kind`，不看 HTTP 状态码。
> ③ 用户看到的文案必须包含**下一步做什么**。

---

## 1. 错误类别

```ts
export type RaccoonErrorKind =
  | "AUTH"              // 未登录 / token 失效
  | "RATE_LIMIT"        // 限流
  | "SERVER"            // 上游 5xx / 响应畸形
  | "TIMEOUT"           // 本地超时 / 首字节超时
  | "TRANSPORT"         // 网络错误
  | "INVALID_REQUEST"   // 请求本身有问题（413、400）
  | "ABORTED";          // 用户取消
```

对应 DSH / pi-ai 的错误类别：

| `kind` | pi-ai `code` | 可重试 |
| --- | --- | --- |
| `AUTH` | `AUTH` | ❌ |
| `RATE_LIMIT` | `RATE_LIMIT` | ⚠️ 有条件（见 §3） |
| `SERVER` | `SERVER` | ✅ |
| `TIMEOUT` | `TIMEOUT` | ✅ |
| `TRANSPORT` | `TRANSPORT` | ✅ |
| `INVALID_REQUEST` | `INVALID_REQUEST` | ❌ |
| `ABORTED` | — | ❌ |

---

## 2. 每个 `kind` 的判定与文案

### 2.1 `AUTH`

**判定**：

```ts
status === 401 || status === 403 || payload.code === 200001 || payload.code === 200003
```

`200003` 还要额外做一件事：`clearCache()` + 标记 session dead。

**文案**：

> 小浣熊登录已失效，请在设置 → 插件 → 小浣熊 里重新扫码。

**别写**"未授权"、"Authentication failed"、"请检查 API Key" —— 这个插件没有 API Key，只有扫码。

### 2.2 `RATE_LIMIT`

**判定**：见 [03-raccoon-protocol.md §3.4](../01-research/03-raccoon-protocol.md)。

**文案**（原文照抄，这是本项目最长的一条文案，也是最有用的一条）：

> 小浣熊账号的模型吞吐已达上限（不是每分钟请求数，而是按账号的 token 速率）。一轮对话带的上下文越大越快撞到，撞到后额度按吞吐缓慢回血，上游也没有给恢复时间。稍等一会儿再发；把该模型的上下文窗口调小，同一会话能撑得更久。上游原文：`<detail>`

**为什么这么长**：用户第一反应永远是"我才发了几条"。这条文案直接回答"为什么"（token 速率）、"会怎样"（缓慢回血）、"怎么办"（等 / 调小上下文）。

### 2.3 `SERVER`

**判定**：`status >= 500`，或响应体解析失败，或 `code` 是未知的非零值。

**文案**：

> 小浣熊上游返回了错误（HTTP `<status>`）。这通常是临时的，已经自动重试。如果持续出现，请把诊断信息反馈。上游原文：`<detail>`

**别写**"服务器错误" —— 用户不知道是哪台服务器。

### 2.4 `TIMEOUT`

**两个来源**：

| 来源 | 触发 | 文案 |
| --- | --- | --- |
| 首字节 | 60 秒内没收到第一个 chunk | 小浣熊 60 秒内没有返回第一个字节。高峰期常见，已自动重试一次；如果反复出现，换一个模型试试。 |
| idle | 两个 chunk 之间超过 120 秒 | 回复中断：小浣熊已经 2 分钟没有推送新内容。 |

**首字节超时是最重要的一条** —— `dsh-raccoon-connect@0.2.4` 加它就是因为它实测遇到"高峰有 60s+ 无响应"。没有它，用户看到十分钟的空转。

### 2.5 `TRANSPORT`

**判定**：`fetch` 抛且不是 abort。

**文案**：

> 连不上小浣熊（网络错误）。检查网络或代理设置后重试。原始错误：`<message>`

### 2.6 `INVALID_REQUEST`

**判定**：`status === 413` 或 `400`。

413 的文案要具体：

> 请求体太大（HTTP 413）。图片会按 640 000 像素压缩，但如果一次发了多张大图仍可能超限。减少图片数量或换小一点的图。

### 2.7 `ABORTED`

**判定**：`AbortError` 且不是我们的超时定时器触发的。

**不显示错误**。用户自己取消的，不该弹提示。

---

## 3. 重试策略

### 3.1 实现

```ts
adapter.providerRetryPolicy = (provider) => resolveRetryPolicy({
  mode: "normal",
  maxRetries: 2,
  retryableCodes: ["SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"],
  backoff: { initialDelayMs: 1500, maxDelayMs: 10_000, jitterRatio: 0.25 },
}, provider);
```

### 3.2 与参考实现的差异

| 项 | sensenova | 本项目 | 为什么 |
| --- | --- | --- | --- |
| `maxRetries` | 8 | **2** | 浣熊是共享积分池，8 次重试 = 8 次扣额度（失败也算？至少 8 次撞限流）。2 次足够覆盖网络抖动 |
| `RATE_LIMIT` 在 `retryableCodes` | ✅ | **❌** | 见下面 |
| `backoff.maxDelayMs` | 20 000 | **10 000** | 2 次重试，最长等 1.5s + 10s = 11.5s，用户还能忍 |

### 3.3 为什么 `RATE_LIMIT` 不自动重试

浣熊的限流是**按账号 token 速率**的，不是按请求数。这意味着：

- 撞到限流的那一刻，账号的吞吐已经饱和
- 重试只会**再消耗一次计数**，让恢复更慢
- 上游没有给 `Retry-After`，我们不知道什么时候能恢复

所以：**RATE_LIMIT 直接抛给用户**，让用户决定等多久。这比"自动重试 8 次然后失败"好 —— 后者会让用户等 2 分钟，还多撞 8 次。

> **唯一例外**：`streamFirstByteTimeout` 之后的 429。此时请求可能根本没到上游（连接层的限流），重试一次是安全的。这个区分太细，先不做，登记为已知限制。

### 3.4 `EMPTY_RESPONSE`

首字节到了，但整个流没有任何 `delta.content` 也没有 `delta.reasoning_content` 也没有 `tool_calls`。

这是可重试的（上游偶尔会返回一个空流）。但**最多重试一次**：

```ts
if (emptyStream && attempt < 1) { retry(); }
else if (emptyStream) { throw new RaccoonError("SERVER", "小浣熊返回了空回复。换一个模型或稍后重试。"); }
```

### 3.5 重试的可观测性

开 `debugLog` 时每次重试打一行：

```
[raccoon-web] retry 1/2 after TIMEOUT (waited 1523ms): first byte timeout
```

用户报障时，"重试了几次、什么原因"是最关键的信息。

---

## 4. 不该出现的错误

这些是**我们的 bug**，不该让用户看到：

| 症状 | 真实原因 | 预防 |
| --- | --- | --- |
| `[object Object]` 出现在模型列表 | 响应体被截断后 `JSON.parse` 失败，错误对象被 `String()` | 解析路径不截断；错误信息用 `err.message` 不用 `String(err)` |
| `DUPLICATE_ADAPTER` | 重复 `registerAdapter` | `publish.ts` 里先 `unpublish()` 再 `publish()` |
| `INVALID_ADAPTER` | `providerInfo` 返回的 `id` 与注册名不一致 | `PROVIDER_ID` 常量只在一处定义 |
| 设置卡空白 | 路由 404（`webServer` 没起来） | status 端点返回 `{webServer:false}`，UI 显示"设置不可用" |
| 二维码扫不出来 | 版本信息块没写（版本 ≥ 7 必需） | 单元测试：版本 7 的矩阵必须含 18 bit 版本信息 |

---

## 5. 错误日志格式

```ts
function logError(ctx, err: RaccoonError, phase: string): void {
  ctx.logger?.error(
    `[raccoon-web] ${phase} ${err.kind} status=${err.status ?? "-"} ` +
    `msg=${JSON.stringify(err.message)} upstream=${JSON.stringify(truncate(err.upstream, 512))}`,
  );
}
```

**只截断日志，不截断解析。** `truncate(s, 512)` 只用于 `upstream` 字段。

**不打印 token。** 任何日志里都不能出现 token 全文。要打印就打 `sha256(token).slice(0, 8)`。

---

## 6. 用户可见 vs 仅日志

| 内容 | 去哪 |
| --- | --- |
| `kind` 对应的中文文案 | UI |
| `hint`（下一步做什么） | UI |
| 上游原文（`upstream`） | 日志；`SERVER`/`RATE_LIMIT` 时截断后进 UI |
| HTTP 状态码 | 日志；`SERVER` 时进 UI |
| token | **哪都不去** |
| 请求体 | 日志（debugLog 时） |
| 响应帧 | 日志（debugLog 时，截断到 200 字符） |

---

## 7. 断线重连

**不做自动重连。** 流断了就断了，让用户重发。

理由：浣熊的流没有 `Last-Event-ID` 之类的续传机制。自动重连会重发整个请求 → 撞限流 → 更糟。

DSH 自己的"重试"按钮会重新发请求，这就够了。
