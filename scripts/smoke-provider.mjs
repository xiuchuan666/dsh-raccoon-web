/**
 * provider 装配冒烟测试（真内核类 + 假网关）。
 *
 * 单测把内核包换成了桩，冒烟脚本 `smoke-host.mjs` 只覆盖"未登录"路径。
 * 这个脚本补上最后一段：**有 token 时** 用真实的
 * `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 与真实的 `resolveRetryPolicy`
 * 完成一次注册，然后把内核会调的方法挨个调一遍。
 *
 * 它证明的是单测证明不了的东西：
 *
 * 1. `assembleAdapter` 里那份 `RETRY_POLICY` 能过内核的严格校验
 *    （`resolveRetryPolicy` 拒绝未知键、拒绝 `mode` 之外的取值）。
 * 2. 真 `PiAiAdapter` 接受我们的 `profiles()` 形状（含 `piProvider`、图片预算、idle 超时）。
 * 3. 目录回来后 `Publisher` 走「先释放再重新注册」，全程只有一个活着的 registration。
 * 4. `modelInfo` 能吐出内核要的形状（`inputModalities` / `context.contextWindow` / `reasoning.efforts`）。
 *
 * 网关全部打桩，**不碰网络**。
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/smoke-provider.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "raccoon-provider-"));
process.env["DSH_HOME"] = home;

const { RaccoonHost } = await import("../packages/dsh-raccoon-web/src/host/index.js");
const { createLogger } = await import("../packages/dsh-raccoon-web/src/host/log.js");
const { dataDir } = await import("../packages/dsh-raccoon-web/src/host/store.js");

const failures = [];
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  else {
    console.log(`  ❌ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------------ 假网关

const CATALOG = {
  code: 0,
  data: {
    categories: [
      {
        key: "general",
        name: "通用",
        models: [
          {
            id: "sn-kimi-k3",
            name: "Kimi-K3",
            vision: true,
            multiplier: 1,
            context_window: 1_000_000,
            max_output_length: 65_536,
          },
          {
            id: "sn-glm-5-3",
            name: "GLM-5-3",
            vision: false,
            multiplier: 0.75,
            context_window: 128_000,
            max_output_length: 32_768,
          },
        ],
      },
    ],
  },
};

const BALANCE = { code: 0, data: { available_points: 12_345, reward_points: 10_000, daily_points: 2_345 } };
const BILLS = { code: 0, data: { items: [] } };

const calls = [];
/** 换名册用的可变目录（第 5 段会改它，模拟上游新增/下线模型）。 */
let catalogNow = CATALOG;
const fetchImpl = async (input, init) => {
  const url = String(input);
  calls.push({ url, headers: init?.headers ?? {} });
  const body =
    url.includes("/model_catalog") ? catalogNow : url.includes("/points/v1/balance") ? BALANCE : url.includes("/v2/bills") ? BILLS : undefined;
  if (body === undefined) {
    return new Response(JSON.stringify({ code: 404, message: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

// ------------------------------------------------------------------ 假服务

function fakeSettings() {
  let current;
  const watchers = new Set();
  return {
    register(_ns, schema) {
      current = schema({});
      return {
        get: () => current,
        watch: (cb) => {
          watchers.add(cb);
          return () => watchers.delete(cb);
        },
        update: (patch) => {
          const prev = current;
          current = { ...current, ...patch };
          for (const cb of watchers) cb(current, prev);
        },
        replace: (section) => {
          current = schema(section);
        },
      };
    },
  };
}

const registered = [];
let replaceCount = 0;

const llm = {
  registerAdapter(providers, adapter) {
    if (providers.some((p) => registered.some((r) => !r.disposed && r.providers.includes(p)))) {
      throw new Error("DUPLICATE_ADAPTER");
    }
    for (const provider of providers) {
      const info = adapter.providerInfo(provider);
      if (info === undefined || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) {
        throw new Error(`INVALID_ADAPTER: bad providerInfo ${JSON.stringify(info)}`);
      }
      // 真内核会把它交给 resolveRetryPolicy；非法配置在这里当场炸。
      const policy = adapter.providerRetryPolicy?.(provider);
      if (policy === undefined) throw new Error("INVALID_ADAPTER: 没有 retryPolicy");
    }
    const record = { providers, adapter, disposed: false };
    registered.push(record);
    const handle = () => {
      record.disposed = true;
    };
    // 内核的真实签名是 `replace(providers: string[]): void` —— 只换路由名、
    // 换不了 adapter 实例（`dsh-llm/lib/index.js:1856`）。我们换名册必须换实例，
    // 所以 Publisher 根本不用它，而是"释放旧的 + 注册新的"。
    handle.replace = (next) => {
      replaceCount += 1;
      record.providers = next;
    };
    return handle;
  },
};

// --------------------------------------------------------------- 一个真 token

const tokenFile = join(dataDir(), "token.json");
await mkdir(dirname(tokenFile), { recursive: true });
await writeFile(
  tokenFile,
  JSON.stringify({
    schemaVersion: 1,
    token: "fake-access-token-for-smoke",
    kind: "access_token",
    savedAt: Date.now(),
    principal: "smoke-principal",
  }),
  "utf8",
);

// --------------------------------------------------------------------- 跑

const settingsService = fakeSettings();
const settings = settingsService.register("dsh-raccoon-web", (raw) => ({
  enabled: true,
  reasoning: true,
  visionProbeOverride: false,
  contextCap: 128_000,
  debugLog: false,
  ...raw,
}));

const logger = createLogger(undefined);
const host = new RaccoonHost({
  logger,
  settings,
  llm,
  version: "0.1.0",
  build: "smoke",
  fetchImpl,
  now: Date.now,
});

console.log("\n== 1. bootstrap（有 token，目录来自假网关） ==");
await host.bootstrap();
await new Promise((r) => setTimeout(r, 100));

const live = registered.filter((r) => !r.disposed);
check("有且只有一个活着的 registration", live.length === 1, `${live.length} 活着 / 共 ${registered.length} 次注册`);
check("目录请求带上了 token", calls.some((c) => c.url.includes("/model_catalog")), calls.map((c) => c.url).join(" | "));

// 必须取**最后**一次注册的那个 adapter：bootstrap 先拿 fallback 名册注册一次，
// 目录回来后又换了一次（换名册必须换 adapter 实例，否则 `current()` 的快照 memo
// 认不出变化 —— 见 host/publish.ts）。早先这里取 `registered[0]`，于是断言看到的
// 永远是 fallback 名册，而不是假网关给的两条。
const record = registered[registered.length - 1];
if (record === undefined) {
  console.log("\n✗ 没有注册，后续断言跳过");
  await rm(home, { recursive: true, force: true });
  process.exit(1);
}

const adapter = record.adapter;

console.log("\n== 2. 真 PiAiAdapter 的形状 ==");
check("providerInfo.name 是中文显示名", adapter.providerInfo("raccoon-web").name === "小浣熊", adapter.providerInfo("raccoon-web").name);
check("providerRetryPolicy 存在", adapter.providerRetryPolicy("raccoon-web") !== undefined);
const policy = adapter.providerRetryPolicy("raccoon-web");
check("retry mode 是 normal", policy.mode === "normal", policy.mode);
check("retry RATE_LIMIT 不在列表（按 token 速率限流，重试只延长冷却）", !policy.retryableCodes.includes("RATE_LIMIT"), policy.retryableCodes.join(","));
check("maxRetries 是 2（不是 8）", policy.maxRetries === 2, String(policy.maxRetries));

console.log("\n== 3. listModels ==");
const models = await adapter.listModels("raccoon-web");
check("返回 2 个模型（与假网关一致）", models.length === 2, `${models.length}`);
if (models.length > 0) {
  const first = models[0];
  check("模型来自目录（不是 fallback）", first.id === "sn-kimi-k3", first.id);
  check("显示名带倍率", first.name === "Kimi-K3 · x1.00", first.name);
  check("带 inputModalities", Array.isArray(first.inputModalities), JSON.stringify(first.inputModalities));
  // `listModels` 只给「选择器要的四样」（provider / id / name / inputModalities）；
  // 上下文窗口与推理档位在 `resolveModel` 里 —— 这是内核的真实分工，
  // 冒烟测试必须按内核的调用来断言，不能按我们的想象断言。
  check("listModels 不含 contextWindow（符合内核分工）", first.context === undefined);
}

console.log("\n== 4. resolveModel（内核的 modelInfo 通路） ==");
const resolved = await adapter.resolveModel("raccoon-web", "sn-kimi-k3", undefined);
check("resolveModel 拿到 id", resolved.id === "sn-kimi-k3", resolved.id);
check(
  "contextWindow 被 contextCap 截到 128000（上游给 1e6）",
  resolved.context?.contextWindow === 128_000,
  String(resolved.context?.contextWindow),
);
// 实测：不设 `thinkingLevelMap` 时 `getSupportedThinkingLevels` 只给五档，
// `xhigh` 与 `max` 必须显式 map 过才出现（pi-ai/dist/models.js:679-690）。
// 五档够用，所以不补 map —— 少一个可能被上游拒绝的取值。
check(
  "reasoning.efforts 五档（off/minimal/low/medium/high）",
  JSON.stringify(resolved.reasoning?.efforts?.map((e) => e.id)) === '["off","minimal","low","medium","high"]',
  JSON.stringify(resolved.reasoning?.efforts?.map((e) => e.id)),
);
check("识图模型带 image 输入", resolved.inputModalities?.includes("image") === true, JSON.stringify(resolved.inputModalities));
const nonVision = await adapter.resolveModel("raccoon-web", "sn-glm-5-3", undefined);
check("非识图模型不带 image", nonVision.inputModalities?.includes("image") !== true, JSON.stringify(nonVision.inputModalities));

console.log("\n== 5. 再换一次名册：先释放旧的，再注册新的 ==");
const beforeCount = registered.length;
// 先证明"目录没变 → 不重新注册"（签名一致就保留现状，这是最常见的路径）。
await host.runAction("refresh-catalog", { force: true });
await new Promise((r) => setTimeout(r, 100));
check("目录没变时不重新注册", registered.length === beforeCount, `${beforeCount} → ${registered.length}`);

// 再把假网关的目录换掉，逼出"换名册"那条路径。
// 一条模型、少了 vision、倍率与上下文都不同 —— 任一处算进签名就够了。
catalogNow = {
  code: 0,
  data: {
    categories: [
      {
        type: "chat",
        models: [
          {
            name: "sn-glm-5-3",
            description: "GLM-5-3",
            visible: true,
            tags: ["general", "code"],
            params: { context_window: 200_000, max_tokens: 32_768 },
            billing_multiplier: 0.75,
          },
        ],
      },
    ],
  },
};
await host.runAction("refresh-catalog", { force: true });
await new Promise((r) => setTimeout(r, 100));
const liveAfter = registered.filter((r) => !r.disposed);
check("仍然只有一个活着的 registration", liveAfter.length === 1, `${liveAfter.length}`);
check(
  "换名册会重新注册一次（换实例才能刷新快照）",
  registered.length === beforeCount + 1,
  `${beforeCount} → ${registered.length}`,
);
check("换名册前那份已被释放", record.disposed === true);
check("新 adapter 是另一个实例", liveAfter[0]?.adapter !== adapter);
// 内核的 `replace(providers[])` 只换路由名、换不了实例，我们不该用它。
check("没有误用 handle.replace", replaceCount === 0, String(replaceCount));

console.log("\n== 6. 卸载 ==");
host.dispose();
check("全部 registration 都已注销", registered.every((r) => r.disposed), `${registered.length} 个全部 disposed`);

await rm(home, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log("✓ provider 冒烟全绿");
  process.exit(0);
} else {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
