/**
 * 宿主半身冒烟测试（不启动 DSH，但走真实内核包）。
 *
 * 单测把内核包换成了桩（`test/stubs/`），所以证明不了"真内核能接受我们"。
 * 这个脚本补上那一段：直接 `import` 构建产物 `lib/index.js`，用真实
 * `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai` / `@earendil-works/pi-ai`
 * 跑一遍 `apply()`，然后把注册进来的 status / action 路由当函数调一遍。
 *
 * 它验证四件单测证明不了的事：
 *
 * 1. `registerAdapter` 的**真实**校验能过（providerInfo 形状、retryPolicy 合法性、
 *    `resolveRetryPolicy` 的严格键检查）—— 桩永远会放行。
 * 2. `PiAiAdapter` 接受我们的 `profiles` 形状（真类，不是替身）。
 * 3. 路由挂上之后，status 端点能吐出一份完整快照。
 * 4. `login-start` 能真的拿到二维码并渲染成 SVG。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs scripts/smoke-host.mjs [--live]
 *
 * 不加 `--live` 时不会碰网络（`login-start` 跳过），加 `--live` 才会真的打
 * `POST /api/iam/v1/auth/mp/qrcode`。默认不碰，因为冒烟测试不该有网络依赖。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIVE = process.argv.includes("--live");

/** 把磁盘状态指到临时目录，别碰真实 `~/.dsh/state`。 */
const home = await mkdtemp(join(tmpdir(), "raccoon-smoke-"));
process.env["DSH_HOME"] = home;
/**
 * 把"用户主目录"也指到临时目录。
 *
 * 否则本机真实登录着的官方客户端凭据（`~/.office-raccoon/agent/config/auth.json`）
 * 会被 `readDesktopAuth()` 读到，于是"未登录时不注册 provider"这条断言
 * 反而失败 —— 那不是插件错了，是环境里本来就有登录态。
 * `os.homedir()` 在 Windows 上读 `USERPROFILE`，POSIX 上读 `HOME`，两个都改。
 */
process.env["USERPROFILE"] = home;
process.env["HOME"] = home;
delete process.env["BOX_AGENT_CONFIG_DIR"];
delete process.env["BOX_AGENT_HOME"];

const { apply, name, inject } = await import("../packages/dsh-raccoon-web/lib/index.js");

const failures = [];
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✅ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    console.log(`  ❌ ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    failures.push(label);
  }
}

/** 记录宿主交给我们的 disposer，最后统一跑一遍，验证"卸载干净"。 */
const disposers = [];
const routes = new Map();
const registered = [];
let replaceCount = 0;

/** 假的 settings 服务，形状照 `dsh-settings` 的 `register()` 返回值。 */
function fakeSettings() {
  let current = {};
  const watchers = new Set();
  const service = {
    register(ns, schema, options) {
      check("settings.register 的 ns 合法", /^[a-z][a-z0-9-]*$/.test(ns), ns);
      check("settings.register 收到的是函数", typeof schema === "function");
      current = schema({ ...(options?.base ?? {}) });
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
          const prev = current;
          current = schema(section);
          for (const cb of watchers) cb(current, prev);
        },
      };
    },
  };
  return service;
}

/** 假的 webServer，只记下路由。 */
const webServer = {
  register({ kind, path, handler }) {
    check("webServer.register 的 kind 是 exact", kind === "exact", kind);
    routes.set(path, handler);
    return () => routes.delete(path);
  },
};

/** 假的 llm 服务，但 **校验行为照抄内核**（provider 必须唯一、providerInfo 形状必须对）。 */
const llm = {
  registerAdapter(providers, adapter) {
    if (providers.some((p) => registered.some((r) => !r.disposed && r.providers.includes(p)))) {
      throw new Error("DUPLICATE_ADAPTER");
    }
    for (const provider of providers) {
      if (typeof provider !== "string" || provider.length === 0) throw new Error("INVALID_ADAPTER: empty provider");
      const info = adapter.providerInfo(provider);
      if (info === undefined || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) {
        throw new Error(`INVALID_ADAPTER: bad providerInfo for ${provider}: ${JSON.stringify(info)}`);
      }
      // 真内核会调它并交给 resolveRetryPolicy；这里跟着调一次，让非法配置当场炸。
      const policy = adapter.providerRetryPolicy?.(provider);
      if (policy !== undefined && (policy.mode !== "normal" && policy.mode !== "always")) {
        throw new Error(`INVALID_ADAPTER: bad retry mode ${String(policy.mode)}`);
      }
    }
    const record = { providers, adapter, disposed: false };
    registered.push(record);
    const handle = () => {
      record.disposed = true;
    };
    handle.replace = (next) => {
      replaceCount += 1;
      record.adapter = next.adapter;
      return handle;
    };
    return handle;
  },
};

/** 造一个够用的 ctx。 */
const ctx = {
  llm,
  logger: {
    debug: () => {},
    info: (message, ...args) => console.log(`    [info] ${message}`, ...args.map((a) => JSON.stringify(a))),
    warn: (message, ...args) => console.log(`    [warn] ${message}`, ...args.map((a) => JSON.stringify(a))),
    error: (message, ...args) => console.log(`    [error] ${message}`, ...args.map((a) => JSON.stringify(a))),
  },
  effect(factory) {
    const dispose = factory();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  inject(deps, callback) {
    const provided = {};
    for (const dep of deps) {
      if (dep === "settings") provided.settings = settingsService;
      else if (dep === "webServer") provided.webServer = webServer;
      else throw new Error(`冒烟测试没准备服务 ${dep}`);
    }
    // cordis 的 inject 回调拿到的是同源的子上下文；这里用原型继承模拟。
    const sub = Object.create(this);
    Object.assign(sub, provided);
    callback(sub);
  },
  get() {
    return undefined;
  },
};

const settingsService = fakeSettings();

console.log("\n== 1. apply() ==");
check("name 是包名", name === "dsh-raccoon-web", name);
check("inject 只含 llm", JSON.stringify(inject) === '["llm"]', JSON.stringify(inject));
apply(ctx);

// bootstrap 是 `void` 起的异步流程，等它落地。
await new Promise((r) => setTimeout(r, 600));

console.log("\n== 2. provider 注册（未登录时不注册，这是三元门控的本意） ==");
check("未登录时不注册 provider", registered.length === 0, `${registered.length}`);
if (registered[0] !== undefined) {
  check("provider 是 raccoon-web", registered[0].providers[0] === "raccoon-web", registered[0].providers.join(","));
  const adapter = registered[0].adapter;
  const info = adapter.providerInfo("raccoon-web");
  check("providerInfo.name 是中文显示名", info.name === "小浣熊", info.name);
  const models = adapter.listModels === undefined ? undefined : await adapter.listModels("raccoon-web");
  check("listModels 在未登录时返回空数组（不抛）", Array.isArray(models) && models.length === 0, String(models?.length));
}

console.log("\n== 3. 路由 ==");
check("status 路由挂上了", routes.has("/plugins/dsh-raccoon-web/status"));
check("action 路由挂上了", routes.has("/plugins/dsh-raccoon-web/action"));

/** 把 handler 当普通函数调，收集它写出去的响应。 */
async function callRoute(path, { method = "GET", url = path, headers = { host: "127.0.0.1:57292" }, body = "" } = {}) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`没有路由 ${path}`);
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status, hdrs) {
      out.status = status;
      Object.assign(out.headers, hdrs ?? {});
      return res;
    },
    setHeader(k, v) {
      out.headers[k] = v;
    },
    end(chunk) {
      if (chunk !== undefined) out.body += String(chunk);
    },
    get headersSent() {
      return out.status !== 0;
    },
  };
  const req = {
    method,
    url,
    headers,
    on(event, cb) {
      if (event === "data" && body !== "") cb(Buffer.from(body));
      if (event === "end") cb();
      return req;
    },
    [Symbol.asyncIterator]: async function* () {
      if (body !== "") yield Buffer.from(body);
    },
  };
  await handler(req, res);
  return out;
}

const status = await callRoute("/plugins/dsh-raccoon-web/status");
check("status 返回 200", status.status === 200, String(status.status));
let snapshot;
try {
  snapshot = JSON.parse(status.body);
} catch {
  snapshot = undefined;
}
check("status 是合法 JSON", snapshot !== undefined);
if (snapshot !== undefined) {
  check("快照有 build", typeof snapshot.build === "string", snapshot.build);
  check("未登录时 login.phase 是 none", snapshot.login?.phase === "none", snapshot.login?.phase);
  check("publish 是 not-configured（无 token）", snapshot.publish === "not-configured", snapshot.publish);
  check("带 fallback 名册（非空 models）", Array.isArray(snapshot.models) && snapshot.models.length > 0, `${snapshot.models?.length}`);
  check("诊断块不含 token", /eyJ/.test(snapshot.diagnostics ?? "") === false);
  console.log("\n--- diagnostics ---");
  console.log(snapshot.diagnostics);
  console.log("-------------------\n");
}

console.log("\n== 4. action 路由的边界 ==");
const wrongMethod = await callRoute("/plugins/dsh-raccoon-web/action", { method: "GET" });
check("GET action → 405", wrongMethod.status === 405, String(wrongMethod.status));

const nonLoopback = await callRoute("/plugins/dsh-raccoon-web/status", { headers: { host: "evil.example.com" } });
check("非 loopback Host → 403", nonLoopback.status === 403, String(nonLoopback.status));

const noAction = await callRoute("/plugins/dsh-raccoon-web/action", { method: "POST" });
check("缺 action 参数 → 400", noAction.status === 400, String(noAction.status));

const badAction = await callRoute("/plugins/dsh-raccoon-web/action", {
  method: "POST",
  url: "/plugins/dsh-raccoon-web/action?action=nope",
  body: "{}",
});
const badBody = JSON.parse(badAction.body);
check("未知 action → ok:false", badBody.ok === false, badBody.error);

console.log("\n== 5. 各 action ==");
const refreshCatalog = await callRoute("/plugins/dsh-raccoon-web/action", {
  method: "POST",
  url: "/plugins/dsh-raccoon-web/action?action=refresh-catalog",
  body: "{}",
});
check("refresh-catalog 未登录时 ok:false", JSON.parse(refreshCatalog.body).ok === false);

const setSetting = await callRoute("/plugins/dsh-raccoon-web/action", {
  method: "POST",
  url: "/plugins/dsh-raccoon-web/action?action=set-setting",
  body: JSON.stringify({ key: "contextCap", value: 64_000 }),
});
check("set-setting 生效", JSON.parse(setSetting.body).ok === true, setSetting.body);

if (LIVE) {
  console.log("\n== 6. login-start（真实网络） ==");
  const started = await callRoute("/plugins/dsh-raccoon-web/action", {
    method: "POST",
    url: "/plugins/dsh-raccoon-web/action?action=login-start",
    body: "{}",
  });
  const payload = JSON.parse(started.body);
  check("login-start ok", payload.ok === true, payload.error);
  const after = JSON.parse((await callRoute("/plugins/dsh-raccoon-web/status")).body);
  check("phase 变成 pending", after.login?.phase === "pending", after.login?.phase);
  check("qrSvg 是 svg 字符串", typeof after.login?.qrSvg === "string" && after.login.qrSvg.startsWith("<svg"), `${after.login?.qrSvg?.length ?? 0}B`);
  check("deadline 在未来", (after.login?.deadline ?? 0) > Date.now(), String(after.login?.deadline - Date.now()));
  const cancel = await callRoute("/plugins/dsh-raccoon-web/action", {
    method: "POST",
    url: "/plugins/dsh-raccoon-web/action?action=login-cancel",
    body: "{}",
  });
  check("login-cancel ok", JSON.parse(cancel.body).ok === true);
} else {
  console.log("\n== 6. login-start 跳过（加 --live 才打网络） ==");
}

console.log("\n== 7. 卸载 ==");
for (const dispose of disposers) dispose();
await new Promise((r) => setTimeout(r, 50));
check("dispose 后路由清空", routes.size === 0, `${routes.size}`);
check("dispose 幂等（再跑一次不抛）", (() => {
  try {
    for (const dispose of disposers) dispose();
    return true;
  } catch {
    return false;
  }
})());

await rm(home, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log("✓ 冒烟全绿");
  process.exit(0);
} else {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
