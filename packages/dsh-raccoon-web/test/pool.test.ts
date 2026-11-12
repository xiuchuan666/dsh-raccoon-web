/**
 * 号池纯函数测试。
 *
 * 覆盖 `src/host/pool.ts` 里**不碰 IO** 的那一半：id 派生、设备身份格式、
 * 选号排序五条规则、响应分类、北京零点、摘要文案，以及 `upsertAccount`
 * 的"重新扫码不该变成新号"契约。
 *
 * 刻意不覆盖的：
 *   - `readPool()` / `writePool()` 之外的磁盘行为 —— 那两个在
 *     `host.test.ts` 的「store 落盘」里已经验过原子写与 `0600`，
 *     这里只补一条"号池能存能读、坏行只丢那一行"。
 *   - `RaccoonHost` 的六个 action —— 它们要起假 webServer + 假 settings，
 *     真宿主已经端到端跑过（见 devlog/2026-11-11.md），单测只做纯函数。
 *
 * @module test/pool
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  classifyMeasure,
  isCooling,
  mergePools,
  newDeviceId,
  nextRaccoonMidnight,
  poolAccountId,
  poolFile,
  poolSummary,
  readPool,
  shouldPersistMeasure,
  sortForUse,
  todayKey,
  upsertAccount,
  writePool,
  type PoolAccount,
  type PoolMeasure,
  type PoolQuota,
} from "../src/host/pool.js";

/** 造一个账号，只给需要覆盖的字段。 */
function account(over: Partial<PoolAccount> & { id: string }): PoolAccount {
  return {
    token: `token-${over.id}`,
    kind: "access_token",
    principal: `pu-${over.id}`,
    addedAt: 1_000,
    enabled: true,
    deviceId: `raccoon-${"0".repeat(32)}`,
    source: "qr",
    ...over,
  };
}

describe("poolAccountId", () => {
  it("PO-1 同一 principal 恒等，不同 principal 不同", () => {
    const a = poolAccountId("pu-01a19cd4-974e-7954-a640-f4cc795e3473");
    const b = poolAccountId("pu-01a19cd4-974e-7954-a640-f4cc795e3473");
    const c = poolAccountId("pu-someone-else");
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("PO-2 长度 16 且全是小写十六进制", () => {
    const id = poolAccountId("pu-x");
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
  });
});

describe("newDeviceId", () => {
  it("PO-3 形状是 raccoon- + 32 hex（E-038 要求稳定 install ID）", () => {
    const id = newDeviceId();
    assert.match(id, /^raccoon-[0-9a-f]{32}$/);
    assert.equal(id.length, "raccoon-".length + 32);
  });

  it("PO-4 两次生成不同（不是常量）", () => {
    assert.notEqual(newDeviceId(), newDeviceId());
  });
});

describe("sortForUse", () => {
  const now = 1_000_000;

  it("PO-5 第一层：未冷却的排前面", () => {
    const cooling = account({ id: "aaa", measure: { state: "limited", at: now, until: now + 60_000 } });
    const free = account({ id: "zzz" });
    const out = sortForUse([cooling, free], new Map(), now);
    assert.deepEqual(out.map((a) => a.id), ["zzz", "aaa"]);
  });

  it("PO-6 都在冷却 → until 升序（最早解锁先试）", () => {
    const late = account({ id: "aaa", measure: { state: "limited", at: now, until: now + 900_000 } });
    const soon = account({ id: "zzz", measure: { state: "limited", at: now, until: now + 60_000 } });
    const out = sortForUse([late, soon], new Map(), now);
    assert.deepEqual(out.map((a) => a.id), ["zzz", "aaa"]);
  });

  it("PO-7 第二层 daily 降序，且压过第三层 available（issue #70 教训）", () => {
    const richDaily = account({ id: "aaa" });
    const poorDaily = account({ id: "zzz" });
    const quota = new Map<string, PoolQuota>([
      // aaa 日更少但总余额高；zzz 日更多但总余额低
      ["aaa", { daily: 10, available: 50_000, at: now }],
      ["zzz", { daily: 200, available: 200, at: now }],
    ]);
    const out = sortForUse([richDaily, poorDaily], quota, now);
    assert.deepEqual(out.map((a) => a.id), ["zzz", "aaa"]);
  });

  it("PO-8 daily 相等才看 available 降序", () => {
    const high = account({ id: "aaa" });
    const low = account({ id: "zzz" });
    const quota = new Map<string, PoolQuota>([
      ["aaa", { daily: 100, available: 5_000, at: now }],
      ["zzz", { daily: 100, available: 500, at: now }],
    ]);
    const out = sortForUse([low, high], quota, now);
    assert.deepEqual(out.map((a) => a.id), ["aaa", "zzz"]);
  });

  it("PO-9 读数过期（超过 10 分钟）不参与排序，退回按 id 升序", () => {
    const a = account({ id: "aaa" });
    const z = account({ id: "zzz" });
    const stale = new Map<string, PoolQuota>([
      ["aaa", { daily: 0, available: 0, at: now - 11 * 60_000 }],
      ["zzz", { daily: 999, available: 999, at: now - 11 * 60_000 }],
    ]);
    const out = sortForUse([z, a], stale, now);
    assert.deepEqual(out.map((x) => x.id), ["aaa", "zzz"]);
  });

  it("PO-10 第四层 expiresAt 降序（少一次重新扫码）", () => {
    const early = account({ id: "aaa", expiresAt: now + 1_000 });
    const late = account({ id: "zzz", expiresAt: now + 900_000 });
    const out = sortForUse([early, late], new Map(), now);
    assert.deepEqual(out.map((a) => a.id), ["zzz", "aaa"]);
  });

  it("PO-11 不改入参数组", () => {
    const list = [account({ id: "zzz" }), account({ id: "aaa" })];
    sortForUse(list, new Map(), now);
    assert.deepEqual(list.map((a) => a.id), ["zzz", "aaa"]);
  });
});

describe("isCooling", () => {
  it("PO-12 没有 measure → 不冷却", () => {
    assert.equal(isCooling(account({ id: "a" }), 1_000), false);
  });

  it("PO-13 until 已过 → 不冷却", () => {
    assert.equal(isCooling(account({ id: "a", measure: { state: "flaky", at: 0, until: 500 } }), 1_000), false);
  });

  it("PO-14 dead 的 until 是 MAX_SAFE_INTEGER → 永远冷却", () => {
    const dead = account({ id: "a", measure: { state: "dead", at: 0, until: Number.MAX_SAFE_INTEGER } });
    assert.equal(isCooling(dead, Date.now()), true);
  });
});

describe("shouldPersistMeasure", () => {
  const ok = (at: number): PoolMeasure => ({ state: "ok", at });
  const limited = (at: number): PoolMeasure => ({ state: "limited", at, until: at + 60_000 });

  it("PO-36 从没测过 → ok 要写（首次确认可用要留痕）", () => {
    assert.equal(shouldPersistMeasure(undefined, ok(1_000)), true);
  });

  it("PO-37 ok → ok 不写（每轮对话都重写 accounts.json 等于每句话刷一次明文 token）", () => {
    assert.equal(shouldPersistMeasure(ok(1_000), ok(2_000)), false);
  });

  it("PO-38 冷却态 → ok 必须写（这是解除冷却的唯一记录）", () => {
    assert.equal(shouldPersistMeasure(limited(1_000), ok(2_000)), true);
    assert.equal(shouldPersistMeasure({ state: "dead", at: 0, until: Number.MAX_SAFE_INTEGER }, ok(2_000)), true);
    assert.equal(shouldPersistMeasure({ state: "empty", at: 0, until: 9_999 }, ok(2_000)), true);
    assert.equal(shouldPersistMeasure({ state: "flaky", at: 0, until: 9_999 }, ok(2_000)), true);
  });

  it("PO-39 任何 → 非 ok 都要写（冷却必须立刻落盘，否则重启后又被选中）", () => {
    assert.equal(shouldPersistMeasure(undefined, limited(1_000)), true);
    assert.equal(shouldPersistMeasure(ok(1_000), limited(2_000)), true);
    assert.equal(shouldPersistMeasure(limited(1_000), limited(2_000)), true);
    assert.equal(shouldPersistMeasure({ state: "dead", at: 0, until: Number.MAX_SAFE_INTEGER }, limited(2_000)), true);
  });

  it("PO-40 只比 state，不比 at（at 每次都变，拿它比较等于没比较）", () => {
    // 同一个 ok，at 差了一整天 —— 仍然是"没变化"，不写。
    assert.equal(shouldPersistMeasure(ok(0), ok(86_400_000)), false);
  });
});

describe("classifyMeasure", () => {
  const now = 1_700_000_000_000;

  it("PO-15 200 → ok 且无 until（成功要能清掉上一次冷却）", () => {
    const m = classifyMeasure({ status: 200, now });
    assert.equal(m?.state, "ok");
    assert.equal(m?.until, undefined);
  });

  it("PO-16 401 / 403 → dead，until = MAX_SAFE_INTEGER", () => {
    for (const status of [401, 403]) {
      const m = classifyMeasure({ status, now });
      assert.equal(m?.state, "dead");
      assert.equal(m?.until, Number.MAX_SAFE_INTEGER);
    }
  });

  it("PO-17 429 与 body 里的 200429 都算限流（200 状态码 + 200429 业务码）", () => {
    assert.equal(classifyMeasure({ status: 429, now })?.state, "limited");
    const m = classifyMeasure({ status: 200, bodyText: '{"code":200429,"message":"请求过于频繁"}' , now });
    // 200 分支先命中 → ok。业务码 200429 出现在 body 时上游实际给的是非 200，
    // 这里只断言"不会误判成 dead/empty"。
    assert.equal(m?.state, "ok");
    const m2 = classifyMeasure({ status: 400, bodyText: '{"code":200429}', now });
    assert.equal(m2?.state, "limited");
  });

  it("PO-18 402 → empty，until 是下一个北京零点", () => {
    const m = classifyMeasure({ status: 402, now });
    assert.equal(m?.state, "empty");
    assert.equal(m?.until, nextRaccoonMidnight(now));
  });

  it("PO-19 余额不足文案 → empty（上游不一定给 402）", () => {
    const m = classifyMeasure({ status: 400, bodyText: "积分不足，请充值", now });
    assert.equal(m?.state, "empty");
  });

  it("PO-20 5xx → flaky，30 分钟冷却", () => {
    const m = classifyMeasure({ status: 503, now });
    assert.equal(m?.state, "flaky");
    assert.equal(m?.until, now + 30 * 60_000);
  });

  it("PO-21 HTTP 400（无余额特征）→ undefined，不记", () => {
    assert.equal(classifyMeasure({ status: 400, bodyText: '{"message":"invalid model"}', now }), undefined);
  });

  it("PO-22 status 0（网络层失败）→ flaky", () => {
    assert.equal(classifyMeasure({ status: 0, now })?.state, "flaky");
  });

  it("PO-23 kind 优先于 status", () => {
    const m = classifyMeasure({ status: 200, kind: "AUTH", now });
    assert.equal(m?.state, "dead");
  });

  it("PO-24 kind=TIMEOUT → flaky 而不是 dead（网络抖动不该废号）", () => {
    assert.equal(classifyMeasure({ status: 0, kind: "TIMEOUT", now })?.state, "flaky");
  });

  it("PO-25 resetHint 从 body 里抠出来（只做展示，不参与 until）", () => {
    const m = classifyMeasure({ status: 429, bodyText: '{"reset_at":"2026-11-12T00:00:00+08:00"}', now });
    assert.equal(m?.state, "limited");
    assert.equal(m?.until, now + 30 * 60_000);
    assert.equal(m?.resetHint, "2026-11-12T00:00:00+08:00");
  });
});

describe("nextRaccoonMidnight", () => {
  it("PO-26 北京 2026-11-11 10:00 → 2026-11-12 00:00 (+08:00)", () => {
    const at = Date.parse("2026-11-11T10:00:00+08:00");
    const next = nextRaccoonMidnight(at);
    assert.equal(new Date(next).toISOString(), "2026-11-11T16:00:00.000Z");
  });

  it("PO-27 北京 23:59:59 → 仍是当天跨到次日的那一个零点", () => {
    const at = Date.parse("2026-11-11T23:59:59+08:00");
    const next = nextRaccoonMidnight(at);
    assert.equal(new Date(next).toISOString(), "2026-11-11T16:00:00.000Z");
    assert.ok(next > at);
  });

  it("PO-28 恰好零点 → 下一个零点（不是自己）", () => {
    const at = Date.parse("2026-11-12T00:00:00+08:00");
    const next = nextRaccoonMidnight(at);
    assert.equal(new Date(next).toISOString(), "2026-11-12T16:00:00.000Z");
  });
});

describe("todayKey", () => {
  it("PO-29 按北京日期而不是 UTC 日期", () => {
    // UTC 2026-11-11T20:00Z = 北京 2026-11-12 04:00
    assert.equal(todayKey(Date.parse("2026-11-11T20:00:00Z")), "2026-11-12");
  });
});

describe("upsertAccount", () => {
  it("PO-30 新号 enabled=false（加入 ≠ 入池）", () => {
    const next = upsertAccount([], {
      token: "t1",
      kind: "access_token",
      principal: "pu-a",
      source: "qr",
      now: 1_000,
    });
    assert.equal(next.length, 1);
    assert.equal(next[0]?.enabled, false);
    assert.equal(next[0]?.id, poolAccountId("pu-a"));
    assert.match(next[0]?.deviceId ?? "", /^raccoon-[0-9a-f]{32}$/);
    assert.equal(next[0]?.addedAt, 1_000);
  });

  it("PO-31 同 principal 二次加入：保留 deviceId / enabled / measure / addedAt，只换 token", () => {
    const first = upsertAccount([], {
      token: "old",
      kind: "access_token",
      principal: "pu-a",
      source: "qr",
      now: 1_000,
    });
    const picked = first.map((a) => ({ ...a, enabled: true, measure: { state: "limited" as const, at: 5, until: 9 } }));
    const again = upsertAccount(picked, {
      token: "new",
      kind: "access_token",
      principal: "pu-a",
      source: "qr",
      now: 2_000,
    });
    assert.equal(again.length, 1);
    assert.equal(again[0]?.token, "new");
    assert.equal(again[0]?.enabled, true);
    assert.equal(again[0]?.deviceId, first[0]?.deviceId);
    assert.equal(again[0]?.addedAt, 1_000);
    assert.equal(again[0]?.measure?.state, "limited");
  });

  it("PO-32 不同 principal 追加而不是覆盖", () => {
    let list = upsertAccount([], { token: "t", kind: "access_token", principal: "pu-a", source: "qr", now: 1 });
    list = upsertAccount(list, { token: "t", kind: "access_token", principal: "pu-b", source: "desktop", now: 2 });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((a) => a.source), ["qr", "desktop"]);
  });

  it("PO-32b source 跟着最后一次来源走（先扫码后导入桌面端凭据）", () => {
    // 早先是 `existing?.source ?? input.source`，于是先扫码加进来的号
    // 后来用桌面端凭据导入，source 永远停在 `qr`。它此刻持有的明明是
    // 桌面端 token，标成 `qr` 会让排障时分不清"要不要去客户端重登"。
    const first = upsertAccount([], { token: "old", kind: "access_token", principal: "pu-a", source: "qr", now: 1 });
    const again = upsertAccount(first, { token: "new", kind: "access_token", principal: "pu-a", source: "desktop", now: 2 });
    assert.equal(again[0]?.source, "desktop");
  });
});

describe("mergePools", () => {
  it("PO-41 两边并集，同 id 以内存为准", () => {
    const memory = [account({ id: "aaa", enabled: true, token: "mem-a" })];
    const disk = [account({ id: "aaa", enabled: false, token: "disk-a" }), account({ id: "bbb", token: "disk-b" })];
    const merged = mergePools(memory, disk);
    assert.equal(merged.length, 2, "磁盘独有那个不能丢");
    const a = merged.find((x) => x.id === "aaa");
    assert.equal(a?.token, "mem-a", "同 id 用内存那份（内存才是这个实例当前的决定）");
    assert.equal(a?.enabled, true);
    assert.equal(merged.find((x) => x.id === "bbb")?.token, "disk-b");
  });

  it("PO-42 空的一边不改变另一边（这是'导入第二个号，第一个号消失'的根因）", () => {
    // 内存比磁盘旧（比如插件刚启动还没读到、或上一次写入失败只更新了内存）时，
    // 直接 writePool(内存) 会把磁盘上那些账号整片抹掉。mergePools 保证
    // 磁盘独有的账号一定活下来。
    const disk = [account({ id: "aaa" }), account({ id: "bbb" })];
    assert.deepEqual(mergePools([], disk).map((x) => x.id), ["aaa", "bbb"]);
    assert.deepEqual(mergePools(disk, []).map((x) => x.id), ["aaa", "bbb"]);
    assert.deepEqual(mergePools([], []), []);
  });

  it("PO-43 顺序：磁盘在前、内存覆盖位置不变（整表写出去要可复现）", () => {
    const disk = [account({ id: "aaa" }), account({ id: "bbb" })];
    const memory = [account({ id: "bbb", token: "new-b" }), account({ id: "ccc" })];
    const merged = mergePools(memory, disk);
    assert.deepEqual(merged.map((x) => x.id), ["aaa", "bbb", "ccc"]);
    assert.equal(merged.find((x) => x.id === "bbb")?.token, "new-b");
  });
});

describe("poolSummary", () => {
  const a = account({ id: "0123456789abcdef" });

  it("PO-33 关 / 开（池空）/ 开（0 启用）/ 开（N 启用，当前 xxxxxxxx）", () => {
    assert.equal(poolSummary([], undefined, false), "关");
    assert.equal(poolSummary([a], undefined, true), "开（1 个启用，当前 未选中）");
    assert.equal(poolSummary([{ ...a, enabled: false }], undefined, true), "开（1 个账号，0 个启用）");
    assert.equal(poolSummary([a], "0123456789abcdef", true), "开（1 个启用，当前 01234567）");
  });
});

describe("号池落盘", () => {
  it("PO-34 writePool → readPool 往返；坏行只丢那一行；缺 enabled 一律 false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raccoon-pool-"));
    const previous = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = dir;
    try {
      await writePool([account({ id: "aaa", enabled: true }), account({ id: "zzz", enabled: false })]);
      const back = await readPool();
      assert.deepEqual(back.map((x) => x.id), ["aaa", "zzz"]);
      assert.deepEqual(back.map((x) => x.enabled), [true, false]);

      // 手写一份含坏行的文件：坏行丢、缺 enabled 的行按 false 读
      const file = poolFile();
      await mkdir(join(dir, "state", "dsh-raccoon-web"), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          accounts: [
            { id: "bbb", token: "t", kind: "access_token", principal: "pu-bbb", addedAt: 1, deviceId: "raccoon-" + "1".repeat(32), source: "qr" },
            { id: "ccc" },
            null,
            "nope",
          ],
        }),
        "utf8",
      );
      const second = await readPool();
      assert.equal(second.length, 1);
      assert.equal(second[0]?.id, "bbb");
      assert.equal(second[0]?.enabled, false);
    } finally {
      if (previous === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PO-35 schemaVersion 不认识 → 空池，不抛", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raccoon-pool2-"));
    const previous = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = dir;
    try {
      await mkdir(join(dir, "state", "dsh-raccoon-web"), { recursive: true });
      await writeFile(poolFile(), JSON.stringify({ schemaVersion: 2, accounts: [] }), "utf8");
      assert.deepEqual(await readPool(), []);
    } finally {
      if (previous === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
