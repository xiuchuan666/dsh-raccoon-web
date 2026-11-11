/**
 * 状态快照：宿主与浏览器之间的**唯一**数据契约。
 *
 * 一个 `GET /plugins/dsh-raccoon-web/status` 返回这个对象；设置卡、积分药丸、
 * 诊断块全部从它渲染。所以这个形状一旦发布就不能随便改字段名 ——
 * 改了旧版浏览器半身会静默少显示一块。
 *
 * ## 三条硬规则
 *
 * 1. **不含 token。** 一个字节都不含，连摘要也不含（摘要由日志承担）。
 *    浏览器是渲染进程，token 出现在那里就等于出现在 devtools 里。
 * 2. **错误要带 kind。** UI 按 kind 决定用哪种文案与颜色，
 *    而不是 match 中文串。
 * 3. **`build` 必须存在。** 浏览器缓存 client.js 时，没有 build 就没法
 *    确认"我看到的是新版"。见 docs/04-ops/01-troubleshooting.md §2。
 *
 * @module host/status
 */

import type { LoginPhase } from "./login-flow.js";
import type { PublishState } from "./publish.js";
import type { PoolState } from "./pool.js";

/** 一个模型的展示信息。 */
export interface StatusModel {
  id: string;
  name: string;
  /** 是否支持图片。已应用实测覆盖。 */
  vision: boolean;
  /** 积分倍率。没有就是 1。 */
  multiplier: number | undefined;
  contextWindow: number;
  maxTokens: number;
  /** 目录说支持、实测说不支持（或反过来）时，这里是实测结论。 */
  probed?: boolean;
}

/** 余额三项。全部可能缺 —— 上游字段名不稳定。 */
export interface StatusQuota {
  available: number | undefined;
  permanent: number | undefined;
  daily: number | undefined;
  /** 今日每日积分是否已到账（只读判定，不代领）。 */
  dailyGranted: boolean | null;
  /** 拉取时间 epoch ms。UI 用它显示"x 秒前"。 */
  at: number;
  /** 拉取失败的说明。命中缓存时也有可能是上一次的错。 */
  error?: string;
}

/** 登录块的快照。 */
export interface StatusLogin {
  phase: LoginPhase;
  /** 二维码 SVG。只在 pending/logging 时有。 */
  qrSvg?: string;
  /** epoch ms。 */
  deadline?: number;
  message?: string;
  /**
   * 这张二维码/这一轮登录是给谁用的：`primary` = 换当前账号，
   * `pool` = 往号池加一个成员。
   *
   * 设置卡的「登录」区与「账号池」区都各自有扫码按钮，共用同一个
   * `LoginFlow`。两个区都必须用 `mode` 认领"这张码是不是我的"，
   * 否则一边点按钮会让另一边的二维码显示成"还在等你扫"。
   */
  mode?: "primary" | "pool";
  /** JWT 的 sub 前 8 位。够区分账号，不够反推。 */
  principal?: string;
  /** token 类型。 */
  kind?: "access_token" | "xhx_token";
  /** epoch ms。 */
  expiresAt?: number;
  /** 当前这批 token 从哪来。 */
  source?: "qr" | "desktop";
}

/**
 * 桌面端凭据的探测结果。
 *
 * 只报"有没有、路径、什么时候过期"，**不报 token 本身**。
 * 用户看到"已从官方客户端读到登录态"才能理解为什么不用扫码；
 * 读不到时 `reason` 说明是没装、没登录、还是过期。
 */
export interface StatusDesktopAuth {
  /** 找到了可用的（未过期）凭据。 */
  found: boolean;
  /** 实际读的路径。找到时为命中的那个，没找到时为第一个候选。 */
  path?: string;
  /** epoch ms。 */
  expiresAt?: number;
  /** `found` 为 false 时的原因，给人看。 */
  reason?: string;
}

/**
 * 号池里的一个账号。
 *
 * **不含 token**（同 §三条硬规则第 1 条）。设备身份只给前 8 位：
 * 它的用途是"用户能看出两个号不是同一个环境"，不是让用户拿去复刻。
 */
export interface StatusPoolAccount {
  /** `sha256(principal).slice(0,16)`。UI 用它做 key。 */
  id: string;
  /** 用户起的名字，没有就显示 principal 前 8 位。 */
  label?: string;
  /** JWT sub 前 8 位。 */
  principal: string;
  /** epoch ms。 */
  expiresAt?: number;
  /** epoch ms。 */
  addedAt: number;
  /** 是否参与自动换号。 */
  enabled: boolean;
  /**
   * `x-client-device-id` 去掉 `raccoon-` 前缀后的前 8 位十六进制。
   *
   * **不带前缀**：早期版本用 `slice(0, 8)` 把 `raccoon-` 整个吃掉了，
   * 界面上显示成 `设备 raccoon-`，看起来像"设备标识是空的"。
   */
  device: string;
  /** 这个号从哪来。 */
  source: "qr" | "desktop";
  /** 最近一次测量的结论。没测过就是 undefined。 */
  measure?: {
    state: PoolState;
    /** epoch ms。 */
    at: number;
    /** 冷却到期时间，epoch ms。`dead` 时是 `Number.MAX_SAFE_INTEGER`。 */
    until?: number;
    note?: string;
  };
  /** 当前是不是这个号在服务。 */
  active: boolean;
}

/** 号池整体状态。 */
export interface StatusPool {
  /** 总开关。关掉时仍可签到/测试（ADR-0010 §5）。 */
  enabled: boolean;
  /** 是否已有账号（哪怕一个都没启用）。 */
  ready: boolean;
  /** 池里账号总数。 */
  total: number;
  /** 其中启用的数量。 */
  enabledCount: number;
  /** 当前在服务的账号 id。关掉号池时为 undefined。 */
  activeId?: string;
  accounts: StatusPoolAccount[];
  /** 池为空 / 全死 / 全部冷却 时的说明，给人看。 */
  note?: string;
}

/** 完整快照。 */
export interface StatusSnapshot {
  /** client.js 的构建标记。诊断时第一眼看的东西。 */
  build: string;
  /** 插件版本，来自 package.json。 */
  version: string;
  login: StatusLogin;
  /** provider 的注册状态。 */
  publish: PublishState;
  /** 目录是否已成功拉过。 */
  catalogReady: boolean;
  /** 目录拉取失败时的说明。 */
  catalogError?: string;
  models: StatusModel[];
  quota: StatusQuota;
  /** 用户可改的开关。UI 用它渲染成 switch。 */
  settings: {
    enabled: boolean;
    reasoning: boolean;
    visionProbeOverride: boolean;
    contextCap: number;
    debugLog: boolean;
    authSource: "auto" | "desktop" | "qr";
    qrProtocol: "web" | "iam";
    /** 号池总开关（ADR-0010）。 */
    poolEnabled: boolean;
  };
  /** 桌面端凭据探测结果。**不含 token。** */
  desktopAuth: StatusDesktopAuth;
  /** 号池状态。**不含 token。** */
  pool: StatusPool;
  /** 诊断块里可复制的纯文本。**不含 token。** */
  diagnostics: string;
}

/**
 * 生成诊断文本。
 *
 * 格式要求（给人看 + 能贴进 issue）：
 * - 一行一个事实，`key: value`
 * - 不含 token、不含 cookie、不含完整 JWT
 * - 含 build / version / phase / models 数量 / quota 是否有值
 */
export function buildDiagnostics(input: {
  build: string;
  version: string;
  snapshot: Omit<StatusSnapshot, "diagnostics">;
  platform?: string;
  node?: string;
}): string {
  const { snapshot } = input;
  const lines = [
    `插件: dsh-raccoon-web ${input.version}`,
    `build: ${input.build}`,
    `平台: ${input.platform ?? process.platform} / node ${input.node ?? process.version}`,
    `登录: ${snapshot.login.phase}${snapshot.login.kind === undefined ? "" : ` (${snapshot.login.kind})`}`,
    `来源: ${snapshot.login.source === undefined ? "-" : snapshot.login.source === "desktop" ? "官方客户端凭据" : "扫码"}`,
    `桌面端: ${snapshot.desktopAuth.found ? `已读到 (${snapshot.desktopAuth.path ?? "-"})` : `未读到 (${snapshot.desktopAuth.reason ?? "-"})`}`,
    `账号: ${snapshot.login.principal ?? "-"}`,
    `provider: ${snapshot.publish}`,
    `目录: ${snapshot.catalogReady ? `${snapshot.models.length} 个模型` : "未就绪"}${snapshot.catalogError === undefined ? "" : ` (${snapshot.catalogError})`}`,
    `余额: ${snapshot.quota.available === undefined ? "未知" : snapshot.quota.available}${snapshot.quota.error === undefined ? "" : ` (${snapshot.quota.error})`}`,
    `上下文上限: ${snapshot.settings.contextCap}`,
    `思考: ${snapshot.settings.reasoning ? "开" : "关"}`,
    `扫码协议: ${snapshot.settings.qrProtocol === "web" ? "Web auth（官方桌面端同款）" : "IAM 小程序码"}`,
    `号池: ${poolLine(snapshot.pool)}`,
  ];
  return lines.join("\n");
}

/** 诊断块里的号池一行。 */
function poolLine(pool: StatusPool): string {
  if (!pool.enabled) {
    return pool.total === 0 ? "关（池空）" : `关（${pool.total} 个账号，未启用自动换号）`;
  }
  if (pool.total === 0) return "开（池空）";
  if (pool.enabledCount === 0) return `开（${pool.total} 个账号，0 个启用）`;
  const active = pool.activeId === undefined ? "-" : pool.activeId.slice(0, 8);
  return `开（${pool.enabledCount} 个启用，当前 ${active}）`;
}
