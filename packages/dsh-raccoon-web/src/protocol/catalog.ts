/**
 * 模型目录。
 *
 * `GET /api/web/llm/v2/model_catalog` 是**唯一权威**的能力来源：
 * 它既告诉我们有哪些模型，也是"这个 token 还能不能用"的探测点。
 *
 * 两条硬规矩：
 *   ① **不截断响应体**。`dsh-raccoon-connect@0.2.2` 把响应体截到 4096 字符，
 *      导致新模型的 JSON 解析失败，UI 里显示 `[object Object]`。
 *   ② 字段名多键名兼容。目录字段名是私有协议，改过（见 Q4）。
 *
 * @module protocol/catalog
 */

import { CATALOG_TIMEOUT_MS, LLM_BASE } from "./consts.js";
import { RaccoonError, isDeadSessionCode, isRateLimited } from "./errors.js";
import { webHeaders } from "./headers.js";

/** 归一化后的一个模型。 */
export interface RaccoonModel {
  /** 上游 id，直接作为 pi-ai 的 model.id。 */
  id: string;
  /** 显示名（不含倍率后缀）。 */
  name: string;
  /** 目录声称的识图能力。**不可信**，见 ADR-0006。 */
  vision: boolean;
  /** 积分倍率。拼在显示名后面。 */
  multiplier?: number;
  contextWindow?: number;
  maxOutput?: number;
  /** 目录的 `visible` 标记。`false` = 官方客户端不显示的内部别名。 */
  visible?: boolean;
  /** 原始条目，调试用。 */
  raw: Record<string, unknown>;
}

/** 模型目录分类（上游按 `type` 分组，实测只有 `chat`）。 */
export interface CatalogGroup {
  /** 分组名。实测取 `type`，如 `chat`。 */
  key: string;
  models: RaccoonModel[];
}

/**
 * 一个模型的 `visible` 标记。
 *
 * 2026-11-06 实测：目录里有 3 个 `visible:false` 的 `raccoon-*` 模型
 * （`raccoon-090dd3` / `raccoon-19b265` / `raccoon-405a1c`），它们**能调通**
 * （`chat/completions` 实测 HTTP 200），但官方客户端的模型选择器不显示。
 * 它们是桌面端内部的别名（`raccoon-090dd3` 的 `description` 就叫
 * `Raccoon-Work`），列出来只会让用户在同一个底层模型上看到两条重复项。
 *
 * 所以默认按官方客户端的做法过滤掉；需要时可由调用方打开。
 */
export interface CatalogOptions {
  /** 是否保留下 `visible:false` 的模型。默认 false。 */
  includeHidden?: boolean;
}

type FetchImpl = typeof fetch;

/** 数字型字段的多键名读取。 */
function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n > 0) return n;
    }
  }
  return undefined;
}

/** 字符串型字段的多键名读取。 */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** 布尔型字段的多键名读取。 */
function pickBoolean(obj: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/** 判断某个条目是否"声称支持识图"（按标签 / modalities / capability 列表）。 */
function detectVisionTag(obj: Record<string, unknown>): boolean {
  const explicit = pickBoolean(obj, ["vision", "supports_vision", "supportsVision", "image_input"]);
  if (explicit !== undefined) return explicit;

  const tags = obj["tags"] ?? obj["modalities"] ?? obj["input_modalities"] ?? obj["capabilities"];
  if (Array.isArray(tags)) {
    return tags.some((t) => {
      if (typeof t === "string") {
        const s = t.toLowerCase();
        return s === "vision" || s === "image" || s === "image_input" || s === "multimodal";
      }
      return false;
    });
  }
  return false;
}

/** 取出可能嵌套在 `params` / `config` / `limits` 里的数字。 */
function pickNumberDeep(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const direct = pickNumber(obj, keys);
  if (direct !== undefined) return direct;
  for (const container of ["params", "config", "limits", "meta", "spec"]) {
    const nested = obj[container];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      const found = pickNumber(nested as Record<string, unknown>, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 把一条原始模型条目归一成 `RaccoonModel`。 */
export function normalizeModel(raw: Record<string, unknown>, groupKey: string): RaccoonModel | undefined {
  const id =
    pickString(raw, ["id", "model_id", "modelId", "model", "code", "name_code"]) ??
    pickString(raw, ["name"]);
  if (id === undefined) return undefined;

  // 显示名候选的顺序是**实测出来的**（2026-11-06 用真实目录逐字段核对）：
  //   `description` = "Kimi-K3"        ← 给人看的
  //   `name`       = "sn-kimi-k3"      ← 稳定 id
  //   `model_name` = "sn-kimi-k3"      ← 又一个 id 副本
  // 所以 `description` 必须排最前。之前的版本把裸 `name` 排前面，结果模型
  // 选择器里显示的是 `sn-kimi-k3` 这种内部代号 —— 冒烟测试第一次暴露，
  // 真实目录第二次确认。
  const name =
    pickString(raw, [
      "description",
      "display_description",
      "display_name",
      "displayName",
      "title",
      "label",
      "name",
      "model_name",
      "modelName",
    ]) ?? id;

  // 倍率实测字段是 `billing_multiplier` / `billing_effective_multiplier`
  // （`points_multiplier` 只在 toB 目录里出现）。`billing_effective_multiplier`
  // 优先：它是打完活动折扣之后真正扣的那个数。
  const multiplier = pickNumber(raw, [
    "billing_effective_multiplier",
    "billing_multiplier",
    "points_multiplier",
    "multiplier",
    "point_multiplier",
    "pointMultiplier",
    "ratio",
    "price_ratio",
  ]);

  // 上下文与输出上限**嵌在 `params` 里**（`params.context_window` /
  // `params.max_tokens`）。只查顶层会全部落空，于是每个模型都退回
  // DEFAULT_CONTEXT_CAP —— 表面看没坏，实际把 1M 的模型当成 128k 用。
  const contextWindow = pickNumberDeep(raw, [
    "context_window",
    "contextWindow",
    "max_context_length",
    "maxContextLength",
    "max_input_tokens",
    "context_length",
  ]);
  const maxOutput = pickNumberDeep(raw, [
    "max_output_length",
    "maxOutputLength",
    "max_output_tokens",
    "maxOutputTokens",
    "max_tokens",
    "maxTokens",
  ]);

  const visible = pickBoolean(raw, ["visible", "is_visible", "isVisible"]);

  const model: RaccoonModel = {
    id,
    name,
    vision: detectVisionTag(raw),
    raw: { ...raw, __group: groupKey },
  };
  if (multiplier !== undefined) model.multiplier = multiplier;
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxOutput !== undefined) model.maxOutput = maxOutput;
  if (visible !== undefined) model.visible = visible;
  return model;
}

/**
 * 解析目录响应。
 *
 * 结构是 `{code:0, data:{categories:[{key/name, models/items/children:[...]}]}}`。
 * 我们接受两种嵌套深度（categories → models，或 categories → groups → models），
 * 因为上游改过一次嵌套方式，而解析器改为"宽松"的成本极低。
 */
export function parseCatalog(payload: unknown, options: CatalogOptions = {}): CatalogGroup[] {
  const root = payload as { code?: unknown; data?: unknown } | undefined;
  if (root === undefined || root === null) {
    throw new RaccoonError("SERVER", "小浣熊模型目录返回了空值");
  }
  if (typeof root.code === "number" && root.code !== 0) {
    throw new RaccoonError("SERVER", `小浣熊模型目录返回 code=${root.code}`, {
      upstream: JSON.stringify(payload).slice(0, 2000),
    });
  }

  const data = root.data as Record<string, unknown> | undefined;
  const categories = data?.["categories"];
  if (!Array.isArray(categories)) {
    throw new RaccoonError("SERVER", "小浣熊模型目录里没有 categories 数组", {
      upstream: JSON.stringify(payload).slice(0, 2000),
    });
  }

  const groups: CatalogGroup[] = [];
  const seen = new Set<string>();
  const includeHidden = options.includeHidden === true;

  const pushModels = (key: string, list: unknown): void => {
    if (!Array.isArray(list)) return;
    const models: RaccoonModel[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      // 二级嵌套：category.models[i].models
      const nested = rec["models"] ?? rec["children"] ?? rec["items"];
      if (Array.isArray(nested) && pickString(rec, ["id", "model_id", "modelId"]) === undefined) {
        for (const sub of nested) {
          if (typeof sub !== "object" || sub === null) continue;
          const m = normalizeModel(sub as Record<string, unknown>, key);
          if (m !== undefined && !seen.has(m.id) && (includeHidden || m.visible !== false)) {
            seen.add(m.id);
            models.push(m);
          }
        }
        continue;
      }
      const m = normalizeModel(rec, key);
      if (m !== undefined && !seen.has(m.id) && (includeHidden || m.visible !== false)) {
        seen.add(m.id);
        models.push(m);
      }
    }
    if (models.length > 0) groups.push({ key, models });
  };

  for (const cat of categories) {
    if (typeof cat !== "object" || cat === null) continue;
    const rec = cat as Record<string, unknown>;
    // 分组名实测来自 `type`（`{type:"chat", default_model:"raccoon-090dd3"}`，
    // 没有 key/name）。保留旧候选是为了上游改回旧形状时不至于全叫 "default"。
    const key = pickString(rec, ["type", "key", "name", "title", "category", "series"]) ?? "default";
    pushModels(key, rec["models"] ?? rec["items"] ?? rec["children"]);
  }

  return groups;
}

/** 拉并解析目录。401/403/200003 → AUTH；429 → RATE_LIMIT。 */
export async function fetchCatalog(
  token: string,
  fetchImpl: FetchImpl = fetch,
  options: CatalogOptions = {},
): Promise<CatalogGroup[]> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${LLM_BASE}/model_catalog`, {
      method: "GET",
      headers: webHeaders(token),
      redirect: "error",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new RaccoonError("TIMEOUT", "拉取小浣熊模型目录超时", { cause: err });
    }
    throw new RaccoonError("TRANSPORT", `连不上小浣熊：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RaccoonError("SERVER", `小浣熊模型目录返回了无法解析的内容（HTTP ${res.status}）`, {
      status: res.status,
      upstream: text,
    });
  }

  const code = (payload as { code?: unknown } | undefined)?.code;
  if (res.status === 401 || res.status === 403 || isDeadSessionCode(code)) {
    throw new RaccoonError("AUTH", "小浣熊登录已失效", { status: res.status, upstream: text });
  }
  if (isRateLimited(res.status, text)) {
    throw new RaccoonError("RATE_LIMIT", "小浣熊限流", { status: res.status, upstream: text });
  }
  if (!res.ok) {
    throw new RaccoonError("SERVER", `小浣熊模型目录返回 HTTP ${res.status}`, { status: res.status, upstream: text });
  }

  return parseCatalog(payload, options);
}

/** 拍平所有分组的模型。 */
export function flattenCatalog(groups: readonly CatalogGroup[]): RaccoonModel[] {
  return groups.flatMap((g) => g.models);
}
