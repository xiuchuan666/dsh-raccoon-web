/**
 * 单测专用 ESM loader。
 *
 * 做两件事：
 *
 * 1. **把内核包映射到测试桩。**
 *    内核包只能从 DSH 安装目录解析（见 docs/01-research/05-empirical-findings.md E-008）：
 *    `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm` 是一条悬空符号链接，
 *    从仓库里 `import` 只会拿到 ERR_MODULE_NOT_FOUND。所以测试里把
 *    `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@earendil-works/pi-ai`
 *    换成 `packages/dsh-raccoon-web/test/stubs/` 下的替身。
 *    替身只实现宿主真正会调用的那一小部分，**形状照抄内核实现**。
 *
 * 2. **把相对 `./x.js` 映射回 `x.ts`**（与 scripts/ts-resolve.mjs 同一份逻辑的合并版）。
 *    源码用 TS 写、产物是 ESM，所以相对导入必须写 `.js`。
 *
 * 只有在测试里才用。构建产物里不存在任何间接层。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = resolvePath(HERE, "..", "packages", "dsh-raccoon-web", "test", "stubs");

/** 裸包名 → 桩文件。 */
const STUB_MAP = new Map([
  ["@deepseek-ai/dsh-llm", join(STUBS, "dsh-llm.ts")],
  ["@deepseek-ai/dsh-llm-pi-ai", join(STUBS, "dsh-llm-pi-ai.ts")],
  ["@earendil-works/pi-ai", join(STUBS, "pi-ai.ts")],
  ["@earendil-works/pi-ai/api/openai-completions.lazy", join(STUBS, "pi-ai.ts")],
]);

export async function resolve(specifier, context, nextResolve) {
  const stub = STUB_MAP.get(specifier);
  if (stub !== undefined) {
    for (const candidate of [stub, stub.replace(/\.ts$/, ".js")]) {
      const file = candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".ts") : candidate;
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }

  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const base = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
    try {
      const url = new URL(specifier, base);
      const fsPath = fileURLToPath(url);
      if (!existsSync(fsPath)) {
        const tsPath = fsPath.replace(/\.js$/, ".ts");
        if (existsSync(tsPath)) {
          // 不要指定 format：一旦写成 "module"，Node 会当成纯 JS 加载，
          // --experimental-strip-types 的类型擦除就不会发生。
          return { url: pathToFileURL(tsPath).href, shortCircuit: true };
        }
      }
    } catch {
      // 落回默认解析
    }
  }

  return nextResolve(specifier, context);
}
