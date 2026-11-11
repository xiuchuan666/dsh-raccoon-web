# 未解问题与验证方法

最后更新: 2026-11-11
状态: 已定稿（持续追加）

> 每条问题都必须带**可执行的验证方法**。写"待研究"等于没写。
>
> **2026-11-11 复核**：Q1 / Q2 / Q3 / Q4 / Q5 / Q7 / Q8 / Q9 都已解，标题后标了结论。**只有 Q6 与 Q10 仍开放**，且都不是"网关行为未知"，而是"我们的选择还没被现实证伪"。

---

## Q1 · SSE error frame 的真实形状（**已解：三种都容忍**）

**结论**：`src/protocol/errors.ts` 的 `isRaccoonRateLimited(status, text)` 同时覆盖 A/B/C 三种 —— 看状态码 + 全文关键词，对 200 流把整帧 JSON 序列化后跑关键词匹配；`RATE_LIMIT_CODES = new Set([429, 200429])`。唯一没观测过的是"真的在流中间撞限流"，但不阻塞实现。

### 原始记录（保留）

**问题**：限流发生在流中间时，帧长什么样？三种可能：

```jsonc
// A. 标准 error 事件
data: {"error":{"code":"user_model_rate_limited","message":"..."}}

// B. 小浣熊的 code 信封
data: {"code":200429,"message":"user_model_rate_limited","data":null}

// C. 200 的 chunk 里带 error 字段
data: {"id":"...","choices":[],"error":{"message":"..."}}
```

**为什么要紧**：如果只按 HTTP 状态判定限流，B/C 两种会被误判成正常结束 —— 用户看到一条截断的回复，以为模型抽了。

**验证**：登录后发一个明显超长上下文（比如塞 50 万 token），抓 SSE 原始字节。

```bash
# 假设 token 已存
TOKEN=$(node -e 'console.log(require("./.raccoon-token.json").token)')
curl -sS -N -X POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'x-org-code:' -H 'x-raccoon-language: zh' \
  -d @/tmp/big-request.json | tee /tmp/sse-raw.txt
grep -n -E 'error|code|rate' /tmp/sse-raw.txt
```

**当前兜底**：`isRaccoonRateLimited(status, text)` 只看状态码 + 全文关键词。对 200 流，把整帧 JSON 序列化后跑关键词匹配 —— **对 A/B/C 三种都有效**，只是可能误伤（正常回复里出现 "rate_limit" 字样）。所以只在最后一帧失败时才判定。

---

## Q2 · `x-client-platform` / `x-client-version` 是否必需（**已解：LLM 端点官方只发 `Authorization` + 条件性 `X-Org-Code`**）

**结论（E-034）**：拆官方 asar 实测 —— 官方 LLM 请求头只有 `Authorization` 与条件性的 `X-Org-Code`（`office_identity !== "personal"` 才带）；asar 里 `x-raccoon-language` / `x-client-version` / `x-client-platform` **零命中**。我们补的三个头无官方依据，但带不带都 200、无可观测差异 → 保留（成本为零）。

**注意区分**：积分/签到接口（`desktop/v1/login/points/grant`）官方**确实**发 `X-Client-Platform` / `X-Client-Version` / `X-Org-Code`（E-036 的 asar 原文）。"官方不发"这句只对 LLM 对话端点成立。

### 原始记录（保留）

**问题**：sensenova 的浣熊 provider 不带这两个头也能用；`dsh-llm-adapters` 带。到底必需吗？

**为什么要紧**：如果网关按这个头分桶限流（"官方客户端"一个桶、"第三方"一个桶），不带就等于自投慢桶。

**验证**：同一 token、同一请求体，各打 5 次，比状态码与延迟。

```bash
for variant in with without; do
  for i in 1 2 3 4 5; do
    if [ "$variant" = with ]; then
      EXTRA=(-H 'x-client-platform: desktop-windows' -H 'x-client-version: v1.0.35')
    else
      EXTRA=()
    fi
    curl -sS -o /dev/null -w "$variant %{http_code} %{time_starttransfer}\n" \
      -X POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -H 'x-org-code:' -H 'x-raccoon-language: zh' "${EXTRA[@]}" \
      -d '{"model":"MODEL","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":16}'
  done
done
```

**当前决定**：**带上**。成本为零，且更接近官方行为。见 [06 请求头总表](03-raccoon-protocol.md#6-请求头总表)。

---

## Q3 · `extra_body.thinking` 是否仍被接受（**已解：接受，且是最有效的关思考开关**）

**结论（E-035 五变体 A/B）**：`extra_body.thinking: {type:"disabled"}` 把 reasoning 从基线 260 字符压到 81；顶层 `thinking` 压到 49；`enable_thinking:false` **无效**（389，正文还空）；`reasoning_effort:"none"` 压到 82。**关掉思考仍会回吐少量 `reasoning_content`**（几十字符），UI 必须容忍。

**当前实现**：包装 `openAICompletionsApi()`，在 `onPayload` 里注入 `extra_body.thinking`（`src/provider/api.ts`，68 行）。

### 原始记录（保留）

**问题**：网关还认 `extra_body` 吗？还是改成了 `thinking` 顶层字段 / `enable_thinking`？

**为什么要紧**：整条思考通道（[ADR-0003](../02-design/adr/0003-reasoning-channel.md)）押在这上面。

**验证**：三组对比，每组看响应里有没有 `reasoning_content`。

```bash
# A. 带 extra_body.thinking.enabled
-d '{"model":"M","messages":[{"role":"user","content":"9.11 和 9.9 哪个大"}],"stream":true,"extra_body":{"thinking":{"type":"enabled"}}}'
# B. 什么都不带
-d '{"model":"M","messages":[{"role":"user","content":"9.11 和 9.9 哪个大"}],"stream":true}'
# C. 顶层 thinking
-d '{"model":"M","messages":[...],"stream":true,"thinking":{"type":"enabled"}}'
```

判据：A 有 `reasoning_content` 且 B 没有 → 通道有效。

**如果 A 无效**：
1. 试 `enable_thinking: true`
2. 试 `extra_body: {enable_thinking: true}`
3. 都不行 → 降级：`reasoning` 能力标记为 `false`，在 UI 上说明"上游未开放思考通道"

**当前实现**：先按 A 写，把 `thinking` 的字段名做成可配置（settings 里一个隐藏开关），方便不改代码切换。

---

## Q4 · 目录响应的完整字段（**已解：三处嵌套陷阱，见 E-032**）

**结论（E-032）**：真实形状与我们早期猜的不一样，四处硬规矩：

1. `context_window` / `max_tokens` 在 **`params` 里面**（`m.params.context_window`），不在顶层
2. 显示名在 **`description`** 里 —— `name` 与 `model_name` **都是 id**
3. 倍率在 `billing_effective_multiplier`（真实生效）与 `billing_multiplier`（标价）
4. 分组对象只有 `{type:"chat", default_model}`，**没有 key / name** → groupKey 只能取 `type`

`src/protocol/catalog.ts:169` 已按此解析（`sn-deepseek-v4-1-flash-1017` 的 1,000,000 就是从 `params.context_window` 读出来的）。

### 原始记录（保留）

**问题**：`context_window` 还是 `contextWindow`？`max_output_length` 还是 `max_tokens`？`multiplier` 是数字还是字符串？

**为什么要紧**：直接决定模型选择器里显示的上下文长度对不对。

**验证**：登录后 dump 一份完整响应，存进 `docs/01-research/fixtures/model_catalog.json`（脱敏）。

```bash
curl -sS https://xiaohuanxiong.com/api/web/llm/v2/model_catalog \
  -H "authorization: Bearer $TOKEN" -H 'x-org-code:' -H 'x-raccoon-language: zh' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      console.log(JSON.stringify(j.data.categories.map(c=>({name:c.name,count:c.models?.length,first:c.models?.[0]})),null,2));
    })'
```

**当前实现**：所有字段读取都做**多键名兼容**：

```ts
const contextWindow =
  numeric(m.context_window) ?? numeric(m.contextWindow) ?? numeric(m.max_context_length);
```

---

## Q5 · 图片是 base64 还是也接受 URL（**已解，E-018**）

**结论（2026-11-11 实测）**：**两种都支持**。

- `https://httpbin.org/image/png` → 200，模型认出 "an image of a cartoon pig face"
- `data:image/png;base64,<真 PNG>` → 200，reasoning "a solid bright …"
- **裸 base64（不带 `data:` 前缀）→ 400 `image download failed`** —— 它会被当成 URL 去下载
- google logo / wikimedia 的 URL 都回 `400 image download failed`（30.3s / 10.4s）—— 那是**服务端下载不到**，不是"不支持 URL"。第一轮差点据此写错结论

**体积上限**：约 **3.0001 MiB**（E-019），不是曾经猜的 10 MB；超限回 `400 inference request is invalid`，**永远不会有 413**。

**当前实现**：只发 base64（DSH 的附件本来就是本地文件，转 base64 是必然路径），像素预算 640 000 —— 单张 PNG 压缩后通常 200 KB~1.5 MB，两张以内安全。

---

## Q6 · `x-raccoon-session-id` 到底做什么（P2）

**问题**：它是"对话会话"还是"客户端实例"？同一 id 用久了会不会被判定"会话太长"？

**为什么要紧**：如果它是服务端的上下文缓存键，那按 `principal+model` 固化是对的；如果它是"客户端 run id"，固化就错了。

**验证**：连续 20 轮对话，观察同一 id 与每轮换 id 两种情况下的首字节延迟与限流率。

**当前实现**：按 `principal + "\0" + model` 固化（照抄 `dsh-llm-adapters`）。它的代码注释里有官方客户端的抓包证据（26 分钟 125 次调用同一个 id）。

---

## Q7 · `v1.0.35` 版本号是否被校验（**已解：不校验，随便填都 200**）

**结论**：E-034 实测 —— 目录、对话、余额、流水、user_info 五个端点在带不带 `x-client-version` 两种情况下都是 200，无可观测差异。所以常量 `v1.0.35` 只是一个"看起来像官方"的字符串，抽在 `src/protocol/consts.ts` 里改一处生效。

### 原始记录（保留）

**验证**：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://xiaohuanxiong.com/api/web/llm/v2/model_catalog \
  -H "authorization: Bearer $TOKEN" -H 'x-client-version: v0.0.1'
```

**当前实现**：常量写死 `v1.0.35`，抽成 `src/protocol/consts.ts` 的单一常量，改一处生效。

---

## Q8 · 二维码容量边界（已解）

`E-007` 实测 149 字节 → 版本 8。已解决。

留一个后手：`qrcode_code` 的格式是 `qr-<uuid>`（41 字符）。若上游改成更长的 id（比如带签名），URL 会超 213 字节，编码器会抛错。**抛错信息必须说清楚"二维码内容超出编码器容量，请反馈"**，而不是静默出个坏码。

---

## Q9 · 每日积分到底怎么触发（**已解：有签到接口，E-036**）

**结论（E-036）**：`POST /api/web/desktop/v1/login/points/grant`（**无 body**）就是官方客户端的领取动作。幂等 —— 连续两次都是 200 `{"code":0,"message":"success","data":{"granted":false,"popup":null}}`，`granted:false` 表示今日已领。asar 原文里官方判 `0 === n.code && n.data?.granted` 才弹 `SHOW_POINT_GRANT_POPUPS`。

**当前实现**：`src/protocol/points.ts` 的 `grantDaily()` + 号池的「一键签到」（`pool-checkin`）。**先查后写**（先看 `bills` 里今天有没有 `daily_grant`），单个账号失败不中断，**与自动换号开关无关**。

**仍未实测**：真的领到的那一次（`granted:true`）。当日已领，要等次日北京零点后。这是"没验过的分支"，不是"不知道接口在哪"。

### 原始记录（保留）

**已知**：没有签到接口；`setting_info` 的 `point_grant_popups` 公告发放；重放 `setting_info` 能触发。

**不解**：是"打开网页"触发，还是"打开网页且页面加载完 setting_info"触发？纯 API 调用（我们的插件）算不算？

**验证**：连续 3 天不动网页，只用插件查余额，看 `daily_points` 是否增长。

---

## Q10 · DSH 重启后 client.js 缓存（P1）

**问题**：改了 `client.js` 之后，浏览器会不会用旧的？

**已知**（系统提示里写明的）：client-plugin 的 HMR 只有在 `pnpm run dev:web` 也跑着的时候才能免刷新重载；否则要重建 Web 产物并刷新页面。

**验证**：改一个字 → 重启 DSH → 刷新页面 → 看是否生效。

**处置**：开发期在 `client.js` 顶部加一个 `const BUILD = "2026-11-06T09:40";`，日志里打出来，用于确认浏览器加载的是新版。

---

## Q11 · 桌面端凭据过期后能不能自动续（**已解：不做，E-037**）

**问题**：`POST /api/web/auth/v1/refresh` 存在，能不能拿它把 `auth.json` 里的 token 换新，省掉用户手动打开官方客户端？

**结论（四轮探针）**：

1. asar 里这个 URL **只出现 1 次**（offset 74078848），且是 SDK 文档段落（`callScore = 0` / `docScore = 1`）—— **官方桌面端自己也不调它**
2. body 字段名是 **`token`**（`{}` 空对象也报 `param token invalid format invalid`，说明它在报"格式"不是"缺失"）
3. 17 种候选形状（32/64 hex、UUID、`rt_` 前缀、432 字符 base64url、纯数字…）**全部同一条 `100002`** —— 格式校验无法从外部暴力猜出
4. **即便猜出来也不用** —— refresh 很可能 rotate，一 rotate 就把用户正开着的官方客户端踢下线

**当前决定**：**不做自动续期**。凭据过期时 `desktopAuth.reason` 直接写"客户端凭据已过期，请打开官方客户端刷新"，UI 照原样显示两个登录入口。这是一条**有证据的"不做"**。

⚠️ ADR-0008 里"IAM 没有 refresh grant"这句在**事实层面是错的**（接口存在），但在**决策层面仍然成立**（理由是 rotate 风险，不是"没有接口"）。下次回来别把"没找到"当"不存在"，也别把"找到了"当"该做"。

---

## 问题登记格式

新增问题时按这个格式：

```md
## Q<N> · <一句话问题>（P0|P1|P2）

**问题**：…
**为什么要紧**：…
**验证**：（可执行命令或步骤）
**当前兜底**：…
```

`P0` = 阻塞实现；`P1` = 阻塞联调；`P2` = 可以先上线再补。
