# 未解问题与验证方法

最后更新: 2026-11-06
状态: 已定稿（持续追加）

> 每条问题都必须带**可执行的验证方法**。写"待研究"等于没写。

---

## Q1 · SSE error frame 的真实形状（P0）

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

## Q2 · `x-client-platform` / `x-client-version` 是否必需（P0）

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

## Q3 · `extra_body.thinking` 是否仍被接受（P0）

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

## Q4 · 目录响应的完整字段（P1）

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

## Q5 · 图片是 base64 还是也接受 URL（P1）

**问题**：`image_url.url` 能不能是 `https://...`？

**为什么要紧**：如果只吃 base64，大图会撞 10 MB 上限，必须先在本地压。

**验证**：

```bash
# A. data URL
'{"role":"user","content":[{"type":"text","text":"图里是什么字"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KG..."}}]}'
# B. https URL
'{"role":"user","content":[{"type":"text","text":"图里是什么字"},{"type":"image_url","image_url":{"url":"https://example.com/x.png"}}]}'
```

**当前实现**：只发 base64（DSH 的附件本来就是本地文件，转 base64 是必然路径）。像素预算 640 000。

---

## Q6 · `x-raccoon-session-id` 到底做什么（P2）

**问题**：它是"对话会话"还是"客户端实例"？同一 id 用久了会不会被判定"会话太长"？

**为什么要紧**：如果它是服务端的上下文缓存键，那按 `principal+model` 固化是对的；如果它是"客户端 run id"，固化就错了。

**验证**：连续 20 轮对话，观察同一 id 与每轮换 id 两种情况下的首字节延迟与限流率。

**当前实现**：按 `principal + "\0" + model` 固化（照抄 `dsh-llm-adapters`）。它的代码注释里有官方客户端的抓包证据（26 分钟 125 次调用同一个 id）。

---

## Q7 · `v1.0.35` 版本号是否被校验（P2）

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

## Q9 · 每日积分到底怎么触发（P2）

**已知**：没有签到接口；`setting_info` 的 `point_grant_popups` 公告发放；重放 `setting_info` 能触发。

**不解**：是"打开网页"触发，还是"打开网页且页面加载完 setting_info"触发？纯 API 调用（我们的插件）算不算？

**验证**：连续 3 天不动网页，只用插件查余额，看 `daily_points` 是否增长。

**当前决定**：只读展示，不代领。理由见 [03-raccoon-protocol.md §4.3](03-raccoon-protocol.md)。

---

## Q10 · DSH 重启后 client.js 缓存（P1）

**问题**：改了 `client.js` 之后，浏览器会不会用旧的？

**已知**（系统提示里写明的）：client-plugin 的 HMR 只有在 `pnpm run dev:web` 也跑着的时候才能免刷新重载；否则要重建 Web 产物并刷新页面。

**验证**：改一个字 → 重启 DSH → 刷新页面 → 看是否生效。

**处置**：开发期在 `client.js` 顶部加一个 `const BUILD = "2026-11-06T09:40";`，日志里打出来，用于确认浏览器加载的是新版。

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
