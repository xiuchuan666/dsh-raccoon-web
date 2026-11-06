/**
 * 注册 test-resolve 钩子。
 *
 *   node --experimental-strip-types --import ./scripts/test-resolve-register.mjs --test "..."
 */

import { register } from "node:module";

register("./test-resolve.mjs", import.meta.url);
