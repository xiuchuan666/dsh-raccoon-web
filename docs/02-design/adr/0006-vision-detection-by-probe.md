# ADR-0006 · 识图能力按实测，不信目录标签

- 状态: Accepted
- 日期: 2026-11-06
- 决策者: 项目所有者
- 相关: [03-raccoon-protocol §2](../01-research/03-raccoon-protocol.md)、[04-ui-surfaces §3](../04-ui-surfaces.md)

---

## 背景

`model_catalog` 的每个模型带一个 `vision` 字段（或 `tags` 里的 `"vision"`），声明它能不能读图。

`dsh-raccoon-connect` 的 README 记录了 2026-09-18 的实测（5 个模型，错 2 个，**两个方向都错**）：

| 模型 | 目录标签 | 实际行为 |
| --- | --- | --- |
| `DeepSeek-V4.1-Flash` | 无 | ✅ 能读图 |
| `GLM-5-3-Flash` | 无 | ✅ 能读图 |
| `GLM-5-3` | 有 | ❌ 网关丢图，模型回"我看不到这张图片" |

**"有标签但不能用"** 是最坏的情况：用户发图，模型说"我看不到这张图片"，用户以为是 DSH 坏了。
**"无标签但能用"** 只是浪费了一个能力。

### 为什么会这样

两种可能：

1. **目录是静态配置**，模型换了但配置没更新（GLM-5-3 的视觉能力被上游临时摘掉）
2. **网关的转译层有 bug**，某些模型的 `image_url` 内容没被正确转发

无论哪种，都不是我们能改的。我们只能**自己测**。

---

## 决策

**默认用目录标签，但提供"实测覆盖"，并且实测结果可以持久化。**

具体：

1. `roster.ts` 生成 descriptor 时，`vision` 取目录标签
2. 如果 `vision-probe.json` 里有这个模型的记录，**用记录覆盖**（前提：settings 的 `visionProbeOverride` 开着，默认 `false`）
3. UI 上每个模型有一个"识图"标记，点击发起探测：
   - 发一张 3×3 纯红 PNG，问"这张图是什么颜色？只回答一个词"
   - 回答里含"红"/"red" → 支持
   - 回答里含"看不到"/"cannot see"/"no image" → 不支持
   - 其它 → 不确定（不写记录）
4. 结果写进 `vision-probe.json`，带时间戳
5. UI 上标出"这个结论是 YYYY-MM-DD 测的"

### 为什么探测图用纯色而不是文字

用文字图（比如拍个"7"）会混淆两件事：

- 模型**看不到图** → 答不出
- 模型**看到了但 OCR 不行** → 也答不出

纯色只需要"能感知像素"，不需要 OCR。这是更纯粹的能力测试。

3×3 而不是 1×1：某些预处理会拒绝过小的图。

---

## 理由

### 1. 错报的代价不对称

| 错误 | 用户感受 |
| --- | --- |
| 标"支持"但实际不支持 | **"这插件有 bug"** —— 发图石沉大海 |
| 标"不支持"但实际支持 | "少了个功能" —— 但用户不会怪插件 |

所以：**宁可不标，不要错标。**

### 2. 探测成本很低

一次请求，3×3 PNG（约 70 字节 base64），`max_tokens: 16`。消耗的积分可以忽略。

而且**只需要测一次**，结果持久化。

### 3. 这是"可诊断"原则的延伸

[02-prior-raccoon-plugins](../01-research/02-prior-raccoon-plugins.md) 里的第四个"必须比前辈做得好"：**失败可诊断**。

用户遇到"模型看不到图"时，能看到：
- 目录怎么说的
- 实测怎么说的（什么时候测的）
- "重新测"按钮

而不是只有一个"我看不到这张图片"的模型回复。

---

## 实现

### 探测流程（宿主侧）

```ts
// host/routes.ts 里的 probe-vision action
async function probeVision(model: string): Promise<{ supported: boolean | null }> {
  const png = solidPng(3, 3, [237, 28, 36]);      // 纯红
  const answer = await chat(token, {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "这张图是什么颜色？只回答一个词。" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      ],
    }],
    stream: false,
    max_tokens: 16,
  });

  if (/红|red|#?(ed1c24|ff0000)/i.test(answer)) return { supported: true };
  if (/看不到|看不见|无法|cannot|can't|no image|not able/i.test(answer)) return { supported: false };
  return { supported: null };    // 不确定，不写记录
}
```

### `solidPng`

```ts
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  // IHDR + IDAT + IEND，zlib deflate
  // 每行: filter byte 0 + w * RGB
}
```

约 30 行，用 `node:zlib` 的 `deflateSync`。不引依赖。

### 存储

```jsonc
// <profileHome>/raccoon-web/vision-probe.json
[
  { "model": "sn-glm-5-3", "supported": false, "at": 1793947200000 },
  { "model": "sn-deepseek-v4-1-flash", "supported": true, "at": 1793947300000 }
]
```

### descriptor 生成

```ts
const probed = probeOverride ? probeMap.get(model.id) : undefined;
const vision = probed?.supported ?? model.vision;
```

`descriptor.input = vision ? ["text", "image"] : ["text"]`。

---

## 后果

### 正面

- 用户不会被"有标签但丢图"坑
- 实测结论是可见的、带日期的
- 探测成本几乎为零

### 负面

| 代价 | 缓解 |
| --- | --- |
| 每个模型要花一次请求 | 用户主动点才测；一次 16 token |
| 结论会过期（上游修了 bug 但记录说"不支持"） | 带时间戳显示；有"重新测"按钮 |
| `solidPng` 要自己写 | 30 行，用 `node:zlib` |
| 探测本身可能触发限流 | 一次只测一个模型，不批量 |

### 默认 `visionProbeOverride: false` 的理由

如果用户从没测过，`probeMap` 是空的，行为等于"用目录标签" —— 与参考实现一致。

打开这个开关之后，**已测的模型**用实测，**未测的**仍用目录。不是全有或全无。

这样新用户不会因为"没测过"就丢掉所有视觉模型。

---

## 替代方案（已否决）

| 方案 | 否决理由 |
| --- | --- |
| 全信目录标签 | 已知会错（5 个错 2 个） |
| 全不信目录，只信实测 | 新用户第一次用就没有任何视觉模型，除非先测一遍 |
| 全局强制探测（装完插件就跑） | 用户没同意就消耗积分；而且限流的时候会一起失败 |
| 写死一个"已知支持/不支持"的名单 | 上游一改就过时，而且要跟着改代码发版 |

---

## 复审条件

1. 目录标签连续两次实测 100% 准确 → 可以关掉这个机制
2. 小浣熊提供了 `/capabilities` 之类的权威接口
3. 探测被判定为"非官方行为"（比如触发风控） → 立刻移除
