/**
 * Node ESM loader：让 `import "./errors.js"` 在源码目录里解析到 `errors.ts`。
 *
 * 为什么需要：
 *   源码用 TS 写、产物是 ESM，所以源码里的相对导入必须写 `.js`
 *   （tsup/tsc 都不会帮你改后缀，NodeNext 也要求显式后缀）。
 *   但单元测试要直接跑 `.ts` 源码 —— 那就得有人把 `.js` 映射回 `.ts`。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs --test "test/**\/*.test.ts"
 *
 * 只在测试/脚本里用。构建产物里不存在这层间接。
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 把 `file:///x/errors.js` 改成 `file:///x/errors.ts`，前提是后者存在而前者不存在。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const base = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
    try {
      const url = new URL(specifier, base);
      const fsPath = fileURLToPath(url);
      if (!existsSync(fsPath)) {
        const tsPath = fsPath.replace(/\.js$/, ".ts");
        if (existsSync(tsPath)) {
          // 不要指定 format：一旦写成 "module"，Node 会当成纯 JS 加载，
          // --experimental-strip-types 的类型擦除就不会发生，.ts 里的
          // `export` 会被当成语法错误。交给默认 loader 推断才能剥类型。
          return { url: pathToFileURL(tsPath).href, shortCircuit: true };
        }
      }
    } catch {
      // 落回默认解析
    }
  }
  return nextResolve(specifier, context);
}
