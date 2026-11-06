/**
 * 扫码登录流程。
 *
 * ## 状态机
 *
 * ```
 * none ──start()──▶ pending ──轮询 pending──▶ pending
 *                    │                          │
 *                    │                    logging（已扫码，等确认）
 *                    │                          │
 *                    └──── success ────────────┘──▶ ready
 *                    └──── expired/canceled/error ──▶ none
 * ```
 *
 * `ready` 不是这里的最终态 —— 拿到 token 后由 `publish.ts` 注册 provider。
 * 这里只负责"把二维码给出去、把 token 收回来、存下来"。
 *
 * ## 四个容易写错的点
 *
 * 1. **网络抖动不能杀掉登录。** `pollQr()` 内部已经把 NETWORK_ERROR/TIMEOUT
 *    转成 `pending`（iam.ts 的注释），这里不能再做一次判断去取消。
 * 2. **deadline 每次轮询都要重置。** 服务端返回的 `expiresIn` 是**剩余**秒数，
 *    不是总时长（实测 300 → 269）。用它重置 deadline，用户有 5 分钟扫码，
 *    而不是"从点开算 5 分钟"。
 * 3. **成功之后必须探测 catalog。** IAM 发的 token 与业务网关认的 token
 *    不完全等价（要 `iam/confirm` 换 cookie），`validateToken()` 是唯一
 *    权威判断。IAM 说成功但网关拒绝，要报"账号已授权但网关拒绝"，
 *    不能报"登录成功"然后让用户在对话时才看到 401。
 * 4. **cancel 之后不能再写状态。** 用户点了取消／重新扫码，旧流程的在途
 *    轮询还会回来一次；用一个自增的 `generation` 把它丢弃。
 *
 * @module host/login-flow
 */

import { LOGIN_TIMEOUT_MS, QR_POLL_INTERVAL_MS } from "../protocol/consts.js";
import { confirmSession, createQr, pollQr, qrContent, validateToken } from "../protocol/iam.js";
import { createWebSession, pollWebSession, webQrContent } from "../protocol/web-auth.js";
import { jwtClaims, principalOf } from "../protocol/chat.js";
import type { QrProtocol } from "./settings.js";
import type { Logger } from "./log.js";
import { tokenTag } from "./log.js";
import { saveToken, type StoredToken } from "./store.js";

/** 登录阶段。`ready` 表示已有可用 token。 */
export type LoginPhase = "none" | "pending" | "logging" | "ready" | "expired" | "error";

/** 对外暴露的快照。**不含 token。** */
export interface LoginSnapshot {
  phase: LoginPhase;
  /** 二维码 SVG。`phase === "pending" | "logging"` 时才有。 */
  qrSvg?: string;
  /** epoch ms。二维码失效时刻。 */
  deadline?: number;
  /** 用户可读提示。`phase === "error"` 时是错误说明。 */
  message?: string;
}

/** 构造参数。全部注入，方便单测。 */
export interface LoginFlowOptions {
  logger: Logger;
  /** 渲染二维码。由 host 层传进 `renderQrSvg`。 */
  renderQr: (content: string) => string;
  /** 已有 token 时的初始状态判定。 */
  initialToken?: StoredToken;
  /** 登录成功后回调（用于注册 provider）。 */
  onReady: (token: StoredToken) => Promise<void> | void;
  /** 时钟，测试用。 */
  now?: () => number;
  /** fetch，测试用。 */
  fetchImpl?: typeof fetch;
  /** 单次轮询间隔覆盖，测试用。 */
  pollIntervalMs?: number;
  /** 整体超时覆盖，测试用。 */
  timeoutMs?: number;
  /**
   * 用哪套扫码协议。默认 `web`（官方桌面端那套，见 `protocol/web-auth.ts`）。
   *
   * 由 host 每次 `start()` 时从设置里读进来，所以改设置不用重建 LoginFlow。
   */
  qrProtocol?: () => QrProtocol;
}

/**
 * 登录流程。
 *
 * 一个实例同时只跑一个登录会话。重复 `start()` 会取消旧的（这是"二维码
 * 过期了点刷新"的正常路径，不该报错）。
 */
export class LoginFlow {
  private readonly options: LoginFlowOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  private generation = 0;
  private phase: LoginPhase = "none";
  private message: string | undefined;
  private qrSvg: string | undefined;
  private deadline: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private code: string | undefined;
  /** 本轮用的是哪套协议。`start()` 定下来，`tick()` 按它分派。 */
  private protocol: QrProtocol = "web";
  private disposed = false;

  constructor(options: LoginFlowOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.initialToken !== undefined) {
      this.phase = "ready";
    }
  }

  /** 当前快照。纯读，不改状态。 */
  snapshot(): LoginSnapshot {
    const base: LoginSnapshot = { phase: this.phase };
    if (this.qrSvg !== undefined && (this.phase === "pending" || this.phase === "logging")) {
      base.qrSvg = this.qrSvg;
    }
    if (this.deadline !== undefined && (this.phase === "pending" || this.phase === "logging")) {
      base.deadline = this.deadline;
    }
    if (this.message !== undefined) base.message = this.message;
    return base;
  }

  /**
   * 开一轮登录。返回第一张二维码的快照。
   *
   * 失败（网络错、上游 5xx）→ `phase = "error"`，不抛。
   * 用户看到的是设置卡里的一句提示 + 一个"重新获取"按钮，而不是一个
   * 停在 pending 的空二维码框。
   */
  async start(): Promise<LoginSnapshot> {
    if (this.disposed) return this.snapshot();
    this.cancel();
    const generation = this.generation;
    // 每轮重新读一次协议：用户可能在设置里换了，或者刚从 iam 切到 web。
    const protocol = this.options.qrProtocol?.() ?? "web";
    this.protocol = protocol;

    if (protocol === "web") {
      // Web auth 码**完全本地生成**，没有网络请求，所以不存在"取码失败"。
      // 状态直接从 none 进 pending。
      const session = createWebSession(this.now());
      this.code = session.code;
      this.phase = "pending";
      this.message = undefined;
      this.qrSvg = this.options.renderQr(webQrContent(session));
      this.deadline = this.now() + Math.min(session.expiresIn, LOGIN_TIMEOUT_MS / 1000) * 1000;
      this.options.logger.info("login/qr", {
        protocol,
        expiresIn: session.expiresIn,
        poll: session.pollInterval,
        code: `${session.code.slice(0, 6)}…`,
      });
      this.schedule(session.pollInterval * 1000);
      return this.snapshot();
    }

    try {
      const session = await createQr(this.fetchImpl);
      if (generation !== this.generation || this.disposed) return this.snapshot();

      this.code = session.code;
      this.phase = "pending";
      this.message = undefined;
      this.qrSvg = this.options.renderQr(qrContent(session));
      this.deadline = this.now() + Math.min(session.expiresIn, LOGIN_TIMEOUT_MS / 1000) * 1000;

      this.options.logger.info("login/qr", {
        protocol,
        expiresIn: session.expiresIn,
        poll: session.pollInterval,
      });
      this.schedule(session.pollInterval * 1000);
      return this.snapshot();
    } catch (error) {
      if (generation !== this.generation) return this.snapshot();
      this.fail(error);
      return this.snapshot();
    }
  }

  /** 用户取消 / 卸载时调。可以重复调用。 */
  cancel(): void {
    this.generation += 1;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.code = undefined;
    this.qrSvg = undefined;
    this.deadline = undefined;
    // ready 是"已有 token"，不该被 cancel 打回 none：cancel 只取消进行中的
    // 登录，不登出。登出走 logout()。
    if (this.phase !== "ready") this.phase = "none";
    this.message = undefined;
  }

  /** 卸载时调。之后所有在途回调都无效。 */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  /** 退出登录：清 token 并把阶段打回 none。 */
  async logout(): Promise<LoginSnapshot> {
    const { clearToken } = await import("./store.js");
    this.cancel();
    await clearToken().catch(() => undefined);
    this.phase = "none";
    this.options.logger.info("login/logout");
    return this.snapshot();
  }

  /**
   * 服务端明确说这个 token 死了（401 / 200003）。
   *
   * 只改**界面状态**，不删 token 文件 —— 这个区分很重要：
   * 删 token 是不可逆的，而"401"可能来自一次临时的网关抖动。
   * 用户重新扫码会覆盖旧 token，所以不删也不会脏。
   */
  markDead(message: string): void {
    if (this.phase === "pending" || this.phase === "logging") this.cancel();
    this.phase = "expired";
    this.message = message;
    this.qrSvg = undefined;
    this.deadline = undefined;
    this.options.logger.warn("login/dead", { message });
  }

  /**
   * 已经有可用 token 时把阶段置为 ready。
   *
   * 桌面端凭据路线（ADR-0008）不走扫码，但 UI 的"已登录"状态是同一个 ——
   * 让 `LoginFlow` 继续当唯一的相位来源，比在 host 里再维护一套状态判断可靠。
   * 不动 `generation`：万一有一轮扫码正在进行，它该被这通覆盖掉，
   * 所以先 `cancel()`。
   */
  markReady(message?: string): void {
    this.cancel();
    this.phase = "ready";
    this.message = message;
    this.options.logger.info("login/ready-desktop");
  }

  /** 内部：登录失败统一走这里。 */
  private fail(error: unknown): void {
    this.phase = "error";
    this.qrSvg = undefined;
    this.deadline = undefined;
    this.message = error instanceof Error ? error.message : String(error);
    this.options.logger.warn("login/error", { message: this.message });
  }

  /** 排下一次轮询。间隔取上游给的 pollInterval，兜底 2s。 */
  private schedule(delayMs: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const wait = Math.max(500, delayMs > 0 ? delayMs : (this.options.pollIntervalMs ?? QR_POLL_INTERVAL_MS));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick(this.generation);
    }, wait);
    // 不要因为这个定时器让宿主进程无法退出（桌面端关窗时立刻退）。
    this.timer.unref?.();
  }

  /** 一次轮询。 */
  private async tick(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const code = this.code;
    if (code === undefined) return;

    // 本地到点先判过期 —— 但**不删 token**，这里本来也没有 token。
    if (this.deadline !== undefined && this.now() >= this.deadline) {
      this.phase = "expired";
      this.qrSvg = undefined;
      this.deadline = undefined;
      this.message = "二维码已过期，请重新获取。";
      this.options.logger.info("login/expired");
      return;
    }

    let poll;
    try {
      poll =
        this.protocol === "web"
          ? await pollWebSession(code, this.fetchImpl)
          : await pollQr(code, this.fetchImpl);
    } catch (error) {
      // pollQr 内部已经把网络错转成 pending，走到这里说明是意料外的异常。
      // 依然不杀登录：再排一次。
      if (generation !== this.generation) return;
      this.options.logger.warn("login/poll-threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.schedule(QR_POLL_INTERVAL_MS);
      return;
    }
    if (this.disposed || generation !== this.generation) return;

    switch (poll.status) {
      case "pending":
        this.phase = "pending";
        this.schedule((poll.pollInterval ?? 2) * 1000);
        return;

      case "logging":
        // 这个阶段必须与 pending 区分：文案不同的同时，**不要重置二维码**，
        // 否则用户会以为是新码而重扫。
        this.phase = "logging";
        this.schedule((poll.pollInterval ?? 2) * 1000);
        return;

      case "success": {
        const accessToken = poll.accessToken;
        if (accessToken === undefined) {
          this.fail(new Error("小浣熊返回了登录成功，但没有带令牌。请重新扫码。"));
          return;
        }
        await this.complete(accessToken, generation);
        return;
      }

      case "expired":
        this.phase = "expired";
        this.qrSvg = undefined;
        this.deadline = undefined;
        this.message = "二维码已过期，请重新获取。";
        return;

      case "canceled":
        this.phase = "none";
        this.qrSvg = undefined;
        this.deadline = undefined;
        this.message = "已取消扫码。";
        return;

      default:
        this.fail(new Error(poll.message ?? "扫码登录失败。"));
        return;
    }
  }

  /** 拿到 access_token 之后：换 cookie（仅 IAM 码）→ 探测网关 → 落盘 → 回调。 */
  private async complete(accessToken: string, generation: number): Promise<void> {
    // `iam/confirm` 只对 **IAM 小程序码** 有意义（那套的 access_token 要换成
    // 业务 cookie 才被网关认）。Web auth 码拿到的本来就是 IAM JWT，
    // 官方桌面端直接拿它当 Bearer 用，多换一次只是多一个可能失败的请求。
    const cookie =
      this.protocol === "web" ? undefined : await confirmSession(accessToken, this.fetchImpl).catch(() => undefined);
    const token = cookie ?? accessToken;
    const kind: StoredToken["kind"] = cookie === undefined ? "access_token" : "xhx_token";

    const valid = await validateToken(token, this.fetchImpl).catch(() => false);
    if (this.disposed || generation !== this.generation) return;
    if (!valid) {
      this.fail(
        new Error("小浣熊账号已授权，但模型网关拒绝了这次登录令牌。请重新扫码；若持续出现，请稍后再试。"),
      );
      return;
    }

    const claims = jwtClaims(token);
    const exp = typeof claims?.["exp"] === "number" ? (claims["exp"] as number) * 1000 : undefined;
    const stored: StoredToken = {
      schemaVersion: 1,
      token,
      kind,
      savedAt: this.now(),
      ...(exp === undefined ? {} : { expiresAt: exp }),
      principal: principalOf(token),
    };

    await saveToken(stored);
    this.phase = "ready";
    this.qrSvg = undefined;
    this.deadline = undefined;
    this.message = undefined;
    this.code = undefined;
    this.options.logger.info("login/ready", { token: tokenTag(token), kind, principal: stored.principal });

    await this.options.onReady(stored);
  }
}
