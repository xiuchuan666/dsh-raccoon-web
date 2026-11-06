import { defineConfig } from "tsup";

/**
 * 宿主半身（lib/index.js）的构建配置。
 *
 * 三个关键约束：
 *
 * 1. `splitting: false` —— **必须**。dsh-raccoon-connect 曾把 tsup 默认分包出来的
 *    `version-Bdhdp2uE.js` 一起发布，结果宿主按 module-graph 加载时找不到那个 chunk。
 *    单文件产物是插件能被加载的前提。
 *
 * 2. `external` —— 内核包与 pi-ai 必须留给宿主解析。它们只能从 DSH 安装目录的
 *    node_modules 里 import（见 docs/01-research/05-empirical-findings.md E-008），
 *    打进产物里会变成两份运行时，行为不可预测。
 *
 * 3. `noExternal` 对相对路径无效 —— `src/protocol/` 全部是相对导入，会被内联，
 *    这正是我们要的（protocol 层零依赖）。
 *
 * 浏览器半身（client.js）不经这里：它是手写的 classic script，
 * 由 `onSuccess` 钩子直接复制到 `lib/client.js`（见 build:client）。
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "lib",
  format: ["esm"],
  target: "node22",
  platform: "node",

  // 必须：单文件产物
  splitting: false,
  bundle: true,
  clean: true,

  // 不产出类型声明：内核包本身没有 .d.ts（E-009），
  // 我们的类型桩也只是给内部用，没有对外分发的价值。
  dts: false,
  sourcemap: false,
  minify: false,

  // 保留原始标识符，便于在宿主日志里看清堆栈
  keepNames: true,
  treeshake: true,

  external: [
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-llm-pi-ai",
    "@earendil-works/pi-ai",
  ],

  // 清掉 tsup 默认注入的 banner；DSH loader 用 import()，不需要 shebang
  banner: {},

  /**
   * 这里**故意不用** tsup 的 `onSuccess` 钩子。
   *
   * 实测（2026-11-06）：`onSuccess: "node ../../scripts/copy-client.mjs"` 在
   * 含中文的工作区路径下会被 tsup 用 shell 拼命令行执行，cmd.exe 按 cp936
   * 解释路径后报 `The system cannot find the path specified.`，随后 tsup
   * 以非零退出 —— 构建"看起来成功"但整个 `pnpm build` 挂掉。
   *
   * 复制这一步因此挪到 package.json 的 `build` 脚本里，由 pnpm 直接执行，
   * 不经过任何 shell 拼接。
   */
});
