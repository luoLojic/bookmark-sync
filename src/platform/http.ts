/**
 * platform/http.ts —— 带超时、重试与退避的 fetch（NFR-1 / NFR-2）。
 *
 * 这是弱网可靠性的第一层。第二层是 engine 的合并轮次重试（FR-17），两层
 * 不得混淆：这里重试网络抖动，那里重试逻辑冲突（412 / 写后校验失败）。
 * 因此 412 在这里**不重试**，直接把响应交回调用方。
 *
 * 重试条件严格按 NFR-2：超时、网络错误、429、5xx。401 / 403 / 404 不重试 ——
 * 它们重试一万次也是同样的结果，只会拖长用户等待。
 */

import { RETRY_BASE_MS, RETRY_MAX_MS } from '../shared/config.js';
import {
  AbortedError,
  InternalError,
  NetworkError,
  RateLimited,
  ServerError,
  TimeoutError,
} from '../shared/errors.js';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface HttpDeps {
  /** 每个请求独立超时（NFR-1）。 */
  timeoutMs: number;
  /** 最大重试次数（NFR-2，默认 5）。 */
  maxRetries: number;
  /** 用户取消（popup 的取消按钮）。★ 原子提交点之前才允许。 */
  signal?: AbortSignal;
  /** 以下三项便于测试注入。 */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch 规范禁止带实体的方法。判定看的是 `init.body` 这个**字段是否存在**，
 * 不是长度是否为 0 —— 传一个零长 ArrayBuffer 同样会抛
 * `Request with GET/HEAD method cannot have body`。
 *
 * 这条曾经让整个 S3 后端不可用：`s3.ts` 的 get / remove / list 都传了
 * `new Uint8Array()`（签名需要空载荷的哈希），TypeError 又被
 * `classifyFetchError` 归成可重试的 NetworkError，于是退避重试 5 次约 31 秒后
 * 报「网络错误」，与真实原因毫无关联。测试没抓到是因为假 fetch 比真 fetch 宽松。
 *
 * 所以这里把它变成一条显式断言：违反即是编程错误，按 Fatal 立刻失败，
 * 绝不伪装成网络问题重试。
 */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

export function isBodylessMethod(method: string): boolean {
  return BODYLESS_METHODS.has(method.toUpperCase());
}

/** 哪些 HTTP 状态值得重试。412 刻意不在其中，见文件头。 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * 退避间隔：指数增长 + 随机抖动（NFR-2）。
 *
 * 抖动取计算值的 50%–100%。两台设备的定时同步若同时撞上服务器 5xx，
 * 固定间隔会让它们永远同步重试、持续互相加压。
 */
export function backoffMs(attempt: number, random: () => number): number {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/** 解析 Retry-After（秒数或 HTTP 日期），失败返回 undefined。 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();

  // 先判定「是不是数字形式」，再看数值是否合法。不能直接把解析失败的数字
  // 丢给 Date.parse —— "-5" 会被当成年份解析成一个合法日期。
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (seconds < 0) return undefined;
    return Math.min(seconds * 1000, RETRY_MAX_MS);
  }

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), RETRY_MAX_MS);
}

function toBodyInit(body: Uint8Array | string | undefined): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  // 复制到独立的 ArrayBuffer：避免把调用方的视图交给 fetch 后被并发修改。
  return body.slice().buffer as ArrayBuffer;
}

/**
 * 发一个请求，内部按 NFR-2 重试。
 *
 * 返回值只包含「不值得重试」的结果 —— 2xx、3xx、以及 4xx（含 412）。
 * 重试用尽后抛出对应的 Transient 错误，由 engine 决定是否再来一轮。
 */
export async function request(req: HttpRequest, deps: HttpDeps): Promise<HttpResponse> {
  if (req.body !== undefined && isBodylessMethod(req.method)) {
    throw new InternalError(`${req.method.toUpperCase()} 请求不得带请求体（${req.url}）`);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  // 用函数读取而不是直接比较：signal.aborted 会在等待期间变化，
  // 而 TypeScript 会把重复的属性比较窄化成常量。
  const aborted = (): boolean => deps.signal?.aborted === true;

  let lastError: Error | undefined;
  // Retry-After 只影响紧接着的那一次等待，不参与指数退避的计数。
  // 必须是函数内的局部量：模块级变量会在并发请求之间互相串味。
  let retryAfterMs: number | undefined;

  for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
    if (aborted()) throw new AbortedError();

    if (attempt > 0) {
      const delay = retryAfterMs ?? backoffMs(attempt - 1, random);
      retryAfterMs = undefined;
      deps.onRetry?.({ attempt, delayMs: delay, reason: lastError?.message ?? 'retry' });
      await sleep(delay);
      if (aborted()) throw new AbortedError();
    }

    const timer = new AbortController();
    // 用户取消与超时合并成一个信号：任一触发都要立刻放弃这次请求。
    const onExternalAbort = (): void => timer.abort();
    deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = setTimeout(() => timer.abort(), deps.timeoutMs);

    try {
      const init: RequestInit = { method: req.method, signal: timer.signal };
      if (req.headers !== undefined) init.headers = req.headers;
      const body = toBodyInit(req.body);
      if (body !== undefined) init.body = body;

      const response = await fetchImpl(req.url, init);
      const buffer = await response.arrayBuffer();
      const result: HttpResponse = {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(buffer),
      };

      if (!isRetryableStatus(response.status)) return result;

      lastError =
        response.status === 429
          ? new RateLimited()
          : new ServerError(response.status, `HTTP ${response.status} ${req.method} ${req.url}`);
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
    } catch (error) {
      // 外部取消与超时都表现为 AbortError，靠外部信号的状态区分。
      if (aborted()) throw new AbortedError();
      lastError = classifyFetchError(error, req);
      if (!(lastError instanceof TimeoutError) && !(lastError instanceof NetworkError)) throw lastError;
    } finally {
      clearTimeout(timeout);
      deps.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError ?? new NetworkError(`${req.method} ${req.url} 失败`);
}

function classifyFetchError(error: unknown, req: HttpRequest): Error {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new TimeoutError(`${req.method} ${req.url} 超时`);
  }
  if (error instanceof TypeError) {
    // fetch 把 DNS、连接中断、CORS 等一律报成 TypeError。
    return new NetworkError(`${req.method} ${req.url}: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : new NetworkError(String(error));
}
