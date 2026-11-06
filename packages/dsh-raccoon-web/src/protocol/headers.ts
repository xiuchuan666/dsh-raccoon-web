/**
 * 请求头装配。**三种头组合全部集中在这里。**
 *
 * 为什么不散在各自模块里：sensenova 插件把 `raccoonRequestHeaders()`
 * 放在 `raccoon-models.js` 里，结果两个实现的头不一致，没人能对比出来
 * （见 ADR-0004 的反例一节）。
 *
 * @module protocol/headers
 */

import { CLIENT_VERSION } from "./consts.js";

/** 客户端平台标识。按进程平台推断 —— 与官方桌面客户端一致。 */
export function clientPlatform(): "desktop-windows" | "desktop-macos" | "desktop-linux" {
  switch (process.platform) {
    case "darwin":
      return "desktop-macos";
    case "linux":
      return "desktop-linux";
    default:
      return "desktop-windows";
  }
}

/**
 * IAM 头。
 *
 * 登录阶段还没有 token，也不该带任何客户端标识 —— 这三步是纯 IAM 调用，
 * 官方客户端在这个阶段同样只发标准的 json 头。
 */
export function iamHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
  };
}

/**
 * 业务读接口头（目录 / 积分）。
 *
 * `x-org-code: ""` —— **必须存在，值为空串**。
 * 删掉这个 key 与留空串是两回事：网关会把"没有组织头"当成另一种上下文。
 * 这是参考实现里唯一被两个独立实现都保留的私有头，说明它是必需的。
 */
export function webHeaders(token: string, language: "zh" | "zh-CN" = "zh"): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-org-code": "",
    "x-raccoon-language": language,
    "x-client-platform": clientPlatform(),
    "x-client-version": CLIENT_VERSION,
  };
}

/**
 * 对话头 = 业务读头 + 会话 id。
 *
 * 会话 id 只在 chat 请求上带。目录 / 积分不带 —— 它们不是"会话"。
 *
 * `sessionId` 由 `sessionIdFor()` 算出，是**稳定**的（同一账号+模型恒定）。
 * 每次请求新 id 会让网关看到"一个账号几分钟内开了几百个会话"，
 * 这是最容易被风控识别为脚本的行为。
 */
export function chatHeaders(
  token: string,
  sessionId: string,
  language: "zh" | "zh-CN" = "zh",
): Record<string, string> {
  return {
    ...webHeaders(token, language),
    "content-type": "application/json",
    "x-raccoon-session-id": sessionId,
  };
}

/**
 * 对话头，但**不含 `authorization`**。
 *
 * 用于 pi-ai 的 `model.headers`：`authorization` 由 pi-ai 自己的 apiKey 通路
 * 写入（`new OpenAI({apiKey})` → `Authorization: Bearer <key>`），
 * 我们在这里再写一遍只会制造两个真相。
 *
 * 这几个头是**按模型**定型的（`x-raccoon-session-id` 依赖 model id），
 * 所以可以烘进 descriptor；token 变了 descriptor 会重建（见 host/publish.ts）。
 */
export function chatModelHeaders(sessionId: string, language: "zh" | "zh-CN" = "zh"): Record<string, string> {
  return {
    accept: "application/json",
    "x-org-code": "",
    "x-raccoon-language": language,
    "x-client-platform": clientPlatform(),
    "x-client-version": CLIENT_VERSION,
    "x-raccoon-session-id": sessionId,
  };
}

/** IAM confirm 用的头：Bearer + 中文语言位（不带客户端标识）。 */
export function confirmHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-raccoon-language": "zh-CN",
  };
}
