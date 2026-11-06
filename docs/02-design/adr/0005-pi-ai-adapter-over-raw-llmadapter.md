# ADR-0005 · 用 `PiAiAdapter` 而不是裸 `LlmAdapter`

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [00-architecture](../00-architecture.md)、[ADR-0003](0003-reasoning-channel.md)

---

## 背景

DSH 的 `llm` 服务接受任何实现了适配器契约的对象：

```ts
ctx.llm.registerAdapter(["raccoon-web"], adapter);
```

有两条路：

**路线 A：继承 `LlmAdapter` 基类，自己实现全部方法**

```ts
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

class RaccoonAdapter extends LlmAdapter {
  providerInfo(provider) { ... }
  listModels(provider) { ... }
  stream(request) { ... }       // 要产出 DSH 的 assistant-stream 协议
  streamText(request) { ... }
  countTokens?(...) { ... }
  ...
}
```

**路线 B：构造一个 pi-ai 的 `Provider`，包进 `PiAiAdapter`**

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

const provider = createProvider({ id, name, auth, models, api });
const adapter = new PiAiAdapter({ profiles: () => new Map([[id, { provider, ... }]]) });
```

---

## 决策

**选 B。**

三个参考插件（workbuddy / trae / minimaxcode / sensenova）**全部**用 B。没有一份用 A。

---

## 理由

### 1. `LlmAdapter` 的契约远比想象的宽

`assistant-stream` 协议包括：`text-delta` / `reasoning-delta` / `tool-call-start` / `tool-call-delta` / `tool-call-end` / `usage` / `finish` / `error`，每种有自己的字段与顺序要求。还要处理：

- 工具调用的 index 累积（多个工具并行调用时按 index 分桶）
- `finish_reason` 到 DSH 内部枚举的映射
- 中断时的事件补齐
- token 计数（可选但影响 UI 的进度显示）

`PiAiAdapter` 全做完了。

### 2. pi-ai 的 `Provider` 是**声明式**的

```ts
createProvider({
  id: "raccoon-web",
  name: "小浣熊",
  auth: { apiKey: { name: "Raccoon token", resolve: async ({ credential }) => ... } },
  models: [...],        // 声明式
  api: raccoonChatApi,  // 或 openAICompletionsApi()
});
```

我们只需要：模型数组 + 一个 Api 对象 + 一个取 token 的函数。

对比路线 A：要实现 6 个方法，其中 `stream` 内部要处理全部事件协议。

### 3. 与 DSH 的升级路径一致

DSH 内核升级时，`PiAiAdapter` 会跟着升级它的 `assistant-stream` 实现。

如果我们自己实现，每次 DSH 改协议都要跟。

**寄生在内核的适配层上，比自己实现一层更抗升级。**

### 4. 代价是可控的

路线 B 的唯一代价：受限于 pi-ai 的 `Api` 抽象。

而这个代价已经被 [ADR-0003](0003-reasoning-channel.md) 处理了 —— 我们自己写 Api，绕开 `openai-completions` 的限制。

---

## 装配形状（照抄 sensenova 的 `lib/llm-adapter-core.js:465-512`）

```ts
function assemblePiAiAdapter({ providerId, displayName, apiKeyName, models, resolveCredential, get, api }) {
  const provider = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: apiKeyName,
        async resolve({ credential }) { return credential; },
      },
    },
    models,
    api,
    getModels: () => models,
  });

  const profiles = new Map([[
    providerId,
    {
      provider,
      displayName,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(/* 见 05-error-model */),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      piProvider: provider,
    },
  ]]);

  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => resolveCredential(),
      resolveAttachments: () => get?.("attachments"),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(attachments, (hostPath) => get?.("fs")?.processPathFromHostPath?.(hostPath), ref),
    }),
    providerIds: [providerId],
  };
}
```

### 两个必须照抄的细节

1. **`profiles` 是函数不是 Map**。`profiles: () => profiles` —— 让 `PiAiAdapter` 每次读时拿到最新值，这样热换模型列表不用重建 adapter。
2. **`getModels: () => models`** —— 同上，模型列表是可变的闭包。

---

## 后果

### 正面

- 少实现 6 个方法
- 事件协议由内核负责
- 升级 DSH 时不用跟协议

### 负面

| 代价 | 缓解 |
| --- | --- |
| `PiAiAdapter` 的构造参数没有类型（E-009） | 照抄 sensenova 的形状；参数名写错会在运行时抛，联调时能发现 |
| `profiles` 里的字段（`streamIdleTimeoutMs` / `retryPolicy` / `configuredMaxTokens` / `modelErrors`）语义不明 | 从 sensenova 的实际用法反推；只用我们需要的三个 |
| 受 pi-ai Api 抽象限制 | 见 ADR-0003，自己写 Api |

### 已验证

从 DSH 安装目录可以 import 到这两个包：

```bash
cd "C:/.../resources/app/dsh" && node -e 'import("@deepseek-ai/dsh-llm-pi-ai").then(m=>console.log(Object.keys(m)))'
```

（`PiAiAdapter` 在其中，见 E-008 的同类验证。）

---

## 替代方案（已否决）

| 方案 | 否决理由 |
| --- | --- |
| 继承 `LlmAdapter` | 要实现 6 个方法 + 全部事件协议；升级要跟 |
| 不注册 adapter，自己拦截 `llm` 服务 | 反模式，会破坏 DSH 的其它 provider |
| 用 MCP / 工具的形式接进来 | 那不是"模型"，用户在选择器里看不到，也不能用作对话主模型 |

---

## 复审条件

1. `PiAiAdapter` 在某个 DSH 版本里被移除或改签名
2. pi-ai 的 `Api` 抽象变得比 `LlmAdapter` 还复杂
3. 需要的能力 `PiAiAdapter` 明确不支持（比如自定义 token 计数）
