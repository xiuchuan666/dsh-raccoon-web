/**
 * 号池端到端冒烟（真 `RaccoonHost` + 假网关，不碰网络、不碰真实 `~/.dsh`）。
 *
 * 单测（`test/pool.test.ts`）只覆盖纯函数；真宿主已经人工跑过一遍
 * （见 `devlog/2026-11-11.md`），但那不能进 CI。这个脚本补上中间那段：
 * **把 `RaccoonHost` 装起来，用假网关驱动六个号池 action**，断言它们
 * 真的改动了 `accounts.json`、真的把设备身份带进了请求头、真的在换号时
 * 重建了名册。
 *
 * 它证明的五件事（都是单测证明不了的）：
 *
 * 1. `readPool()` 在 `bootstrap()` 里被读进来，`status.pool` 与诊断第 14 行一致。
 * 2. `pool-test` 打的是**目录端点**（零 token 成本），且带上该账号自己的
 *    `x-client-device-id` —— 这是"独立环境"在真实请求里的唯一证据。
 * 3. 换号会**换一份名册**（`Publisher` 的指纹含 `dev:`），旧 registration 被释放。
 * 4. `pool-checkin` 先查后写：今天已签的号不发写请求，只给没签的发。
 * 5. `pool-toggle` / `pool-remove` 落盘，且 `status` 里**永远不出现 token**。
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/smoke-pool.mjs
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "raccoon-pool-smoke-"));
process.env["DSH_HOME"] = home;
// 桌面端凭据也要落在临时目录里，否则会读到开发者本机真实登录着的客户端。
process.env["USERPROFILE"] = home;
process.env["HOME"] = home;
delete process.env["BOX_AGENT_CONFIG_DIR"];
delete process.env["BOX_AGENT_HOME"];

const { RaccoonHost } = await import("../packages/dsh-raccoon-web/src/host/index.js");
const { createLogger } = await import("../packages/dsh-raccoon-web/src/host/log.js");
const { normalizeSettings } = await import("../packages/dsh-raccoon-web/src/host/settings.js");
const { readToken } = await import("../packages/dsh-raccoon-web/src/host/store.js");
const { poolAccountId, poolFile, readPool } = await import("../packages/dsh-raccoon-web/src/host/pool.js");
const { raccoonDay } = await import("../packages/dsh-raccoon-web/src/protocol/points.js");

const failures = [];
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  else {
    console.log(`  ❌ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------------ 假 token

/** 造一个不验签的 JWT。`principalOf()` 只读 payload 的 `sub`。 */
function fakeJwt(claims) {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;
}

const TOKEN_A = fakeJwt({ sub: "pu-account-a", exp: Math.floor(Date.now() / 1000) + 86_400 });
const TOKEN_B = fakeJwt({ sub: "pu-account-b", exp: Math.floor(Date.now() / 1000) + 172_800 });
const TOKEN_DEAD = fakeJwt({ sub: "pu-account-dead", exp: Math.floor(Date.now() / 1000) + 3_600 });
/** 浏览器 loopback 换出来的号（第 9 段用）。 */
const TOKEN_C = fakeJwt({ sub: "pu-account-c", exp: Math.floor(Date.now() / 1000) + 259_200 });

/** 从 `Authorization: Bearer xxx` 里认出是哪个号。 */
function whoOf(headers) {
  const raw = headers?.authorization ?? headers?.Authorization ?? "";
  const token = String(raw).replace(/^Bearer\s+/iu, "");
  if (token === TOKEN_A) return "A";
  if (token === TOKEN_B) return "B";
  if (token === TOKEN_DEAD) return "DEAD";
  return "?";
}

// ------------------------------------------------------------------ 假网关

const CATALOG = {
  code: 0,
  data: {
    categories: [
      {
        type: "chat",
        default_model: "sn-kimi-k3",
        models: [
          {
            name: "sn-kimi-k3",
            description: "Kimi-K3",
            visible: true,
            tags: ["general", "vision"],
            params: { context_window: 1_000_000, max_tokens: 65_536 },
            billing_multiplier: 1,
          },
        ],
      },
    ],
  },
};

const TODAY = raccoonDay(Date.now());
const calls = [];
let grantCalls = 0;
/**
 * 让 A 的凭据"突然失效"（第 6.6 段用）。
 *
 * 不能靠池里那个 DEAD 账号来造这个场景：它在第 3 段被 `pool-test` 标成 `dead`、
 * `until = MAX_SAFE_INTEGER`，`sortForUse()` 不会再选它，于是"池成员在服务但
 * 凭据坏了"这个状态根本造不出来 —— 造不出来就测不到 `markDead()` 的护栏。
 */
let killA = false;
/** 每次签到写请求打的是哪个号。用来断言"已签的号没有白打一次写请求"。 */
const grantWho = [];
/** 换码端点被调了几次（浏览器 loopback 段用）。 */
let exchangeCalls = 0;

const fetchImpl = async (input, init = {}) => {
  const url = String(input);
  const headers = init.headers ?? {};
  const who = whoOf(headers);
  calls.push({ url, who, device: headers["x-client-device-id"] ?? headers["X-Client-Device-ID"], method: init.method ?? "GET" });

  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url.includes("/model_catalog")) {
    if (who === "DEAD") return json(401, { code: 401, message: "authorization invalid" });
    if (killA && who === "A") return json(401, { code: 401, message: "authorization invalid" });
    return json(200, CATALOG);
  }
  if (url.includes("/points/v1/balance")) {
    // A 的日更积分低、B 高 —— 排序第二层应当把 B 排在前面。
    const daily = who === "B" ? 500 : 100;
    return json(200, { code: 0, data: { available_points: 1_000, reward_points: 900, daily_points: daily } });
  }
  if (url.includes("/v2/bills")) {
    // A 今天已经签过；B 没签。
    const items =
      who === "A"
        ? [{ biz_type: "daily_grant", points: 100, grant_at: `${TODAY}T00:05:00+08:00` }]
        : [];
    return json(200, { code: 0, data: { items } });
  }
  if (url.includes("/login_with_authorization_code")) {
    exchangeCalls += 1;
    const body = JSON.parse(String(init.body ?? "{}"));
    if (body.authorization_code === "bad-code") {
      return json(400, { code: 200035, message: "authorization_code_not_found_error" });
    }
    return json(200, { code: 0, message: "success", data: { access_token: TOKEN_C } });
  }
  if (url.includes("/login/points/grant")) {
    grantCalls += 1;
    grantWho.push(who);
    // DEAD 的凭据是坏的：签到写接口也要 401，这样才测得到"签到失败 → 测量状态"。
    if (who === "DEAD") {
      return json(401, { code: 200003, message: "authorization_verify_error", details: "authorization verify failed" });
    }
    return json(200, { code: 0, message: "success", data: { granted: true, popup: null } });
  }
  return json(404, { code: 404, message: "not found" });
};

// --------------------------------------------------------------- 预置状态

await mkdir(join(home, ".office-raccoon", "agent", "config"), { recursive: true });
await writeFile(
  join(home, ".office-raccoon", "agent", "config", "auth.json"),
  JSON.stringify({ access_token: TOKEN_A, office_identity: "personal" }),
  "utf8",
);

const DEVICE_A = `raccoon-${"a".repeat(32)}`;
const DEVICE_B = `raccoon-${"b".repeat(32)}`;
const DEVICE_DEAD = `raccoon-${"d".repeat(32)}`;
await mkdir(dirname(poolFile()), { recursive: true });
await writeFile(
  poolFile(),
  JSON.stringify({
    schemaVersion: 1,
    accounts: [
      {
        id: "6e415868f0d0100a",
        token: TOKEN_A,
        kind: "access_token",
        principal: "pu-account-a",
        addedAt: 1,
        enabled: false,
        deviceId: DEVICE_A,
        source: "desktop",
      },
      {
        id: "e19de1ab797f0b40",
        token: TOKEN_B,
        kind: "access_token",
        principal: "pu-account-b",
        addedAt: 2,
        enabled: false,
        deviceId: DEVICE_B,
        source: "qr",
      },
      {
        id: "67ca1dec16c583c5",
        token: TOKEN_DEAD,
        kind: "access_token",
        principal: "pu-account-dead",
        addedAt: 3,
        enabled: false,
        deviceId: DEVICE_DEAD,
        source: "qr",
      },
    ],
  }),
  "utf8",
);

// ------------------------------------------------------------------ 假服务

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
      if (adapter.providerRetryPolicy?.(provider) === undefined) throw new Error("INVALID_ADAPTER: 没有 retryPolicy");
    }
    const record = { providers, adapter, disposed: false };
    registered.push(record);
    const handle = () => {
      record.disposed = true;
    };
    // 内核的真实签名是 `replace(providers: string[]): void` —— 换不了实例。
    handle.replace = (next) => {
      replaceCount += 1;
      record.providers = next;
    };
    return handle;
  },
};

function fakeSettings() {
  let current;
  const watchers = new Set();
  return {
    register(_ns, schema) {
      // 用**真实的** `normalizeSettings` 做 schema（不是 `(raw) => raw`）——
      // 否则 `enabled` / `reasoning` / `authSource` 全是 undefined，
      // `Publisher.sync()` 的第一道门控就会把 provider 判成 disabled。
      current = schema({ poolEnabled: true });
      return {
        get: () => current,
        watch: (cb) => {
          watchers.add(cb);
          return () => watchers.delete(cb);
        },
        update: (patch) => {
          const prev = current;
          current = schema({ ...current, ...patch });
          for (const cb of watchers) cb(current, prev);
        },
        replace: (section) => {
          current = schema(section);
        },
      };
    },
  };
}

const settingsService = fakeSettings();
const settings = settingsService.register("dsh-raccoon-web", normalizeSettings);

// 收日志，用来断言"只读路径没有副作用"（见第 1 段末尾）。
const logLines = [];
const logSink = {
  debug: (line) => logLines.push(line),
  info: (line) => logLines.push(line),
  warn: (line) => logLines.push(line),
  error: (line) => logLines.push(line),
};

const host = new RaccoonHost({
  logger: createLogger(logSink),
  settings,
  llm,
  version: "0.1.0",
  build: "smoke-pool",
  fetchImpl,
  now: Date.now,
  desktopHome: home,
});

const poolOf = (result) => result?.pool;
const act = (action, body) => host.runAction(action, body ?? {});
const status = async () => JSON.parse(JSON.stringify(await host.snapshot()));

// --------------------------------------------------------------------- 跑

console.log("\n== 1. bootstrap 把 accounts.json 读进来 ==");
await host.bootstrap();
await new Promise((r) => setTimeout(r, 150));
let snap = await status();
check("池里 3 个账号", snap.pool?.total === 3, `${snap.pool?.total}`);
check("一个都没启用（读盘时不猜用户意图）", snap.pool?.enabledCount === 0, `${snap.pool?.enabledCount}`);
check("poolEnabled 来自设置", snap.pool?.enabled === true, String(snap.pool?.enabled));
check("有 note 解释为什么没有活跃账号", typeof snap.pool?.note === "string", snap.pool?.note);
const diagLines = String(snap.diagnostics).split("\n");
check("诊断 14 行", diagLines.length === 14, `${diagLines.length}`);
check("第 14 行是号池", diagLines[13]?.startsWith("号池:"), diagLines[13]);
check("诊断里没有 token", /eyJ/u.test(String(snap.diagnostics)) === false);
check(
  "device 只给 8 位十六进制（不带 raccoon- 前缀）",
  snap.pool.accounts.every((a) => /^[0-9a-f]{8}$/u.test(a.device)),
  snap.pool.accounts.map((a) => a.device).join(","),
);

console.log("\n== 2. pool-import-desktop：同 principal 不产生第二条 ==");
const imported = await act("pool-import-desktop");
check("导入成功", imported.ok === true, imported.error);
check("总数仍是 3（upsert 而不是追加）", poolOf(imported)?.total === 3, `${poolOf(imported)?.total}`);
check("导入后仍不自动启用", poolOf(imported)?.enabledCount === 0, `${poolOf(imported)?.enabledCount}`);

console.log("\n== 3. pool-test：打目录端点、带自己的设备身份 ==");
const testedB = await act("pool-test", { id: "e19de1ab797f0b40" });
check("B 健康", testedB.ok === true && testedB.healthy === true, JSON.stringify(testedB.message ?? ""));
check("measure 是 ok", poolOf(testedB)?.accounts.find((a) => a.id === "e19de1ab797f0b40")?.measure?.state === "ok");
const catalogCallB = calls.filter((c) => c.url.includes("/model_catalog") && c.who === "B").pop();
check("目录请求用的是 B 的 token", catalogCallB !== undefined);
check("目录请求带上了 B 的 x-client-device-id", catalogCallB?.device === DEVICE_B, String(catalogCallB?.device));

const testedDead = await act("pool-test", { id: "67ca1dec16c583c5" });
const deadMeasure = poolOf(testedDead)?.accounts.find((a) => a.id === "67ca1dec16c583c5")?.measure;
check("dead 号测试失败", testedDead.ok === true && testedDead.healthy === false);
check("记成 dead", deadMeasure?.state === "dead", deadMeasure?.state);
check("dead 的 until 是 MAX_SAFE_INTEGER（只能手动测试回池）", deadMeasure?.until === Number.MAX_SAFE_INTEGER, String(deadMeasure?.until));

console.log("\n== 4. 勾选 B → 它成为当前账号，名册换成它的设备身份 ==");
const beforeRegistrations = registered.length;
const toggledB = await act("pool-toggle", { id: "e19de1ab797f0b40", enabled: true });
check("勾选成功", toggledB.ok === true, toggledB.error);
check("enabledCount = 1", poolOf(toggledB)?.enabledCount === 1, `${poolOf(toggledB)?.enabledCount}`);
check("activeId 是 B", poolOf(toggledB)?.activeId === "e19de1ab797f0b40", poolOf(toggledB)?.activeId);
check("仍然 published", poolOf(toggledB) !== undefined && (await status()).publish === "published");
check(
  "换号触发了一次重新注册（指纹含 dev:）",
  registered.length === beforeRegistrations + 1,
  `${beforeRegistrations} → ${registered.length}`,
);
check("旧 registration 已释放", registered.filter((r) => !r.disposed).length === 1, `${registered.filter((r) => !r.disposed).length}`);
check("没有误用 handle.replace", replaceCount === 0, String(replaceCount));

console.log("\n== 5. 再勾选 A → 排序按 daily 把 B 留在前面（不来回跳） ==");
const toggledA = await act("pool-toggle", { id: "6e415868f0d0100a", enabled: true });
check("A 也启用了", poolOf(toggledA)?.enabledCount === 2, `${poolOf(toggledA)?.enabledCount}`);
check(
  "B 的 daily 更高（500 vs 100）→ 仍用 B",
  poolOf(toggledA)?.activeId === "e19de1ab797f0b40",
  poolOf(toggledA)?.activeId,
);

console.log("\n== 6. 关掉 B → 退回 A，名册再换一次 ==");
const afterOffB = await act("pool-toggle", { id: "e19de1ab797f0b40", enabled: false });
check("只剩 A 启用", poolOf(afterOffB)?.enabledCount === 1, `${poolOf(afterOffB)?.enabledCount}`);
check("activeId 变成 A", poolOf(afterOffB)?.activeId === "6e415868f0d0100a", poolOf(afterOffB)?.activeId);

console.log("");
console.log("== 6.5 只读路径（status）稳定，且轮询不放大号池日志 ==");
// `status` 每 20 秒被前端轮询一次，它要展示"当前用的是哪个号"。
//
// **这条断言证明什么、不证明什么，写清楚**：
// - 证明（回归护栏）：反复轮询 `status` 不会产生成串的 `pool/pick`，且每次
//   报的当前号一致。池刚被打开、`poolActiveId` 还是 undefined 时，第一次
//   轮询会选一次号（`snapshot()` 顺手 `void refreshQuota()` 需要知道用哪个号），
//   之后必须粘住 —— 至多 1 条，不能 5 条。
// - 不证明：读路径完全不选号。`snapshot()` 会去取余额，那条路真的需要知道
//   用哪个号，这是设计意图。
// - 也不声称旧实现"可观测地坏了"：旧实现把选号写在 `poolSnapshot()` 里，
//   但"粘住"逻辑让重复轮询也只打一条。这次改动是把**状态写入**从读路径上
//   拿掉（`peekPoolAccount()` 不改 `poolActiveId`、不打日志），属于正确的
//   分层，而不是修一个用户能看见的 bug。
//
// 怎么让"第一次"真的发生：先关池（会清 `poolActiveId`，且关着不打日志），
// 再**绕过 host action 直接改设置**把池打开，于是第一次 status 就是
// "读路径第一次遇到需要选号"。
await act("set-setting", { key: "poolEnabled", value: false });
settings.update({ poolEnabled: true });
logLines.length = 0;
const polls = [];
for (let i = 0; i < 5; i += 1) polls.push(await status());
const pickLines = logLines.filter((line) => line.includes("pool/pick"));
check("连查五次 status 都不抛", polls.every((p) => p.pool !== undefined));
check(
  "五次轮询报的当前号一致（A）",
  polls.every((p) => p.pool?.activeId === "6e415868f0d0100a"),
  polls.map((p) => String(p.pool?.activeId)).join(","),
);
check(
  "五次轮询最多只选一次号（粘住之后不再打 pool/pick）",
  pickLines.length <= 1,
  `${pickLines.length} 条：${pickLines.join(" | ")}`,
);

// 号池开着、而 `token.json` 里**没有**当前账号时，`status.login.principal` 必须
// 报池里真正在服务的那一个，而不是 `—`。
//
// 这个场景在真实世界里很常见：用户装过官方客户端、只用"导入客户端账号"把号加进
// 池，从没扫过码。早先 `snapshot()` 直接把 `this.token` 传给 `loginBlock()`，
// 设置卡"账号"那行永远是 `—`，看着像没登录。
//
// 怎么造出"没有当前账号"：把来源改成只允许扫码（`authSource = "qr"`），
// 而夹具里**没有** `token.json` —— 于是 `this.token` 真的是 undefined，
// 唯一能服务的就是池成员。不这么造的话这条断言恒真（桌面端凭据的 principal
// 和池成员 A 的 principal 是同一个，测不出区别）。
settings.update({ authSource: "qr" });
await act("refresh-auth");
const poolOnly = await status();
check(
  "只有池成员可用时 login.principal 报池成员（不是 —）",
  poolOnly.login?.principal === "pu-accou",
  String(poolOnly.login?.principal),
);
check(
  "只有池成员可用时 login.source 报池成员的来源（desktop，因为是导入的）",
  poolOnly.login?.source === "desktop",
  String(poolOnly.login?.source),
);
// 反向：关掉池之后一个凭据都没有了，展示层必须跟着退回 `—`，
// 不能把池成员的 principal 留在那里（否则用户会以为还在用池里的号）。
await act("set-setting", { key: "poolEnabled", value: false });
const noToken = await status();
check(
  "关掉池且没有当前账号时 login.principal 退回 —（不留池成员）",
  noToken.login?.principal === undefined,
  String(noToken.login?.principal),
);
// 还原成后续段落期待的状态：池开、来源 auto、桌面端凭据重新读到。
await act("set-setting", { key: "poolEnabled", value: true });
settings.update({ authSource: "auto" });
await act("refresh-auth");

console.log("\n== 6.6 池成员的凭据坏了，不能把主登录判死 ==");
// `refreshCatalog()` 拿到 AUTH 时曾经无条件 `loginFlow.markDead()`。号池在服务时
// 坏掉的是**池成员**的凭据，主登录（桌面端凭据 / 扫码 token）根本没动 ——
// 那时把相位改成 `expired` 并提示"请重新扫码"，用户会以为整个插件掉线了，
// 而实际上下一次请求就自动换号了。
//
// 这一段是这条护栏的正反两面：
// - 池在服务 + 池成员 AUTH → **不许** markDead；
// - 没有池成员 + 桌面端凭据 AUTH → 必须 markDead，而且提示的是
//   "打开官方客户端"（他从来没扫过码，叫他扫码是错的）。
killA = true;
await act("refresh-catalog", { force: true });
const pooledAuthFail = await status();
check(
  "池成员凭据失效时主登录相位不被判死（仍是 ready）",
  pooledAuthFail.login?.phase === "ready",
  `${pooledAuthFail.login?.phase} / ${String(pooledAuthFail.login?.message)}`,
);
check("目录确实失败了（不是没打请求）", pooledAuthFail.catalogReady === false, String(pooledAuthFail.catalogReady));
killA = false;
await act("refresh-catalog", { force: true });
check("恢复后目录又能拉到", (await status()).catalogReady === true);

// 反向：关掉池，桌面端凭据自己失效 → 必须判死，且文案指向官方客户端。
await act("set-setting", { key: "poolEnabled", value: false });
killA = true;
await act("refresh-catalog", { force: true });
const desktopDead = await status();
check(
  "没有池成员且桌面端凭据失效时判死（phase = expired）",
  desktopDead.login?.phase === "expired",
  String(desktopDead.login?.phase),
);
check(
  "桌面端路线失效的提示指向官方客户端，而不是「重新扫码」",
  String(desktopDead.login?.message ?? "").includes("官方客户端"),
  String(desktopDead.login?.message),
);
killA = false;
await act("set-setting", { key: "poolEnabled", value: true });
await act("refresh-auth");
await act("refresh-catalog", { force: true });
check("还原后主登录恢复 ready", (await status()).login?.phase === "ready");

console.log("\n== 7. 一键签到：先查后写，只给没签的发写请求 ==");
const grantsBefore = grantCalls;
const checkin = await act("pool-checkin");
check("签到动作成功", checkin.ok === true, checkin.error);
const rows = checkin.results ?? [];
check("每个账号都有一行结果（含未启用的）", rows.length === 3, `${rows.length}`);
check(
  "A 今天已签 → already",
  rows.find((r) => r.id === "6e415868f0d0100a")?.result === "already",
  rows.find((r) => r.id === "6e415868f0d0100a")?.result,
);
check(
  "B 没签 → granted",
  rows.find((r) => r.id === "e19de1ab797f0b40")?.result === "granted",
  rows.find((r) => r.id === "e19de1ab797f0b40")?.result,
);
check(
  "只给没签的号发写请求（A 今天已签，没有白打一次 grant）",
  grantWho.join(",") === "B" || grantWho.join(",") === "B,DEAD",
  `grant 打到了: ${grantWho.join(",") || "(无)"}（共 ${grantCalls - grantsBefore} 次）`,
);
// 签到是用户主动发起的，它拿到的失败信号比对话中途的 `onResponse` 更可信：
// 凭据真的废了就该在卡片上显示「凭据失效」，而不是继续被选去服务。
const deadRow = rows.find((r) => r.id === "67ca1dec16c583c5");
check(
  "凭据失效的号在签到结果里是 error",
  deadRow?.result === "error",
  String(deadRow?.result),
);
const afterCheckin = await readPool();
check(
  "签到失败也落成测量状态（dead）",
  afterCheckin.find((a) => a.id === "67ca1dec16c583c5")?.measure?.state === "dead",
  afterCheckin.find((a) => a.id === "67ca1dec16c583c5")?.measure?.state,
);
check(
  "签到写盘没有抹掉别的号（合并后仍 3 条）",
  afterCheckin.length === 3,
  `${afterCheckin.length}`,
);

console.log("\n== 8. 落盘与 token 安全 ==");
const onDisk = await readPool();
check("accounts.json 里有 3 条", onDisk.length === 3, `${onDisk.length}`);
check("A 的勾选已落盘", onDisk.find((a) => a.id === "6e415868f0d0100a")?.enabled === true);
check("B 的勾选已落盘（关掉了）", onDisk.find((a) => a.id === "e19de1ab797f0b40")?.enabled === false);
check("池模式没有改写 token.json", (await readToken()) === undefined);
snap = await status();
const dump = JSON.stringify(snap);
check("status 里没有 token 原文", dump.includes(TOKEN_A) === false && dump.includes(TOKEN_B) === false);
check("status 里没有 deviceId 全文（只给 8 位）", dump.includes(DEVICE_A) === false && dump.includes(DEVICE_B) === false);

console.log("\n== 9. 浏览器 loopback 加号（ADR-0012）==");
const browserStart = await act("pool-add-browser");
check("起服务成功", browserStart.ok === true, browserStart.error);
const browserInfo = browserStart.browser ?? {};
check("browser.active 为真", browserInfo.active === true, String(browserInfo.active));
check(
  "给的是 /authorize 且带 desktop_callback=loopback",
  String(browserInfo.url).includes("/authorize?") && String(browserInfo.url).includes("desktop_callback=loopback"),
  String(browserInfo.url).slice(0, 90),
);
check(
  "redirect 指向 127.0.0.1 的回调路径",
  String(browserInfo.url).includes(encodeURIComponent(`http://127.0.0.1:${browserInfo.port}/auth/callback`)),
  `port=${browserInfo.port}`,
);
const stateC = new URL(String(browserInfo.url)).searchParams.get("state");
check("state 是 64 位 hex", /^[a-f0-9]{64}$/u.test(String(stateC)), String(stateC).slice(0, 12));

// 错 state：必须 400，且不能打换码端点。
const exchangeBefore = exchangeCalls;
const badState = await fetch(`http://127.0.0.1:${browserInfo.port}/auth/callback?code=x&state=${"0".repeat(64)}`);
await badState.text();
check("错 state → 400", badState.status === 400, `${badState.status}`);
check("错 state 不打换码端点", exchangeCalls === exchangeBefore, `${exchangeCalls - exchangeBefore} 次`);

// 换码失败：页面 502，且不入池。
const badCode = await fetch(`http://127.0.0.1:${browserInfo.port}/auth/callback?code=bad-code&state=${stateC}`);
const badPage = await badCode.text();
check("换码失败 → 502", badCode.status === 502, `${badCode.status}`);
check("失败原因写进页面", badPage.includes("authorization_code_not_found_error"), `页面长度 ${badPage.length}`);
await new Promise((r) => setTimeout(r, 120));
check("失败后 browser 收摊", (await status()).browser?.active === false);
check(
  "失败没污染号池",
  (await status()).pool?.total === 3,
  `${(await status()).pool?.total}`,
);

// 正常一轮：起服务 → 回调 → 换 token → 入池。
const round2 = await act("pool-add-browser");
const info2 = round2.browser ?? {};
const state2 = new URL(String(info2.url)).searchParams.get("state");
const okRes = await fetch(`http://127.0.0.1:${info2.port}/auth/callback?code=good-code&state=${state2}`);
const okPage = await okRes.text();
check("合法回调 → 200", okRes.status === 200, `${okRes.status}`);
check("结果页说登录成功", okPage.includes("登录成功"), `页面长度 ${okPage.length}`);
await new Promise((r) => setTimeout(r, 200));
const afterBrowser = await status();
check("browser 收摊并给出成功提示", afterBrowser.browser?.active === false && String(afterBrowser.browser?.message).includes("已加入账号池"), String(afterBrowser.browser?.message));
check("池里多了一个号（3 → 4）", afterBrowser.pool?.total === 4, `${afterBrowser.pool?.total}`);
const newOne = (afterBrowser.pool?.accounts ?? []).find((a) => a.id === poolAccountId("pu-account-c"));
check("新号 source 是 browser", newOne?.source === "browser", String(newOne?.source));
check("新号默认未启用", newOne?.enabled === false, `enabled=${String(newOne?.enabled)}`);
check("新号有独立设备标识（8 位 hex）", /^[0-9a-f]{8}$/u.test(String(newOne?.device)), String(newOne?.device));
check("新号没被拿去发请求（active 为假）", newOne?.active === false, `active=${String(newOne?.active)}`);

// 取消：起服务再取消，必须收摊且不入池。
const round3 = await act("pool-add-browser");
const cancel = await act("pool-add-browser-cancel");
check("取消成功", cancel.ok === true, cancel.error);
check("取消后 browser 收摊", cancel.browser?.active === false);
check("取消后池不变", (await status()).pool?.total === 4, `${(await status()).pool?.total}`);
const cancelAgain = await act("pool-add-browser-cancel");
check("重复取消 → ok:false", cancelAgain.ok === false, cancelAgain.error);
void round3;

console.log("\n== 10. pool-remove ==");
const removed = await act("pool-remove", { id: "67ca1dec16c583c5" });
check("移除成功", removed.ok === true, removed.error);
check("剩 3 个", poolOf(removed)?.total === 3, `${poolOf(removed)?.total}`);
const missing = await act("pool-remove", { id: "nope" });
check("移除不存在的 id → ok:false", missing.ok === false, missing.error);

console.log("\n== 11. 卸载 ==");
host.dispose();
check("全部 registration 都已注销", registered.every((r) => r.disposed), `${registered.length} 个`);

await rm(home, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log("✓ 号池冒烟全绿");
  process.exit(0);
} else {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
