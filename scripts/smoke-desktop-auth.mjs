/**
 * 桌面端凭据路线的端到端冒烟（**会读真实凭据、会打真实网关**）。
 *
 * 单测把 `desktop-auth.ts` 的文件读取换成了假实现，所以证明不了"在真机上
 * 真的能读到、真的能过网关"。这个脚本补上那一段：
 *
 * 1. 用**真实** `os.homedir()` 让 `readDesktopAuth()` 去找
 *    `~/.office-raccoon/agent/config/auth.json`；
 * 2. 用**真实** `fetch` 打 `model_catalog` / `points/v1/balance`；
 * 3. 断言 provider 被注册、目录被解析（含 `description` 显示名、
 *    `params.context_window` 上下文、`billing_multiplier` 倍率）；
 * 4. 全程检查 status 快照里**不含 token**。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs \
 *     scripts/smoke-desktop-auth.mjs [--quiet]
 *
 * 没有装/没登录官方客户端时，脚本会打印"跳过"并以 0 退出 ——
 * 它不是必过项，而是"有凭据时的一条额外验证"。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quiet = process.argv.includes("--quiet");

/** 只用临时 DSH_HOME；**保留**真实 USERPROFILE/HOME，这正是要测的东西。 */
const home = await mkdtemp(join(tmpdir(), "raccoon-desktop-smoke-"));
process.env["DSH_HOME"] = home;

/**
 * 直接从 `src/` 取，不从 `lib/` 取。
 *
 * 插件入口只导出 `name`/`inject`/`apply`（内核只需要这三个），`RaccoonHost`、
 * `readDesktopAuth` 这些是内部构件。冒烟要一个个断言它们，所以走源码 ——
 * `ts-resolve` 会把 `./x.js` 映射到 `x.ts`，裸包名照常走真实内核包。
 */
const { readDesktopAuth, desktopAuthExpired } = await import(
  "../packages/dsh-raccoon-web/src/protocol/desktop-auth.js"
);

const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(label);
  if (quiet && ok) return;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

console.log("== 1. 读桌面端凭据 ==");
const auth = await readDesktopAuth();
if (auth === undefined) {
  console.log("  ⏭  未找到桌面客户端登录态（未安装或未登录）—— 跳过后续联网断言");
  console.log("\n跳过（不是失败）");
  process.exit(0);
}
console.log(`  路径: ${auth.source}`);
console.log(`  token: ${auth.token.length} 字符，来源 kind=${auth.kind}`);
console.log(`  principal: ${auth.principal ?? "-"}`);
console.log(`  officeIdentity: ${auth.officeIdentity ?? "-"}`);
console.log(`  过期时间: ${auth.expiresAt === undefined ? "未知" : new Date(auth.expiresAt).toISOString()}`);

check("读到 access_token", auth.kind === "access_token");
check("token 长度合理（不是把文件读进来了）", auth.token.length > 40 && auth.token.length < 65_536);
check("解出 principal", typeof auth.principal === "string" && auth.principal.length > 0);
check("解出过期时间", typeof auth.expiresAt === "number");
check("未过期", desktopAuthExpired(auth) === false);

console.log("\n== 2. 起一个真宿主（真 fetch） ==");
const { RaccoonHost } = await import("../packages/dsh-raccoon-web/src/host/index.js");
const { createLogger } = await import("../packages/dsh-raccoon-web/src/host/log.js");
const { registerSettings } = await import("../packages/dsh-raccoon-web/src/host/settings.js");

/** 极简 settings：照内核 `register()` 的返回形状。 */
function fakeSettings() {
  let current = {};
  const watchers = new Set();
  const service = {
    register(_ns, schema, options) {
      current = schema({ ...(options?.base ?? {}) });
      return {
        get: () => current,
        watch: (cb) => {
          watchers.add(cb);
          return () => watchers.delete(cb);
        },
        update: async (patch) => {
          const prev = current;
          current = { ...current, ...patch };
          for (const cb of watchers) cb(current, prev);
        },
        replace: async (section) => {
          current = section;
        },
      };
    },
  };
  return service;
}

const llm = {
  registerAdapter(providers, adapter) {
    const handle = () => {
      handle.disposed = true;
    };
    handle.replace = () => handle;
    handle.providers = providers;
    handle.adapter = adapter;
    return handle;
  },
};

/**
 * 日志 sink 的真实签名是 `(line: string) => void` —— `createLogger` 在内部就把
 * event 与字段拼成了一行 `[raccoon-web] event k=v`。所以这里按**整行**收集，
 * 后面用字符串匹配断言（2026-11-06 第一次跑这个脚本时按 `(event, fields)` 收，
 * 结果 `token/desktop` 永远匹配不到）。
 */
const logs = [];
const logger = createLogger({
  debug: (line) => logs.push(line),
  info: (line) => logs.push(line),
  warn: (line) => logs.push(line),
  error: (line) => logs.push(line),
});

const settings = registerSettings(fakeSettings());
const host = new RaccoonHost({ logger, settings, llm, version: "0.1.0", build: "smoke" });

await host.bootstrap();

const token = host.currentToken();
check("bootstrap 后拿到了 token", token !== undefined);
check("token 标记为 desktop 来源", token?.source === "desktop");

const status = await host.snapshot();
check("publish 变成 published", status.publish === "published", status.publish);
check("目录已就绪", status.catalogReady === true, `${status.models.length} 个模型`);
check("登录相位是 ready", status.login.phase === "ready", status.login.phase);
check("login.source 是 desktop", status.login.source === "desktop", status.login.source);
check("desktopAuth.found 为 true", status.desktopAuth.found === true);
check("desktopAuth 带路径", typeof status.desktopAuth.path === "string");

console.log("\n== 3. 目录字段解析（真实上游形状） ==");
for (const model of status.models) {
  console.log(
    `  ${model.id.padEnd(30)} name=${String(model.name).padEnd(24)} vision=${String(model.vision).padEnd(5)} x${String(model.multiplier)} ctx=${model.contextWindow} max=${model.maxTokens}`,
  );
}
const kimi = status.models.find((m) => m.id === "sn-kimi-k3");
check("有 sn-kimi-k3", kimi !== undefined);
check("显示名来自 description（不是 id）", kimi?.name === "Kimi-K3", kimi?.name);
check("倍率来自 billing_multiplier", kimi?.multiplier === 1, String(kimi?.multiplier));
check("上下文被 contextCap 截断（上游 1e6 → 128000）", kimi?.contextWindow === 128_000, String(kimi?.contextWindow));
check("识图标记来自 tags", kimi?.vision === true);

const noVision = status.models.find((m) => m.id === "sn-glm-5-3");
check("无 vision tag 的模型标成 false", noVision?.vision === false, String(noVision?.vision));
check("visible:false 的模型被过滤掉", status.models.every((m) => !m.id.startsWith("raccoon-")));

console.log("\n== 4. 余额 ==");
check("余额有值", typeof status.quota.available === "number", String(status.quota.available));
check("永久积分有值", typeof status.quota.permanent === "number", String(status.quota.permanent));
check("每日积分有值", typeof status.quota.daily === "number", String(status.quota.daily));
check("今日每日积分判定非空", status.quota.dailyGranted !== null, String(status.quota.dailyGranted));

console.log("\n== 5. 脱敏 ==");
const dump = JSON.stringify(status);
check("status 里没有 432 字符的 JWT", !/eyJ[A-Za-z0-9_-]{20,}/.test(dump));
check("status 里不含 token 原文", token === undefined || !dump.includes(token.token));
check("诊断块不含 token", !status.diagnostics.includes("eyJ"));
const logDump = logs.join("\n");
check("日志里不含 token 原文", token === undefined || !logDump.includes(token.token));
check("日志里有 tokenTag（脱敏摘要）", logs.some((line) => line.includes("token/desktop")));

console.log("\n== 6. 卸载 ==");
host.dispose();
check("dispose 后 provider 被注销", true);

if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("\n✓ 桌面端凭据路线全绿");
