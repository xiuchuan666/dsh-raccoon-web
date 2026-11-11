#!/usr/bin/env node
/**
 * 在 Node 里把 `packages/dsh-raccoon-web/client.js` 的 `apply(ctx)` 真跑一遍。
 *
 * ## 为什么需要这个脚本
 *
 * 浏览器半身出问题时的观测成本极高：宿主页面要 launch token（只经命令行 URL
 * 传出，磁盘找不回来），agent 浏览器连不上，`~/.dsh/logs` 里也没有当前实例
 * 的日志。于是"设置页空白"这类故障只能靠用户肉眼看 Console —— 一次往返几
 * 十分钟，还常常只拿到一句"还是空白"。
 *
 * 但 `apply` 本身是纯 JS：它只碰 `ctx.slots` / `ctx.locale` / `ctx.effect`。
 * 这三个都能在 Node 里按 DSH 0.2.2 的**真实语义**做替身（包括那些会抛错的
 * 路径），所以整段装配逻辑可以离线跑，而且能把抛错点精确到行。
 *
 * ## 替身必须照抄的 0.2.2 语义
 *
 * 抄错任何一条，这个脚本就会在"假问题"上报警，比不跑更坏：
 *
 * 1. `locale.register(ns, dicts)` 在**同一 ns 的同一 locale 已存在**时抛
 *    `locale namespace "x" already has locale "y"` —— 这是 0.2.2 新增的
 *    行为，也是"插件被加载两次 → apply 第二次抛错 → 后面的 slot 全丢"
 *    这条故障链的起点。
 * 2. `slots.inject(slot, callback)` **不抛错**：slot 已声明就同步跑 callback，
 *    未声明就挂着等。返回 disposer，不返回 Context。
 * 3. `slots.register(options, component)` 校验 `options.name` 是非空字符串，
 *    否则抛错（`guardedSlots` 的 `rejectGuard`）。
 * 4. `ctx.effect(factory, label)` 立即执行 factory，把返回值当 disposer。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/smoke-client-apply.mjs            # 单次装配
 * node scripts/smoke-client-apply.mjs --twice    # 装配两次（模拟重复加载）
 * ```
 *
 * 退出码 0 表示"两次装配都成功"或"第二次失败但被兜住了"—— 具体判定写在
 * 最后一段断言里。
 *
 * @module scripts/smoke-client-apply
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
/** `RACCOON_CLIENT=<path>` 可以指向任意一份 client.js —— 用来回归验证历史版本。 */
const CLIENT = process.env.RACCOON_CLIENT ?? join(here, "..", "packages", "dsh-raccoon-web", "client.js");
const source = readFileSync(CLIENT, "utf8");

const TWICE = process.argv.includes("--twice");

/** 收集 console 输出，跑完统一打印 —— 免得被 vm 的 stdout 顺序打乱。 */
const logs = [];
function record(level) {
    return (...args) => {
        logs.push([level, args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ")]);
    };
}

/**
 * 造一个按 0.2.2 语义工作的 ctx。
 *
 * `registered` 收集真正注册成功的条目，供断言用；`declared` 是"宿主声明了哪些
 * slot"——只放我们真用到的三个，模拟插件在宿主里实际能看到的世界。
 */
function makeContext(declared, registered, localeDicts) {
    const disposers = [];
    const ctx = {
        slots: {
            inject(slot, callback) {
                if (declared.has(slot)) callback();
                disposers.push(() => {});
                return () => {};
            },
            register(options, component) {
                if (typeof options !== "object" || options === null) {
                    throw new Error("slots.register(options, component) needs an options object with a `name`");
                }
                if (typeof options.name !== "string" || options.name.length === 0) {
                    throw new Error("slots.register options need a string `name`");
                }
                registered.push({
                    slot: options.name,
                    id: options.id,
                    key: options.key,
                    order: options.order,
                    hasComponent: typeof component === "function" || (typeof component === "object" && component !== null),
                });
                return () => {};
            },
        },
        locale: {
            register(ns, dicts) {
                const owner = localeDicts.get(ns) ?? new Map();
                for (const locale of Object.keys(dicts)) {
                    if (owner.has(locale)) {
                        throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
                    }
                }
                for (const [locale, entries] of Object.entries(dicts)) owner.set(locale, entries);
                localeDicts.set(ns, owner);
                return () => {};
            },
            bind(ns) {
                return (key) => key;
            },
        },
        effect(factory, label) {
            const dispose = factory();
            if (typeof dispose === "function") disposers.push(dispose);
        },
        get() {
            return undefined;
        },
    };
    return ctx;
}

/** 跑一次完整装配，返回这次装配里"抛出来没被兜住"的错误。 */
function runOnce({ declared, localeDicts, plugins }) {
    const registered = [];
    const sandbox = {
        console: {
            log: record("log"),
            warn: record("warn"),
            error: record("error"),
            info: record("info"),
            debug: record("debug"),
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        fetch: async () => {
            throw new Error("offline");
        },
        document: undefined,
        React: undefined,
        globalThis: undefined,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;

    // 只替换 `require('react')` —— 组件本身不渲染，只要 createElement 存在。
    sandbox.__ModuleLoader__ = {
        load(registration) {
            const module = { exports: {} };
            const require = (spec) => {
                if (spec === "react") {
                    return {
                        createElement: (...args) => ({ type: "element", args }),
                        useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
                        useEffect: () => {},
                        useMemo: (fn) => fn(),
                        useCallback: (fn) => fn,
                        useRef: (value) => ({ current: value }),
                    };
                }
                throw new Error(`require("${spec}") missed the module table`);
            };
            const plugin = registration.factory(require);
            plugins.push(plugin);
            return plugin;
        },
    };

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: "client.js" });

    const plugin = plugins[plugins.length - 1];
    const ctx = makeContext(declared, registered, localeDicts);
    let thrown;
    try {
        plugin.apply(ctx);
    } catch (error) {
        thrown = error;
    }
    return { registered, thrown };
}

const DECLARED = new Set(["conversation.input.left", "plugins.bundle.config", "settings.section"]);

const failures = [];
function check(condition, message) {
    if (!condition) failures.push(message);
}

// ── 第一次装配 ────────────────────────────────────────────────────────
const localeDicts = new Map();
const plugins = [];
const first = runOnce({ declared: DECLARED, localeDicts, plugins });

check(first.thrown === undefined, `第一次 apply 抛错：${first.thrown && first.thrown.message}`);
check(first.registered.length === 3, `第一次 apply 应注册 3 个 slot，实际 ${first.registered.length}`);
for (const slot of DECLARED) {
    check(
        first.registered.some((entry) => entry.slot === slot),
        `第一次 apply 没有注册 ${slot}`,
    );
}

// ── 第二次装配（模拟 profile 里同一个包被加载两次）──────────────────────
if (TWICE) {
    const second = runOnce({ declared: DECLARED, localeDicts, plugins });
    check(
        second.thrown === undefined,
        `第二次 apply 抛错且没被兜住：${second.thrown && second.thrown.message}`,
    );
    check(
        second.registered.length === 3,
        `第二次 apply 应仍注册 3 个 slot（locale 重复不算致命），实际 ${second.registered.length}`,
    );
}

// ── 报告 ──────────────────────────────────────────────────────────────
const slots = first.registered.map((entry) => entry.slot + (entry.id ? `#${entry.id}` : "") + (entry.key ? `[${entry.key}]` : ""));
console.log(`装配结果：${first.registered.length} 个 slot -> ${slots.join(", ")}`);
if (TWICE) {
    const secondCount = plugins.length;
    console.log(`重复装配：跑了 ${secondCount} 次 apply（模拟重复加载）`);
}
const interesting = logs.filter(([level]) => level === "warn" || level === "error");
for (const [level, text] of interesting) console.log(`  [${level}] ${text}`);

if (failures.length > 0) {
    console.error("\n✗ smoke-client-apply 失败：");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log("\n✓ smoke-client-apply 通过");
