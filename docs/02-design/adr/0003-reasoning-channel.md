# ADR-0003 · 思考通道：自定义 pi-ai Api 注入 `extra_body.thinking`

- 状态: Superseded by [ADR-0007](./0007-wrap-openai-completions-api.md)
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [E-010](../01-research/05-empirical-findings.md)、[Q3](../01-research/06-open-questions.md)

---

> **本篇已被 [ADR-0007](./0007-wrap-openai-completions-api.md) 取代（2026-11-06，同日）。**
>
> 保留原文是为了记录当时的判断。实际实现推翻了这里的两个前提：
>
> 1. `Api.stream` **不是 async generator**，而是同步返回 `AssistantMessageEventStream`（下文"实现"段的 `async *stream` 写法是错的）。
> 2. `openai-completions` **已原生支持** `delta.reasoning_content`（`openai-completions.js:397-420`），且 `:188-191` 有 `onPayload` 钩子可以改请求体 —— 所以不必自己复刻 SSE 状态机。
>
> 结论改成了「包装 `openAICompletionsApi()` + 在 `onPayload` 里注入 `extra_body`」。详见 ADR-0007。

---

## 背景

小浣熊的模型（GLM、Kimi、DeepSeek 系）支持"思考模式"。网关的开启方式是**私有字段**：

```jsonc
{
  "model": "sn-glm-5-3",
  "messages": [...],
  "extra_body": { "thinking": { "type": "enabled" } },
  "reasoning_effort": "high"
}
```

`extra_body` 不是 OpenAI 规范字段。OpenAI SDK 里它由客户端剥离，服务端不会看到。

思维内容回来的位置也是非标准字段：`delta.reasoning_content`（不是 `delta.reasoning`）。

### 现有实现怎么处理的

| 实现 | 做法 | 结果 |
| --- | --- | --- |
| `dsh-llm-adapters` | 自己写 `openAiStream()`，能塞任意字段 | ✅ 思考通道可用 |
| `dsh-connect-sensenova-token-plan` | 用 pi-ai 的 `openAICompletionsApi()` | ❌ `reasoning: false` |

sensenova 的代码注释很诚实：

```js
// 网关唯一思考通道是 extra_body.thinking，pi-ai openai-completions 不发射它
reasoning: false,
```

### 实测

```bash
grep -c -E 'extra_body|extraBody|providerOptions' \
  ".../@earendil-works/pi-ai/dist/api/openai-completions.js"
```

```
0
```

`pi-ai` 的 `dist/` 下**没有任何 `.d.ts`**，所以它的 `Api` 接口长什么样，只能从运行时代码反推。

---

## 决策

**自己写一个 pi-ai 的 `Api`**（`src/provider/api.ts`），复刻 `openai-completions` 的事件协议，但：

1. 请求体里塞 `extra_body.thinking`
2. 解析 `delta.reasoning_content` → `reasoning-delta` 事件
3. 自己实现首字节超时（60s）与 idle 超时（120s）

如果反推 `Api` 接口的成本过高，**降级方案**：退回 `openAICompletionsApi()`，把 `reasoning: false` 写进 descriptor（即 sensenova 的做法），并在 UI 上说明"上游未开放思考通道"。

---

## 理由

### 1. 思考通道不是"锦上添花"

对小浣熊上的推理型模型（GLM-5.3、Kimi K3），思考模式与直接作答的**质量差距很大**。DSH 的 `reasoningEffort` 设置项如果对浣熊完全无效，用户会以为是插件不支持。

更实际的问题：**思考模式下 `max_tokens` 的分配不同**。不开发思考通道，模型可能把预算全用在"直接答"，长推理任务会截断。

### 2. sensenova 的 `reasoning: false` 是"已知不可用但不修"

它没有说"不应该支持"，说的是"pi-ai 不支持"。

**那是它的约束，不是我们的。** 我们只需要写一个 Api 对象。

### 3. 我们已经要写 SSE 解析了

`protocol/chat.ts` 里无论如何都要解析帧（因为要识别流内 error、要判限流、要处理 `usage` 在最后一帧）。

既然帧解析已经自己写了，把它包成一个 `Api` 的增量成本很小。

### 4. 首字节超时只能在这一层做

`pi-ai` 的 `openai-completions` 没有首字节超时（只有整体的 `streamIdleTimeoutMs`）。

而实测（`dsh-raccoon-connect@0.2.4`）：**高峰有 60s+ 无响应**。没有首字节超时，用户看到十分钟的转圈。

自己写 Api 是唯一能精确控制这个的位置。

---

## 实现

### 形状（待最终确认）

```ts
// src/provider/api.ts
import type { Api } from "@earendil-works/pi-ai";   // 类型不存在，用 any + 注释

export const raccoonChatApi = {
  id: "raccoon-chat",

  async *stream(params: any) {
    const { model, messages, tools, reasoningEffort, signal, maxTokens } = params;

    const body = buildBody({ model, messages, tools, reasoningEffort, maxTokens });
    // body.extra_body = { thinking: { type: "enabled" } }  ← 关键

    const response = await chatStream(token, body, { signal, firstByteTimeoutMs: 60_000 });

    for await (const frame of response) {
      if (frame.type === "text")         yield { type: "text-delta", text: frame.text };
      if (frame.type === "reasoning")    yield { type: "reasoning-delta", text: frame.text };
      if (frame.type === "tool-call")    yield { type: "tool-call-delta", ... };
      if (frame.type === "usage")        yield { type: "usage", ... };
      if (frame.type === "finish")       yield { type: "finish", reason: frame.reason };
      if (frame.type === "error")        throw toRaccoonError(frame);
    }
  },
};
```

### 反推 `Api` 接口的方法

```bash
# 1. 看 openai-completions 导出什么
node -e 'import("@earendil-works/pi-ai/api/openai-completions").then(m=>console.log(Object.keys(m)))'

# 2. 看它的 stream 返回什么形状
grep -n 'yield {' ".../dist/api/openai-completions.js" | head -40

# 3. 看 PiAiAdapter 怎么消费 Api
grep -rn '\.api\.' ".../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js" | head -20
```

> ⚠️ 这一步是**本项目的最大不确定点**。估时 4–8 小时，可能更长。见 [04-risks](../03-plan/04-risks.md) R1。

### 字段映射

| 网关帧 | pi-ai 事件 |
| --- | --- |
| `delta.content` | `text-delta` |
| `delta.reasoning_content` | `reasoning-delta` |
| `delta.tool_calls[i].function.arguments` | `tool-call-delta` |
| 最后一帧 `usage` | `usage` |
| `finish_reason: "stop"` | `finish{reason:"stop"}` |
| `finish_reason: "length"` | `finish{reason:"length"}` |
| `finish_reason: "tool_calls"` | `finish{reason:"tool-call"}` |
| `data: [DONE]` | 结束（不产出事件） |

### 思考参数的构造

```ts
function applyThinking(body: any, effort: string | undefined): void {
  if (effort === "off" || effort === "none") {
    body.extra_body = { thinking: { type: "disabled" } };
    if (effort === "none") body.reasoning_effort = "none";
    return;
  }
  body.extra_body = { thinking: { type: "enabled" } };
  if (effort && effort !== "on") body.reasoning_effort = effort;
}
```

照抄 `dsh-llm-adapters` 的语义（它已经跟网关对过了）。

---

## 后果

### 正面

- 思考通道可用
- 首字节超时精确控制
- SSE 解析完全在我们手里（限流、error 帧、usage 都能正确处理）
- `protocol/chat.ts` 能被独立测试

### 负面

| 代价 | 缓解 |
| --- | --- |
| 要反推一个没有类型声明的接口 | 估时 4–8h；有兜底方案 |
| pi-ai 升级后可能不兼容 | `peerDependencies` 固定 DSH 大版本；Api 接口是稳定契约 |
| 自己解析 SSE 有 bug 风险 | 只用三种已知帧格式 + 一种未知，测试覆盖 |

### 兜底触发条件

满足任一条就切兜底（退回 `openAICompletionsApi()`）：

1. 反推超过 **8 小时**仍未跑通一个完整对话
2. 跑通了但流式输出有乱序/丢帧（说明我们对事件协议理解错了）
3. 实现后发现 `reasoning-delta` 在 DSH 侧不渲染（那是内核的限制，不是我们的）

兜底后：

- descriptor 里 `reasoning: false`
- settings 里 `reasoning` 开关强制关掉并禁用
- UI 上显示"当前版本不支持思考通道"

---

## 复审条件

1. `pi-ai` 提供了带类型的 Api 接口（有 `.d.ts` 了）
2. `pi-ai` 的 `openai-completions` 开始支持 `providerOptions` / `extraBody`
3. 小浣熊把 `extra_body.thinking` 改成了标准字段

任一条发生，都可以重新评估"是否该用自定义 Api"。
