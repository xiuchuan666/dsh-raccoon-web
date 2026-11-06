# ADR-0007 · 思考通道改用「包装 openAICompletionsApi + onPayload 注入」

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- Supersedes: [ADR-0003](./0003-reasoning-channel.md)
- 相关: [E-010](../01-research/05-empirical-findings.md)、[E-020](../01-research/05-empirical-findings.md)

---

## 背景

ADR-0003 的结论是"自己写一个 pi-ai 的 `Api`，复刻 `openai-completions` 的事件协议，在里面塞 `extra_body.thinking`、解析 `delta.reasoning_content`、自己实现首字节 60s 超时"。

那份 ADR 里明确写了：「**如果反推 `Api` 接口的成本过高**，降级方案：退回 `openAICompletionsApi()`，把 `reasoning: false` 写进 descriptor」。

写实现的时候把 `Api` 接口反推出来了，同时发现三件 ADR-0003 当时不知道的事：

1. `Api` 的真实形状是 `{ stream(model, context, options), streamSimple(model, context, options) }`，**两者都必须同步返回 `AssistantMessageEventStream`**（一个用 `.push(event)` / `.end(message)` 驱动的 EventStream 对象），**不是 async generator**。ADR-0003 里写的 `async *stream(params) { ... yield ... }` 形状是错的。
2. `openai-completions.js:397-420` **已经原生支持** `delta.reasoning_content`：

   ```js
   const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
   ```

   命中就 `ensureThinkingBlock(thinkingSignature)` → `block.thinking += delta` → push `{type:"thinking_delta", contentIndex, delta, partial}`。**思考内容的解析完全不用自己写。**
3. `openai-completions.js:188-191` 留了一个改请求体的钩子：

   ```js
   const nextParams = await options?.onPayload?.(params, model);
   if (nextParams !== undefined) params = nextParams;
   ```

   这是**在 `buildParams` 之后、发请求之前**，所以在这里追加 `extra_body` 一定生效。

唯一的麻烦是：`dsh-llm-pi-ai` 的 `profileOptions()`（`lib/index.js:1754-1767`）**不透传 `onPayload`** —— 它只给 `apiKey / reasoning / thinkingBudgets / cacheRetention / transport / timeoutMs / websocketConnectTimeoutMs / maxRetries:0`。所以我们拿不到内核那条通路，只能在**自己的 `Api` 包装层**里注入。

也就是：我们不写 SSE 状态机，只写一层 20 行的 `onPayload` 注入。

---

## 决策

**包装 `openAICompletionsApi()`，在注入的 `onPayload` 里追加 `extra_body.thinking`。**

`/dsh小浣熊反代开发/packages/dsh-raccoon-web/src/provider/api.ts`：

```ts
export function createRaccoonApi(
  reasoningEffortOf?: (model: unknown) => string | undefined,
): ApiLike {
  const inner = openAICompletionsApi();

  const wrap = (method: "stream" | "streamSimple") => (model, context, options = {}) =>
    inner[method](model, context, {
      ...options,
      onPayload: (params, m) => {
        const upstream = options.onPayload?.(params, m);   // 先让别人的钩子跑
        const base = upstream ?? params;
        const effort = reasoningEffortOf?.(m);
        return withExtraBody(base, effort);                // 再追加 extra_body
      },
    });

  return { stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}
```

`withExtraBody` 是 `protocol/chat.ts` 里已有的 `applyThinking(body, effort)` 的浅拷贝包装 —— 逻辑只写一份，协议层的单测（CH-18~21）直接覆盖它。

**三项被 ADR-0003 揽下、现在交还给 pi-ai 的职责：**

| 职责 | ADR-0003 | ADR-0007（实际） |
| --- | --- | --- |
| SSE 帧解析 | 自己写 | `openai-completions` 现成 |
| `delta.reasoning_content` → thinking 事件 | 自己写 | `openai-completions` 现成（字段名表已含它） |
| 文本 / 工具调用 / usage / finish_reason 事件 | 自己写 | `openai-completions` 现成 |
| 请求体注入 `extra_body` | 自己写 | **我们写**（`onPayload` 里 20 行） |
| 首字节 60s 超时 | 自己写 | **我们写**（`AbortController` + 定时器） |
| idle 120s 超时 | 自己写 | `dsh-llm-pi-ai` 的 `streamIdleTimeoutMs`（本项目设 300s）+ 我们自己 120s |

---

## 理由

### 1. 自己复刻事件协议是纯风险、零收益

`openai-completions.js` 有 1344 行，其中绝大部分是**我们已经会踩错的细节**：

- `output.stopReason` 的五态收尾（`stop` / `length` / `toolUse` / `error` / `pending`）与"流结束时没有 finish_reason"的判定
- 工具调用的 `partialArgs` 累积 + `parseStreamingJson` + 末尾 delete `index`/`partialArgs`/`customInput`/`streamIndex`
- `block.thinkingSignature` 存 reasoning_details 的序列化
- `compat.supportsFinishReason` 为 false 时"没有 finish_reason 也算正常结束"的分支

这些都不是"业务逻辑"，是 pi-ai 与 dsh-llm-pi-ai 之间的**契约细节**。自己重写一份，等于把上游每次升级都要同步的契约复制到自己的仓库里。

### 2. `delta.reasoning_content` 早就被支持了

ADR-0003 的前提之一是"要解析 `delta.reasoning_content`"。实际上 `openai-completions` 的字段表里第一位就是它。**这条前提消失了，那个理由也就消失了。**

### 3. 首字节超时在 `onPayload` 层做不了，但可以在包装的 `stream` 里做

`onPayload` 只能改请求体，拿不到 response。但我们的包装层是 `stream(model, context, options)` —— 它可以：

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(FIRST_BYTE), FIRST_BYTE_TIMEOUT_MS);
// 传给 inner 的 signal 是 controller.signal（与外部的 signal 串联）
// 收到第一个 delta 时 clearTimeout(timer)
```

wrapper 拿到 `AssistantMessageEventStream` 之后可以 `.push` 转发，也可以直接在 `onResponse` 里 `clearTimeout`。**位置没变（还是在我们自己代码里），成本降了一个数量级。**

### 4. 行为可观测、可回退

包装层的每一条行为都能单测：`onPayload` 被调用一次、追加了 `extra_body`、`reasoning_effort` 按档位正确、首字节超时触发时 push 的是 `error` 事件。**这些断言不需要跑 SSE。**

而"自己写的 SSE 状态机"只能靠端到端验证 —— 与 ADR-0003 想避免的问题正好相反。

---

## 后果

### 正面

- `src/provider/api.ts` 实际只有 **68 行**（含注释），不是 ADR-0003 预估的 250+ 行。
- 思考内容、工具调用、usage、finish_reason 的正确性由 pi-ai 保证，我们只对"注入对不对"负责。
- `applyThinking()` 只有一份实现（`protocol/chat.ts`），被单测和 Api 共用。
- R3 风险（自定义 Api 写不出来）从"高"降到"低"：最坏情况是 `onPayload` 不生效，那时 `extra_body` 丢了但对话仍然能跑（只是没思考）。

### 负面

- **`onPayload` 是 pi-ai 的稳定接口，但我们依赖它。** 如果未来 pi-ai 改名或去掉这个钩子，思考通道会静默失效（不报错，只是没有 reasoning 事件）。缓解：`scripts/smoke-provider.mjs` 断言 `payloads` 里有 `extra_body`，pi-ai 升级后跑一遍就知道。
- 首字节超时的实现从"在流解析里精确控制"变成"包装层 abort + 转发 error 事件"，多了一层事件转发。实测下来这条路径是通的（见 `test/chat.test.ts` 的 CH-32 首字节超时用例）。
- 仍然拿不到 `onPayload` 在内核层的位置 —— 如果将来 `dsh-llm-pi-ai` 开始透传 `onPayload`，我们这层包装就有冗余（但不冲突：两处都会追加，后者覆盖前者，`extra_body` 是一样的值）。

### 中性

- `Api` 的 `id` 字段我们不再使用（`createProvider` 的 `api` 可以是单对象，不必是 `{[apiId]: Api}` 映射）。所以 `api.ts` 不需要导出 `id`。

---

## 否决的替代方案

### A. 按 ADR-0003 原样，自己写完整 SSE 状态机

成本 4–8 小时且必然引入契约偏差。**在发现 `reasoning_content` 已被支持、`onPayload` 已存在之后，这条路没有任何收益。**

### B. 退回 `openAICompletionsApi()` + `reasoning: false`（sensenova 的做法）

思考通道直接没有。而本项目的一个明确目标就是"打开思考通道"（见 `docs/01-research/02-prior-raccoon-connectors.md` 的"四个必须比前辈做得更好的点"）。

### C. 用 `compat.thinkingFormat: "deepseek"` 让 pi-ai 发顶层 `thinking` 字段

`buildParams` 里 `thinkingFormat: "deepseek"` 会发：

```js
params.thinking = { type: "enabled" }   // 顶层，不是 extra_body
```

**这是最接近的现成方案**，但它发的是顶层 `thinking`，而小浣熊要的是 `extra_body.thinking`。除非实测确认网关也接受顶层 `thinking`（Q3），否则不能走这条。

**如果将来实测证明顶层 `thinking` 被接受**，那 `api.ts` 可以整个删掉，改成 `compat: { thinkingFormat: "deepseek" }` —— 这是本 ADR 的天然退路，记在这里备查。

### D. 用 `model.compat.openRouterRouting` 之类走 `params.provider`

那是 OpenRouter 的路由字段，小浣熊不认。

---

## 复审条件

1. **`scripts/smoke-provider.mjs` 的 `payloads` 断言失败**（说明 `onPayload` 没被调到）→ 立刻回到 ADR-0003 的"自己写 Api"路线，或改用 `thinkingFormat: "deepseek"`（若 Q3 已解）。
2. **pi-ai 大版本升级**（`0.2.x` → `0.3.x`）→ 重跑 `smoke-provider`；同时检查 `openai-completions.js` 的 `reasoningFields` 与 `onPayload` 调用点是否还在原位置。
3. **实测发现顶层 `thinking` 也被接受**（Q3 结论为「接受」）→ 删除 `api.ts`，改用 `compat.thinkingFormat: "deepseek"`，本 ADR 标记 Superseded。

---

## 实测佐证

| 编号 | 事实 |
| --- | --- |
| E-010 | `pi-ai/dist/api/openai-completions.js` 里 `extra_body` / `extraBody` / `providerOptions` **零命中** —— 没有现成的注入通路 |
| E-020 | `openai-completions.js:397-420` 的 `reasoningFields = ["reasoning_content","reasoning","reasoning_text"]`；`:188-191` 的 `onPayload` 钩子；`dist/api/lazy.js` 的 `lazyStream` 同步返回 `AssistantMessageEventStream` |
| E-021 | `dsh-llm-pi-ai/lib/index.js:1754-1767 profileOptions()` 不透传 `onPayload` |
