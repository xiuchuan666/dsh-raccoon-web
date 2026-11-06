/**
 * 宿主层单测（docs/03-plan/02-test-plan.md 的 ST-1 ~ ST-18）。
 *
 * 内核包不能从 profile 解析（E-008），所以这里**全部 mock**：
 * 一个假的 `settings` 服务、一个假的 `llm.registerAdapter`。
 *
 * 最关键的一条是 ST-10：**连续 publish 两次必须 replace，不能 register**。
 * 第二次 `registerAdapter` 对同一个 provider 会抛 `DUPLICATE_ADAPTER`，
 * 而它发生在后台（目录刷新后），用户看不到，只看到"模型列表没更新"。
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createTtlCache } from "../src/host/cache.js";
import { createLogger, formatLine, tokenTag } from "../src/host/log.js";
import { Publisher, rosterSignature } from "../src/host/publish.js";
import { isLoopback } from "../src/host/routes.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/host/settings.js";
import { PROBE_PNG_BASE64, solidPng } from "../src/host/solid-png.js";
import { buildDiagnostics } from "../src/host/status.js";
import * as store from "../src/host/store.js";

/** 一个假的 `llm` 服务：只实现我们用到的那一个方法。 */
function fakeLlm() {
  const registrations: { providers: readonly string[]; adapter: unknown; disposed: boolean }[] = [];

  const llm = {
    registerAdapter(providers: readonly string[], adapter: unknown) {
      // 内核会对重复注册抛 DUPLICATE_ADAPTER。这里照实复现 —— 正是因为这条，
      // Publisher 换名册时必须先释放旧的再注册，不能两个同时活着。
      if (registrations.some((r) => !r.disposed && r.providers.some((p) => providers.includes(p)))) {
        throw new Error("DUPLICATE_ADAPTER");
      }
      const record = { providers, adapter, disposed: false };
      registrations.push(record);
      // 内核返回的 handle 可调用（= 注销）+ 带 replace。replace 的真实签名是
      // `replace(providers: string[]): void` —— 只换路由名、换不了 adapter 实例，
      // 且返回 void（`dsh-llm/lib/index.js:1856`、`lib/typert.host.js:271-272`）。
      // 早先这里让 replace 返回 handle 自己、参数是 {providers,adapter} 对象，
      // 于是 ST-10 掩盖了真宿主里 `providers is not iterable` 的 bug。
      type Handle = {
        (): void;
        replace(providers: readonly string[]): void;
      };
      const handle = (() => {
        record.disposed = true;
      }) as Handle;
      handle.replace = (next) => {
        record.providers = next;
      };
      return handle;
    },
  };

  return { llm, registrations };
}

/** 一个静默 logger。 */
function silentLogger() {
  return createLogger(undefined);
}

describe("normalizeSettings", () => {
  it("ST-1: 空输入回落全部默认值", () => {
    assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(42), DEFAULT_SETTINGS);
  });

  it("ST-2: 字符串形式的布尔与数字都认（用户手编 yaml 会写引号）", () => {
    const s = normalizeSettings({ enabled: "false", contextCap: "64000", debugLog: "true" });
    assert.equal(s.enabled, false);
    assert.equal(s.contextCap, 64_000);
    assert.equal(s.debugLog, true);
  });

  it("ST-3: contextCap 越界回落默认值", () => {
    assert.equal(normalizeSettings({ contextCap: 100 }).contextCap, DEFAULT_SETTINGS.contextCap);
    assert.equal(normalizeSettings({ contextCap: 99_999_999 }).contextCap, DEFAULT_SETTINGS.contextCap);
  });

  it("ST-4: 多出来的未知字段被丢掉（不做透传）", () => {
    const s = normalizeSettings({ enabled: true, somethingElse: "x" });
    assert.deepEqual(Object.keys(s).sort(), [
      "authSource",
      "contextCap",
      "debugLog",
      "enabled",
      "qrProtocol",
      "reasoning",
      "visionProbeOverride",
    ]);
  });

  it("ST-4b: authSource 只认三个值，其它一律回落 auto", () => {
    assert.equal(normalizeSettings({ authSource: "desktop" }).authSource, "desktop");
    assert.equal(normalizeSettings({ authSource: "QR" }).authSource, "qr");
    assert.equal(normalizeSettings({ authSource: "  Auto " }).authSource, "auto");
    assert.equal(normalizeSettings({ authSource: "bogus" }).authSource, "auto");
    assert.equal(normalizeSettings({ authSource: 42 }).authSource, "auto");
  });
});

describe("createTtlCache", () => {
  it("ST-5: 命中缓存不重复 load", async () => {
    let calls = 0;
    const cache = createTtlCache(60_000, async () => {
      calls += 1;
      return calls;
    });
    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 1);
    assert.equal(calls, 1);
  });

  it("ST-6: fresh=true 强制重取", async () => {
    let calls = 0;
    const cache = createTtlCache(60_000, async () => ++calls);
    await cache.get();
    assert.equal(await cache.get(true), 2);
  });

  it("ST-7: 并发两次只发一个请求（inflight 去重）", async () => {
    let calls = 0;
    const cache = createTtlCache(60_000, async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(a, b);
    assert.equal(calls, 1);
  });

  it("ST-8: 失败不进缓存（一次抖动不该把错误缓存 5 分钟）", async () => {
    let calls = 0;
    const cache = createTtlCache(60_000, async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });
    await assert.rejects(cache.get(), /boom/);
    assert.equal(await cache.get(), "ok");
    assert.equal(calls, 2);
  });

  it("ST-9: clear() 后重新 load", async () => {
    let calls = 0;
    const cache = createTtlCache(60_000, async () => ++calls);
    await cache.get();
    cache.clear();
    assert.equal(await cache.get(), 2);
  });
});

describe("Publisher", () => {
  const models = [
    {
      id: "m1",
      name: "M1",
      api: "raccoon-chat",
      provider: "raccoon-web",
      baseUrl: "https://xiaohuanxiong.com/api/web/llm/v2",
      input: ["text"] as const,
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      headers: {},
      compat: { maxTokensField: "max_tokens" as const },
    },
  ];

  it("ST-10: 换名册必须「先释放再注册」，全程只有一个活着的 registration", () => {
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    const input = { enabled: true, reasoningEnabled: true, models, token: "tok" };
    const resolve = async () => "tok";

    assert.equal(publisher.sync(input, resolve), "published");
    assert.equal(registrations.length, 1);

    // 名册变了 → 换一份新实例：旧的必须已 released，新的接管同一个 provider。
    const changed = [{ ...models[0]!, id: "m2" }];
    assert.equal(publisher.sync({ ...input, models: changed }, resolve), "published");
    const alive = registrations.filter((r) => !r.disposed);
    assert.equal(alive.length, 1, "任何时刻只能有一个活着的 registration");
    assert.equal(registrations[0]!.disposed, true, "旧的必须先释放，否则会 DUPLICATE_ADAPTER");
    // 新注册的那份必须带的是新 adapter 实例（不能复用旧的，否则当前快照不刷新）
    assert.notEqual(registrations[1]!.adapter, registrations[0]!.adapter);
  });

  it("ST-10b: 连续换三份名册都不会丢句柄（refresh-auth 踩过的真实 bug）", () => {
    // 旧实现用 `handle.replace({providers, adapter})`，内核的签名其实是
    // `replace(providers: string[])` 且返回 void → 真宿主里点「读取客户端登录态」
    // 必现 `providers is not iterable`。这条测试盯住"换第二、第三、第四份名册"。
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    const resolve = async () => "tok";
    const base = { enabled: true, reasoningEnabled: true, models, token: "tok" as string | undefined };

    publisher.sync(base, resolve);
    publisher.sync({ ...base, models: [{ ...models[0]!, id: "m2" }] }, resolve);
    publisher.sync({ ...base, models: [{ ...models[0]!, id: "m3" }] }, resolve);
    publisher.sync({ ...base, models: [{ ...models[0]!, id: "m4" }] }, resolve);

    assert.equal(registrations.filter((r) => !r.disposed).length, 1, "只剩一个活的");
    assert.equal(registrations.length, 4, "四次 sync = 四次注册（旧的都释放了）");
    // 句柄仍在，dispose 要能真的把最后一个也放掉
    publisher.dispose("unload");
    assert.equal(registrations.filter((r) => !r.disposed).length, 0, "dispose 后一个都不剩");
  });

  it("ST-11: 签名没变时不动注册（最常见的路径）", () => {
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    const input = { enabled: true, reasoningEnabled: true, models, token: "tok" };
    const resolve = async () => "tok";
    publisher.sync(input, resolve);
    publisher.sync(input, resolve);
    publisher.sync(input, resolve);
    assert.equal(registrations.length, 1, "三次相同输入只注册一次");
  });

  it("ST-12: enabled=false → 释放并返回 disabled", () => {
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    const resolve = async () => "tok";
    publisher.sync({ enabled: true, reasoningEnabled: true, models, token: "tok" }, resolve);
    assert.equal(publisher.sync({ enabled: false, reasoningEnabled: true, models, token: "tok" }, resolve), "disabled");
    assert.equal(registrations[0]!.disposed, true);
  });

  it("ST-13: 没 token → not-configured（provider 不该出现在选择器里）", () => {
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    assert.equal(
      publisher.sync({ enabled: true, reasoningEnabled: true, models, token: undefined }, async () => undefined),
      "not-configured",
    );
    assert.equal(registrations.length, 0);
  });

  it("ST-14: 名册为空 → not-configured", () => {
    const { llm } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    assert.equal(
      publisher.sync({ enabled: true, reasoningEnabled: true, models: [], token: "tok" }, async () => "tok"),
      "not-configured",
    );
  });

  it("ST-15: reasoning 开关变化会重新注册（请求体跟着变）", () => {
    const { llm, registrations } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    const resolve = async () => "tok";
    publisher.sync({ enabled: true, reasoningEnabled: true, models, token: "tok" }, resolve);
    publisher.sync({ enabled: true, reasoningEnabled: false, models, token: "tok" }, resolve);
    assert.equal(registrations.length, 2, "开关变了必须换一份 adapter");
    assert.equal(registrations.filter((r) => !r.disposed).length, 1);
  });

  it("ST-16: dispose 可重复调（不会因为重复 dispose 而抛到外面）", () => {
    const { llm } = fakeLlm();
    const publisher = new Publisher({ llm, logger: silentLogger() });
    publisher.sync({ enabled: true, reasoningEnabled: true, models, token: "tok" }, async () => "tok");
    publisher.dispose("unload");
    publisher.dispose("unload");
    assert.equal(publisher.isPublished(), false);
  });

  it("ST-17: rosterSignature 把 vision 与 contextCap 都算进去", () => {
    assert.notEqual(rosterSignature(models), rosterSignature([{ ...models[0]!, id: "other" }]));
    assert.notEqual(
      rosterSignature(models),
      rosterSignature([{ ...models[0]!, contextWindow: 64_000 }]),
    );
    // 同样的输入必须稳定 —— 否则每次刷新都会 replace
    assert.equal(rosterSignature(models), rosterSignature(models));
  });
});

describe("isLoopback", () => {
  it("ST-18: 三种 localhost 形态都认", () => {
    assert.equal(isLoopback("127.0.0.1:57292"), true);
    assert.equal(isLoopback("localhost:57292"), true);
    assert.equal(isLoopback("[::1]:57292"), true);
  });

  it("ST-19: 非本机与缺失一律 false", () => {
    assert.equal(isLoopback("192.168.1.10:80"), false);
    assert.equal(isLoopback("evil.com"), false);
    assert.equal(isLoopback(undefined), false);
    assert.equal(isLoopback(""), false);
    assert.equal(isLoopback("[fe80::1]:80"), false);
  });
});

describe("日志脱敏", () => {
  it("ST-20: tokenTag 是 8 位 hex，且不含 token 片段", () => {
    const tag = tokenTag("xhx_super_secret_value");
    assert.match(tag, /^[0-9a-f]{8}$/);
    assert.ok(!tag.includes("xhx"));
    assert.equal(tokenTag(undefined), "-");
  });

  it("ST-21: formatLine 跳过 undefined 字段", () => {
    assert.equal(formatLine("publish/register", { models: 3, note: undefined }), "[raccoon-web] publish/register models=3");
  });

  it("ST-22: 静默 sink 不产生任何输出（绝不退回 console）", () => {
    const lines: string[] = [];
    const logger = createLogger({
      info: (m: string) => lines.push(m),
      debug: (m: string) => lines.push(m),
    });
    logger.info("a");
    logger.debug("b"); // debug 默认关
    assert.deepEqual(lines, ["[raccoon-web] a"]);
  });
});

describe("solidPng", () => {
  it("ST-23: 生成的 PNG 有正确签名与尺寸", () => {
    const png = solidPng(3, 3, [0xed, 0x1c, 0x24]);
    assert.deepEqual(Array.from(png.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR 里的宽高（大端 32 位，偏移 16 与 20）
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(view.getUint32(16), 3);
    assert.equal(view.getUint32(20), 3);
  });

  it("ST-24: PROBE_PNG_BASE64 非空且可解码", () => {
    assert.ok(PROBE_PNG_BASE64.length > 40);
    assert.deepEqual(Array.from(Buffer.from(PROBE_PNG_BASE64, "base64").slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("buildDiagnostics", () => {
  it("ST-25: 输出 13 行 key: value（含桌面端/来源/扫码协议），且不含 token", () => {
    const snapshot = {
      build: "2026-11-06T11:10",
      version: "0.1.0",
      login: { phase: "ready" as const, principal: "abc12345", kind: "xhx_token" as const, source: "qr" as const },
      publish: "published" as const,
      catalogReady: true,
      models: [{ id: "m1", name: "M1", vision: true, multiplier: 1, contextWindow: 128_000, maxTokens: 8192 }],
      quota: { available: 1234, permanent: 100, daily: 50, dailyGranted: true, at: 0 },
      settings: { ...DEFAULT_SETTINGS },
      desktopAuth: { found: false, reason: "未找到桌面客户端登录态，已回退到扫码" },
      diagnostics: "",
    };
    const text = buildDiagnostics({ build: snapshot.build, version: snapshot.version, snapshot });
    assert.equal(text.split("\n").length, 13);
    assert.ok(text.includes("插件: dsh-raccoon-web 0.1.0"));
    assert.ok(text.includes("登录: ready (xhx_token)"));
    assert.ok(text.includes("来源: 扫码"));
    assert.ok(text.includes("桌面端: 未读到"));
    assert.ok(text.includes("扫码协议: Web auth（官方桌面端同款）"));
    assert.ok(text.includes("目录: 1 个模型"));
    assert.ok(text.includes("余额: 1234"));
    // 脱敏：不能出现任何 token 形态
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text));
    assert.ok(!text.includes("xhx_super"));
  });
});

describe("store 落盘", () => {
  it("ST-26: 写 token 用原子写（.tmp + rename），且能读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raccoon-store-"));
    // dataDir() 每次调用都读 DSH_HOME，所以只要在动作之前设好就行
    const previous = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = dir;
    try {
      await store.saveToken({
        schemaVersion: 1,
        token: "tok-abc",
        kind: "xhx_token",
        savedAt: Date.now(),
        principal: "p1",
      });
      const read = await store.readToken();
      assert.equal(read?.token, "tok-abc");
      assert.equal(read?.principal, "p1");

      // 落盘的内容是可解析的 JSON，且没有中间 .tmp 残留
      const file = join(store.dataDir(), "token.json");
      const raw = await readFile(file, "utf8");
      assert.equal(JSON.parse(raw).schemaVersion, 1);

      await store.clearToken();
      assert.equal(await store.readToken(), undefined);
    } finally {
      if (previous === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ST-27: schemaVersion 不是 1 时 readToken 返回 undefined（不迁移）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raccoon-store2-"));
    const previous = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = dir;
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(store.dataDir(), { recursive: true });
      await writeFile(join(store.dataDir(), "token.json"), JSON.stringify({ schemaVersion: 2, token: "old" }), "utf8");
      assert.equal(await store.readToken(), undefined);
    } finally {
      if (previous === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
