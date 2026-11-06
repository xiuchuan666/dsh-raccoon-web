/**
 * 测试用的假 `fetch`。
 *
 * 协议层全部接受 `fetchImpl` 注入（见 docs/02-design/06-coding-conventions.md），
 * 所以测试不需要起服务器，也不需要 nock 之类的依赖。
 *
 * 三种构造方式：
 *   - `json(status, body)`：一次性 JSON 响应
 *   - `sse(chunks)`：流式响应，用来测 `chatStream` 的逐帧解析
 *   - `failure(error)`：直接抛错，用来测网络错误路径
 *
 * @module test/helpers
 */

/** 一次请求的记录。 */
export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 响应描述。 */
export type Reply =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "sse"; status: number; chunks: readonly string[]; headers?: Record<string, string> }
  | { kind: "throw"; error: Error };

/** 假 fetch 的形状：既有 `.calls`，也能当函数用。 */
export interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: Call[];
  /** 最后一次调用的 body，按 JSON 解析。解析不了就返回原文。 */
  lastBody(): unknown;
}

/** JSON 响应。 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { kind: "json", status, body, headers };
}

/** 纯文本响应。 */
export function text(status: number, body: string, headers: Record<string, string> = {}): Reply {
  return { kind: "text", status, body, headers };
}

/** SSE 响应。`chunks` 会被**原样**依次写入，不补换行 —— 用来测半行。 */
export function sse(chunks: readonly string[], status = 200): Reply {
  return { kind: "sse", status, chunks };
}

/** 网络层错误（`fetch` reject）。 */
export function failure(error: Error): Reply {
  return { kind: "throw", error };
}

/**
 * 造一个假 fetch。
 *
 * @param replies 依次返回的响应。用完最后一个后会重复它（避免测试里因为多一次
 *   轮询就 index out of range）。
 */
export function fakeFetch(...replies: Reply[]): FakeFetch {
  const calls: Call[] = [];
  let index = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = init.headers;
      if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k.toLowerCase()] = v;
      } else if (typeof (h as Headers).forEach === "function") {
        (h as Headers).forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error("fakeFetch: 没有提供任何 reply");

    // 每个测试都可能断言"尊重了传进来的 AbortSignal"
    if (init?.signal?.aborted === true) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    if (reply.kind === "throw") throw reply.error;

    if (reply.kind === "json") {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }
    if (reply.kind === "text") {
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": "text/plain", ...reply.headers },
      });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of reply.chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: reply.status,
      headers: { "content-type": "text/event-stream", ...reply.headers },
    });
  };

  const fetchImpl = impl as FakeFetch;
  fetchImpl.calls = calls;
  fetchImpl.lastBody = () => {
    const last = calls[calls.length - 1];
    if (last?.body === undefined) return undefined;
    try {
      return JSON.parse(last.body) as unknown;
    } catch {
      return last.body;
    }
  };
  return fetchImpl;
}

/** 一个永远不会 resolve 的 fetch —— 用来测超时。它只尊重 signal。 */
export function hangingFetch(): FakeFetch {
  const calls: Call[] = [];
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(_input), method: init?.method ?? "GET", headers: {}, body: undefined });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const fetchImpl = impl as FakeFetch;
  fetchImpl.calls = calls;
  fetchImpl.lastBody = () => undefined;
  return fetchImpl;
}

/** SSE 帧拼装：`frame(obj)` → `data: {...}\n\n`。 */
export function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 一轮正常的文本增量帧。 */
export function textFrames(...pieces: string[]): string {
  return pieces.map((p) => frame({ choices: [{ delta: { content: p } }] })).join("");
}
