# 代码约定

最后更新: 2026-11-06
状态: 已定稿

> 这些不是审美偏好。每一条都对应一个具体的、已经踩过的坑。

---

## 1. 命名

| 对象 | 规则 | 例子 |
| --- | --- | --- |
| 文件 | kebab-case | `login-flow.ts` |
| 类型 / 类 | PascalCase | `RaccoonError`、`LoginFlow` |
| 函数 / 变量 | camelCase | `raccoonSessionId`、`fetchCatalog` |
| 常量 | SCREAMING_SNAKE | `FIRST_BYTE_TIMEOUT_MS` |
| 布尔 | `is`/`has`/`can` 前缀 | `isExpired`、`hasToken` |
| 私有字段 | `#` | `#inflight` |
| provider id | kebab-case，全局唯一 | `raccoon-web` |

**协议层的函数名保留上游原名**：`createQr` / `pollQr` / `confirmSession`，不翻译成 `startLogin` / `waitLogin` / `finalizeLogin`。原因：出问题时能直接对着网关文档/抓包找。

---

## 2. 导入

```ts
// 1. Node 内置
import { createHash } from "node:crypto";
import path from "node:path";

// 2. 外部（只有这两个）
import { createProvider } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

// 3. 本项目
import { FIRST_BYTE_TIMEOUT_MS } from "./consts.js";
```

**规则**：

- Node 内置必须带 `node:` 前缀。
- 相对导入**必须带 `.js` 扩展名**（ESM 要求）。TS 源码写 `.js`，编译后才是对的。
- `protocol/` 里**不许**出现第 2 类。

---

## 3. 函数形状

### 3.1 依赖注入而非模块级单例

```ts
// ✅
export async function fetchCatalog(token: string, fetchImpl: typeof fetch = fetch): Promise<RaccoonModel[]>

// ❌
let globalToken: string;
export async function fetchCatalog(): Promise<RaccoonModel[]>
```

**理由**：`fetch` 注入让单测不用起服务器。

### 3.2 返回值：抛错误，不返回 `{ok:false}`

```ts
// ✅
const models = await fetchCatalog(token);
// ❌
const { ok, data, error } = await fetchCatalog(token);
```

`RaccoonError` 带 `kind`，调用方 `catch` 后按 `kind` 分支。typing 上更直白（返回值类型就是 `RaccoonModel[]`）。

**唯一例外**：`readToken()` 返回 `undefined` 而不是抛 —— 它是"可选配置读取"，缺失是正常状态。

### 3.3 异步函数的超时一律用 `AbortSignal`

```ts
await fetchCatalog(token, { signal: AbortSignal.timeout(15_000) });
```

不自己 `setTimeout` + `Promise.race`。原因：`Promise.race` 之后那个 fetch 还在跑，连接不释放。

---

## 4. 注释

### 4.1 必须注释的

| 场景 | 要求 |
| --- | --- |
| 任何与"直觉"相反的决定 | 写**为什么**，不写**是什么** |
| 任何来自网关实测的魔法值 | 带实测日期 |
| 任何"看起来可以优化但不许优化"的地方 | 写清楚后果 |
| 任何绕过类型系统的 `as` | 写清楚为什么安全 |

### 4.2 格式

```ts
// 2026-11-06 实测：每次轮询返回的 expires_in 在递减（300 → 269），
// 说明服务端在计时。所以不能自己算 deadline，必须每次用返回值重置。
// 见 docs/01-research/05-empirical-findings.md E-002
let deadline = Date.now() + session.expiresIn * 1000;
```

**带日期、带文档引用。** 半年后回来看，才知道这个数是测出来的还是编的。

### 4.3 禁止的注释

```ts
// ❌ 增加 1
count++;
// ❌ TODO: 以后改成 xxx
// ✅ // 不做 xxx：见 ADR-0001 —— 理由是 yyy
```

`TODO` 换成 `不做` + 理由。`TODO` 会永远留着，`不做` + 理由会让人重新思考。

---

## 5. 错误

```ts
throw new RaccoonError({
  kind: "AUTH",
  status: 401,
  message: "小浣熊登录已失效，请在设置 → 插件 → 小浣熊 里重新扫码。",
  upstream: text,
});
```

- `message` 是**给用户看的中文**，不是 `"unauthorized"`。
- `upstream` 是原始文本，**只进日志**。
- 一个错误的 `message` 里不能有 token、不能有完整 URL（含 query 的）。

---

## 6. 日志

```ts
ctx.logger?.info(`[raccoon-web] ${msg}`);
```

- 前缀固定 `[raccoon-web]`。
- 级别：`debug`（每帧/每次重试）、`info`（登录成功/失败、发布/撤销）、`warn`（可恢复的异常）、`error`（用户会看到的错误）。
- **不许用 `console.log`** —— 在 Electron 主进程里，`console.log` 的去向不可控。
- **不许打 token**。要打就打 `sha256(token).slice(0, 8)`。

---

## 7. 类型

内核包没有 `.d.ts`（E-009）。所以：

### 7.1 自己写最小声明

`src/types/dsh.d.ts`：

```ts
declare module "@deepseek-ai/dsh-llm-pi-ai" {
  export class PiAiAdapter {
    constructor(options: Record<string, unknown>);
  }
}

declare module "@deepseek-ai/dsh-llm" {
  export function resolveRetryPolicy(config: unknown, provider?: string): unknown;
  export function resolveImageAttachmentAccess(
    attachments: unknown,
    toProcessPath: (p: string) => string | undefined,
    ref: unknown,
  ): unknown;
}
```

**只声明用到的**。声明多了会掩盖真实 API。

### 7.2 `any` 的使用

允许，但**必须紧挨着注释说明为什么**：

```ts
// pi-ai 的 Api 接口没有类型声明（E-010）。
// 形状从 dist/api/openai-completions.js 反推，字段名见下方 stream() 的参数解构。
const api = { id: "raccoon-chat", stream } as any;
```

`as any` 出现超过 5 次，说明该重新评估 [ADR-0003](adr/0003-reasoning-channel.md) 了。

---

## 8. 构建

### 8.1 tsup 配置

```ts
// tsup.config.ts
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: false,        // ⚠️ 必须 false，见下
  dts: false,              // 内核没类型，dts 打不出来
  external: [
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-llm-pi-ai",
    "@deepseek-ai/dsh-settings",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/*",
  ],
  clean: true,
});
```

**`splitting: false` 必须**。`dsh-raccoon-connect` 栽在这上面：分包出了 `version-Bdhdp2uE.js`，loader 的相对路径一错整个插件起不来。单文件输出，多几 KB 无所谓。

### 8.2 不打包的东西

| 打进 bundle | 不打包 |
| --- | --- |
| `src/**` | 内核包（`@deepseek-ai/*`） |
| 自己写的 QR 编码器 | `@earendil-works/pi-ai`（含子路径） |
| 常量 | Node 内置 |
| | `client.js`（单独文件，不经 tsup） |

---

## 9. 测试

### 9.1 分层

| 层 | 测法 | 依赖 |
| --- | --- | --- |
| `protocol/` | Node 内置 test runner，注入 `fetch` | 零 |
| `provider/roster.ts` | 纯函数测试 | 零 |
| `host/` | 需要 mock `ctx` | 手写 mock |
| `client.js` | 手工验证（没有测试环境） | DSH 跑起来 |

### 9.2 不做的

- 不测 `adapter.ts`（它只是 `createProvider` + `new PiAiAdapter`，测它等于测内核）
- 不测 SSE 解析的每个边界（只测三种已知帧形状 + 一种未知帧）
- 不引入 vitest / jest。用 `node --test`。

### 9.3 关键字

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("qr: 149 字节选版本 8", () => {
  assert.equal(pickVersion(149), 8);
});
```

`pickVersion(149)` 这个用例直接对应 E-007。**每个实测结论都要有一条对应的测试。**

---

## 10. Git

| 项 | 规则 |
| --- | --- |
| 分支 | `main` 直接推（一个人的项目） |
| commit | `<area>: <中文描述>`，如 `protocol: 补 xhx_token 的 cookie 解析` |
| 不提交 | `research/`、`lib/`、`node_modules/`、`*.tsbuildinfo` |
| 提交前 | `pnpm -w run typecheck && pnpm -w run build` |

`research/pkgs/` 里是别人的包（~2 MB），只读参考，不进版本库。

---

## 11. 文档

改代码时**同一次改动里**更新对应文档：

| 改了 | 改哪篇 |
| --- | --- |
| 端点 / 请求头 / 错误码 | `docs/01-research/03-raccoon-protocol.md` |
| 模块边界 / 新文件 | `docs/02-design/01-module-map.md` |
| 数据流 | `docs/02-design/02-data-flow.md` |
| UI | `docs/02-design/04-ui-surfaces.md` |
| 错误文案 / 重试 | `docs/02-design/05-error-model.md` |
| 架构级决定 | 新 ADR（不改旧的） |
| 实测数据 | `docs/01-research/05-empirical-findings.md` |

**不接受"回头补"。** 回头就是不会补。

---

## 12. 一条总原则

**当你不确定时，去看 `docs/01-research/05-empirical-findings.md`。**

这个项目全程在跟一个没有文档、随时会变的私有网关打交道。代码里每一个"奇怪的"写法背后都应该有一条实测记录。找不到记录 → 要么补测，要么那个写法是错的。
