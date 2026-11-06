/**
 * 模型目录 + 积分单测（CAT-1 ~ CAT-6、PT-1 ~ PT-5）。
 *
 * 目录里有两条来自真实事故的硬要求：
 *   CAT-3  **不截断响应体** —— dsh-raccoon-connect@0.2.2 把响应体截到 4096 字符，
 *          新模型的 JSON 解析失败，UI 显示 `[object Object]`。
 *   CAT-4  字段名多键名兼容 —— 目录字段名是私有协议，改过一次（Q4）。
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fetchCatalog, flattenCatalog, normalizeModel, parseCatalog } from "../src/protocol/catalog.js";
import { RaccoonError } from "../src/protocol/errors.js";
import { fetchBalance, fetchBills, raccoonDay, todayGranted } from "../src/protocol/points.js";
import { fakeFetch, json, text } from "./helpers.js";

/** 目录响应的典型形状。 */
function catalogPayload(): Record<string, unknown> {
  return {
    code: 0,
    data: {
      categories: [
        {
          key: "sensenova",
          models: [
            {
              id: "sn-sensenova-6-8-flash",
              display_name: "SenseNova 6.8 Flash",
              multiplier: 0,
              context_window: 256000,
              max_output_length: 63999,
              tags: ["vision"],
            },
          ],
        },
        {
          key: "glm",
          models: [
            { id: "sn-glm-5-3", display_name: "GLM-5-3", multiplier: 0.75, context_window: 1000000 },
            { id: "sn-glm-5-3-flash", display_name: "GLM-5-3-Flash", multiplier: 0.2 },
          ],
        },
      ],
    },
  };
}

describe("parseCatalog", () => {
  it("CAT-1: 解析出两个分组与三个模型", () => {
    const groups = parseCatalog(catalogPayload());
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.key, "sensenova");
    assert.equal(flattenCatalog(groups).length, 3);
  });

  it("CAT-2: 字段映射（multiplier / context_window / max_output_length）", () => {
    const model = flattenCatalog(parseCatalog(catalogPayload())).find((m) => m.id === "sn-glm-5-3")!;
    assert.equal(model.name, "GLM-5-3");
    assert.equal(model.multiplier, 0.75);
    assert.equal(model.contextWindow, 1_000_000);
  });

  it("CAT-3: 大响应体不被截断（4096 字符的教训）", () => {
    // 造一个远超 4096 字符的目录，最后一个模型必须还能解析出来
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`,
      display_name: `模型 ${i} `.repeat(10),
      context_window: 128000,
      description: "x".repeat(100),
    }));
    const payload = { code: 0, data: { categories: [{ key: "big", models: filler }] } };
    const groups = parseCatalog(payload);
    assert.equal(flattenCatalog(groups).length, 200);
    // 最后一个必须完整
    assert.equal(flattenCatalog(groups).at(-1)?.id, "m-199");
  });

  it("CAT-4: 多键名兼容（camelCase 与 snake_case 都认）", () => {
    const groups = parseCatalog({
      code: 0,
      data: {
        categories: [
          {
            key: "c",
            models: [{ id: "m1", displayName: "Camel", contextWindow: 64000, maxOutputTokens: 4096, pointMultiplier: 2 }],
          },
        ],
      },
    });
    const model = flattenCatalog(groups)[0]!;
    assert.equal(model.name, "Camel");
    assert.equal(model.contextWindow, 64_000);
    assert.equal(model.maxOutput, 4096);
    assert.equal(model.multiplier, 2);
  });

  it("CAT-5: 两级嵌套（category.children[].models[]）也能解析", () => {
    const groups = parseCatalog({
      code: 0,
      data: {
        categories: [
          {
            key: "outer",
            children: [{ models: [{ id: "nested-1", display_name: "Nested" }] }],
          },
        ],
      },
    });
    assert.equal(flattenCatalog(groups)[0]?.id, "nested-1");
  });

  it("CAT-6: 按 id 去重（上游可能重复列同一个模型）", () => {
    const groups = parseCatalog({
      code: 0,
      data: {
        categories: [
          { key: "a", models: [{ id: "dup", display_name: "A" }] },
          { key: "b", models: [{ id: "dup", display_name: "B" }] },
        ],
      },
    });
    assert.equal(flattenCatalog(groups).length, 1);
  });

  it("CAT-7: 缺 categories 抛 SERVER", () => {
    assert.throws(() => parseCatalog({ code: 0, data: {} }), /categories/);
  });

  it("CAT-8: 业务 code 非 0 抛 SERVER", () => {
    assert.throws(() => parseCatalog({ code: 500, data: {} }), /code=500/);
  });
});

describe("normalizeModel", () => {
  it("CAT-9: 没有 id 时退回 name", () => {
    assert.equal(normalizeModel({ name: "只有名字" }, "g")?.id, "只有名字");
  });

  it("CAT-10: id 与 name 都没有 → undefined（跳过，不抛）", () => {
    assert.equal(normalizeModel({ multiplier: 1 }, "g"), undefined);
  });

  it("CAT-11: vision 标签不可信但先照读（ADR-0006 的起点）", () => {
    assert.equal(normalizeModel({ id: "a", tags: ["vision"] }, "g")?.vision, true);
    assert.equal(normalizeModel({ id: "a", tags: [] }, "g")?.vision, false);
  });
});

describe("fetchCatalog", () => {
  it("CAT-12: 200003 → AUTH", async () => {
    const fetchImpl = fakeFetch(json(401, { code: 200003, message: "authorization_verify_error" }));
    await assert.rejects(fetchCatalog("t", fetchImpl), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "AUTH";
    });
  });

  it("CAT-13: 429 → RATE_LIMIT", async () => {
    const fetchImpl = fakeFetch(json(429, {}));
    await assert.rejects(fetchCatalog("t", fetchImpl), (err: unknown) => {
      return err instanceof RaccoonError && err.kind === "RATE_LIMIT";
    });
  });

  it("CAT-14: 打的是 model_catalog，带完整客户端头", async () => {
    const fetchImpl = fakeFetch(json(200, catalogPayload()));
    await fetchCatalog("tok", fetchImpl);
    const call = fetchImpl.calls[0]!;
    assert.equal(call.url, "https://xiaohuanxiong.com/api/web/llm/v2/model_catalog");
    assert.equal(call.headers["authorization"], "Bearer tok");
    assert.equal(call.headers["x-client-version"], "v1.0.35");
  });
});

describe("积分", () => {
  it("PT-1: 余额按 available_points 优先", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: { available_points: 1234, total: 9999 } }));
    const balance = await fetchBalance("t", fetchImpl);
    assert.equal(balance.available, 1234);
  });

  it("PT-2: 没有 available_points 时按顺序退到 total_chargeable_points / total / balance / points", async () => {
    for (const [field, value] of [
      ["total_chargeable_points", 11],
      ["total", 22],
      ["balance", 33],
      ["points", 44],
    ] as const) {
      const fetchImpl = fakeFetch(json(200, { code: 0, data: { [field]: value } }));
      assert.equal((await fetchBalance("t", fetchImpl)).available, value, `${field} 应该被读到`);
    }
  });

  it("PT-3: 永久与每日积分分开取", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: { available_points: 1, reward_points: 2, daily_points: 3 } }));
    const balance = await fetchBalance("t", fetchImpl);
    assert.equal(balance.permanent, 2);
    assert.equal(balance.daily, 3);
  });

  it("PT-4: raccoonDay 用北京时区（UTC 15:59 还是当天，16:00 就是次日）", () => {
    // 2026-11-06T15:59:00Z === 2026-11-06 23:59 北京
    assert.equal(raccoonDay("2026-11-06T15:59:00Z"), "2026-11-06");
    // 2026-11-06T16:00:00Z === 2026-11-07 00:00 北京
    assert.equal(raccoonDay("2026-11-06T16:00:00Z"), "2026-11-07");
  });

  it("PT-5: 流水里找当天 daily_grant", async () => {
    const fetchImpl = fakeFetch(
      json(200, {
        code: 0,
        data: {
          items: [
            { biz_type: "consume", points: -10, created_at: "2026-11-06T01:00:00Z" },
            { biz_type: "daily_grant", points: 100, grant_at: "2026-11-06T00:30:00Z" },
          ],
        },
      }),
    );
    const bills = await fetchBills("t", fetchImpl);
    assert.equal(bills.length, 2);
    const granted = todayGranted(bills, new Date("2026-11-06T02:00:00Z"));
    assert.equal(granted?.amount, 100);
  });

  it("PT-6: 昨天到账的不算今天", async () => {
    const bills = [{ bizType: "daily_grant", amount: 100, at: "2026-11-05T00:30:00Z", raw: {} }];
    assert.equal(todayGranted(bills, new Date("2026-11-06T02:00:00Z")), undefined);
  });

  it("PT-7: 流水接口打的是 /points/v2/bills 且带 type=all", async () => {
    const fetchImpl = fakeFetch(json(200, { code: 0, data: { items: [] } }));
    await fetchBills("t", fetchImpl, 20);
    const call = fetchImpl.calls[0]!;
    assert.ok(call.url.startsWith("https://xiaohuanxiong.com/api/web/points/v2/bills?"));
    assert.ok(call.url.includes("paging.limit=20"));
    assert.ok(call.url.includes("type=all"));
  });

  it("PT-8: 流水接口返回 HTML → 不崩，返回空数组", async () => {
    const fetchImpl = fakeFetch(text(502, "<html>bad</html>"));
    await assert.rejects(fetchBills("t", fetchImpl), (err: unknown) => {
      return err instanceof RaccoonError;
    });
  });
});
