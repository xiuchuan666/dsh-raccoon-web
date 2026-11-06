/**
 * 带 TTL 与 inflight 去重的读缓存。
 *
 * ## 为什么需要它
 *
 * 目录（5 分钟）与积分（60 秒）都是"网页会反复问、上游没必要反复答"的东西。
 * 但只有 TTL 还不够 —— 设置卡与药丸可能在同一秒里各问一次，两次请求会同时
 * 打穿缓存。所以还要把**在途的 Promise 记下来**，第二个调用方拿同一个 Promise。
 *
 * ## 一个必须记住的坑
 *
 * 失败**不进缓存**。`load()` 抛错时清掉 `inflight` 并直接向上抛，
 * 下一次调用会重新试。否则一次网络抖动会把"目录拉取失败"缓存 5 分钟 ——
 * 用户看到的就是"扫码成功但模型一直不出现"。
 *
 * @module host/cache
 */

/** 一个只读的带缓存读取器。 */
export interface TtlCache<T> {
  /** 读一次。命中缓存直接返回；未命中走 `load()`。`fresh` 为 true 时强制重取。 */
  get(fresh?: boolean): Promise<T>;
  /** 缓存里当前的值（可能已过期），没有就 undefined。不发请求。 */
  peek(): T | undefined;
  /** 主动作废。登录 / 退出 / 换名册时调。 */
  clear(): void;
}

/**
 * 造一个缓存。
 *
 * @param ttlMs 存活时间。`<= 0` 表示永不命中（每次都重取，但仍去重 inflight）。
 * @param load 真正的读取函数。
 * @param now 时钟，测试用。
 */
export function createTtlCache<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): TtlCache<T> {
  let value: { at: number; data: T } | undefined;
  let inflight: Promise<T> | undefined;

  const fresh = (): T | undefined => {
    if (value === undefined) return undefined;
    if (ttlMs <= 0) return undefined;
    if (now() - value.at >= ttlMs) return undefined;
    return value.data;
  };

  return {
    peek: () => value?.data,
    clear() {
      value = undefined;
      inflight = undefined;
    },
    async get(force = false): Promise<T> {
      if (!force) {
        const hit = fresh();
        if (hit !== undefined) return hit;
      }
      if (inflight !== undefined) return inflight;

      const pending = (async () => {
        try {
          const data = await load();
          value = { at: now(), data };
          return data;
        } finally {
          // 无论成败都清掉 —— 成功时值已经在 value 里，失败时必须允许重试。
          inflight = undefined;
        }
      })();

      inflight = pending;
      return pending;
    },
  };
}
