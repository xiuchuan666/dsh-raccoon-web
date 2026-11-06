/**
 * 真链路对话冒烟：**真凭据 + 真网关 + 真 PiAiAdapter**。
 *
 * 前面三个冒烟各自只证明一段：
 * - `smoke-provider.mjs` 证明适配器形状对（假网关）；
 * - `smoke-desktop-auth.mjs` 证明凭据能读、目录/余额能拉（真网关，但没发对话）；
 * - `smoke-host.mjs` 证明宿主接线对（不碰网络）。
 *
 * 这个脚本补最后一段：**从我们装配的 PiAiAdapter 发一条真实对话**，
 * 由此一次性验证四件只有真发请求才知道的事：
 *
 * 1. `baseUrl` 拼接正确（写全 `/chat/completions` 会 404 —— E-023）；
 * 2. `compat.maxTokensField: "max_tokens"` 被上游接受（默认会是
 *    `max_completion_tokens`，这个网关不认）；
 * 3. `onPayload` 注入的 `extra_body.thinking` 真的生效
 *    （关掉思考后 content 才不为空 —— 否则 64 个 token 全被思考吃掉）；
 * 4. 思考内容以 `reasoning-delta` 的形式回来（ADR-0007）。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs \
 *     scripts/smoke-chat-live.mjs [--model sn-kimi-k3] [--effort off]
 *
 * 没有桌面端凭据时打印"跳过（不是失败）"并以 0 退出。
 * **它会真的花掉账号积分**（一次问答，100 以内 token）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const MODEL = argOf("model", "sn-sensenova-6-8-flash");
const EFFORT = argOf("effort", "off");

const home = await mkdtemp(join(tmpdir(), "raccoon-chat-smoke-"));
process.env["DSH_HOME"] = home;

const { readDesktopAuth, desktopAuthExpired } = await import(
  "../packages/dsh-raccoon-web/src/protocol/desktop-auth.js"
);
const { assembleAdapter } = await import("../packages/dsh-raccoon-web/src/provider/adapter.js");
const { toDescriptors } = await import("../packages/dsh-raccoon-web/src/provider/roster.js");
const { fetchCatalog, flattenCatalog } = await import("../packages/dsh-raccoon-web/src/protocol/catalog.js");

const auth = await readDesktopAuth();
if (auth === undefined || desktopAuthExpired(auth)) {
  console.log("⏭  没有可用的桌面客户端登录态 —— 跳过（不是失败）");
  process.exit(0);
}

const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

console.log(`== 1. 取目录（找 ${MODEL}） ==`);
const groups = await fetchCatalog(auth.token);
const models = flattenCatalog(groups);
const chosen = models.find((m) => m.id === MODEL) ?? models[0];
if (chosen === undefined) {
  console.log("⏭  目录为空 —— 跳过");
  process.exit(0);
}
console.log(`  用模型: ${chosen.id} (${chosen.name})`);

console.log("\n== 2. 装配适配器（reasoningEnabled=false 以强制走 extra_body 关闭） ==");
const descriptors = toDescriptors(models, { contextCap: 128_000 });
const assembled = assembleAdapter({
  resolveToken: async () => auth.token,
  models: descriptors,
  displayName: "小浣熊",
  reasoningEnabled: false,
});
const adapter = assembled.adapter;

console.log(`\n== 3. 真发一条对话（effort=${EFFORT}） ==`);
const events = [];
let text = "";
let reasoning = "";
let finish;
const signal = AbortSignal.timeout(120_000);
const started = Date.now();
let firstByteAt;

for await (const event of adapter.stream({
  provider: "raccoon-web",
  model: chosen.id,
  messages: [{ role: "user", content: [{ type: "text", text: "1+1=?只回答数字" }] }],
  maxTokens: 256,
  ...(EFFORT === "off" ? {} : { reasoningEffort: EFFORT }),
  signal,
})) {
  events.push(event.type);
  if (firstByteAt === undefined && (event.type === "text-delta" || event.type === "reasoning-delta")) {
    firstByteAt = Date.now() - started;
  }
  if (event.type === "text-delta") text += event.text;
  if (event.type === "reasoning-delta") reasoning += event.text;
  if (event.type === "finish") finish = event.reason;
}

console.log(`  事件序列: ${events.join(" → ")}`);
console.log(`  首字节: ${firstByteAt === undefined ? "无" : `${firstByteAt}ms`}`);
console.log(`  思考: ${reasoning.length} 字 — ${JSON.stringify(reasoning.slice(0, 60))}`);
console.log(`  正文: ${text.length} 字 — ${JSON.stringify(text.slice(0, 60))}`);
console.log(`  finish: ${JSON.stringify(finish)}`);

check("收到 start/block 事件", events.length > 0, `${events.length} 个事件`);
check("不是 AUTH/TIMEOUT 失败", finish?.kind !== "error", JSON.stringify(finish));
check("有正文（extra_body 关思考生效）", text.trim().length > 0, JSON.stringify(text.slice(0, 40)));
check("正文里出现了 2", /2/.test(text), text.trim());
check("思考内容以 reasoning-delta 回来（ADR-0007）", reasoning.length > 0, `${reasoning.length} 字`);
check("首字节在 60s 内", firstByteAt !== undefined && firstByteAt < 60_000, `${firstByteAt}ms`);

console.log("\n== 4. baseUrl 拼接（404 说明写全了路径） ==");
check("没有拿到 UNKNOWN_MODEL / 404", finish?.kind !== "error", JSON.stringify(finish));

if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("\n✓ 真链路对话全绿");
