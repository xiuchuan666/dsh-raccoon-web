/**
 * 注册 ts-resolve 钩子。配合 ts-resolve.mjs 使用。
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve-register.mjs ...
 */

import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
