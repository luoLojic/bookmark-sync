import { describe, expect, it } from 'vitest';
import { RETRY_BASE_MS, RETRY_MAX_MS } from '../../src/shared/config.js';
import { AbortedError, NetworkError, RateLimited, ServerError, TimeoutError } from '../../src/shared/errors.js';
import {
  backoffMs,
  isBodylessMethod,
  isRetryableStatus,
  parseRetryAfter,
  request,
} from '../../src/platform/http.js';

/** 立即返回的 sleep，把退避等待折叠掉；同时记录被请求的等待时长。 */
function fakeClock(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms) => {
      waits.push(ms);
    },
    waits,
  };
}

function body(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 按序返回预设响应的假 fetch。函数型响应可用来抛错。 */
function stubFetch(steps: (Response | (() => never))[]): {
  impl: typeof fetch;
  calls: () => number;
  lastInit: () => RequestInit | undefined;
} {
  let i = 0;
  let lastInit: RequestInit | undefined;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    lastInit = init;
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (typeof step === 'function') step();
    return (step as Response).clone();
  }) as unknown as typeof fetch;
  return { impl, calls: () => i, lastInit: () => lastInit };
}

const ok = (text = 'ok', status = 200, headers?: Record<string, string>): Response =>
  // 204 / 304 规定不带响应体，Response 构造器会拒绝。
  new Response(status === 204 || status === 304 ? null : body(text), {
    status,
    ...(headers ? { headers } : {}),
  });

const deps = (over: Partial<Parameters<typeof request>[1]> = {}) => ({
  timeoutMs: 1000,
  maxRetries: 5,
  random: () => 1,
  ...over,
});

describe('isRetryableStatus（NFR-2）', () => {
  it('429 与 5xx 重试', () => {
    for (const s of [429, 500, 502, 503, 599]) expect(isRetryableStatus(s), String(s)).toBe(true);
  });

  it('2xx / 3xx / 4xx 不重试', () => {
    for (const s of [200, 204, 301, 400, 401, 403, 404, 409]) {
      expect(isRetryableStatus(s), String(s)).toBe(false);
    }
  });

  it('412 不重试 —— 它交给 engine 的合并轮次（FR-17）', () => {
    // 混淆两层重试会让「其他设备已提交」被当成网络抖动反复硬撞。
    expect(isRetryableStatus(412)).toBe(false);
  });
});

describe('backoffMs（NFR-2：指数退避 + 抖动）', () => {
  it('随尝试次数指数增长', () => {
    const full = (attempt: number): number => backoffMs(attempt, () => 1);
    expect(full(0)).toBe(RETRY_BASE_MS);
    expect(full(1)).toBe(RETRY_BASE_MS * 2);
    expect(full(2)).toBe(RETRY_BASE_MS * 4);
  });

  it('封顶在 30 秒', () => {
    expect(backoffMs(20, () => 1)).toBe(RETRY_MAX_MS);
  });

  it('抖动落在计算值的 50%–100%', () => {
    // 两台设备同时撞上 5xx 时，固定间隔会让它们永远同步重试、持续互相加压。
    expect(backoffMs(1, () => 0)).toBe(RETRY_BASE_MS);
    expect(backoffMs(1, () => 1)).toBe(RETRY_BASE_MS * 2);
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(3, Math.random);
      expect(v).toBeGreaterThanOrEqual(RETRY_BASE_MS * 8 * 0.5);
      expect(v).toBeLessThanOrEqual(RETRY_BASE_MS * 8);
    }
  });
});

describe('parseRetryAfter', () => {
  it('解析秒数', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(' 0 ', 0)).toBe(0);
  });

  it('解析 HTTP 日期，取相对当前的差值', () => {
    const now = Date.parse('2026-07-30T10:00:00Z');
    expect(parseRetryAfter('Thu, 30 Jul 2026 10:00:05 GMT', now)).toBe(5000);
  });

  it('过去的日期按 0 处理', () => {
    const now = Date.parse('2026-07-30T10:00:10Z');
    expect(parseRetryAfter('Thu, 30 Jul 2026 10:00:00 GMT', now)).toBe(0);
  });

  it('封顶在 30 秒，防止服务器把我们挂太久', () => {
    expect(parseRetryAfter('99999', 0)).toBe(RETRY_MAX_MS);
  });

  it('缺失或无法解析时返回 undefined', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('nonsense', 0)).toBeUndefined();
    expect(parseRetryAfter('-5', 0)).toBeUndefined();
  });
});

describe('request — 成功路径', () => {
  it('返回状态、响应头与字节', async () => {
    const f = stubFetch([ok('hello', 200, { etag: '"v1"' })]);
    const res = await request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl }));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(new TextDecoder().decode(res.bytes)).toBe('hello');
    expect(f.calls()).toBe(1);
  });

  it('透传方法、请求头与请求体', async () => {
    const f = stubFetch([ok('', 201)]);
    await request(
      { method: 'PUT', url: 'https://dav.test/a', headers: { 'if-match': '"v1"' }, body: body('payload') },
      deps({ fetchImpl: f.impl }),
    );
    const init = f.lastInit()!;
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'if-match': '"v1"' });
    expect(init.body).toBeInstanceOf(ArrayBuffer);
  });

  it('不修改调用方的字节视图', async () => {
    // fetch 拿到的必须是副本，否则调用方复用缓冲区会把已排队的请求体改掉。
    const payload = body('original');
    const f = stubFetch([ok('', 200)]);
    await request({ method: 'PUT', url: 'https://dav.test/a', body: payload }, deps({ fetchImpl: f.impl }));
    const sent = new Uint8Array(f.lastInit()!.body as ArrayBuffer);
    payload[0] = 0;
    expect(new TextDecoder().decode(sent)).toBe('original');
  });
});

describe('request — 不重试的状态直接返回（含 412）', () => {
  for (const status of [200, 204, 400, 401, 403, 404, 409, 412]) {
    it(`${status} 只请求一次`, async () => {
      const f = stubFetch([ok('', status)]);
      const res = await request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl }));
      expect(res.status).toBe(status);
      expect(f.calls()).toBe(1);
    });
  }
});

describe('request — 重试（NFR-2）', () => {
  it('5xx 后重试并最终成功', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 503), ok('', 503), ok('done', 200)]);
    const res = await request(
      { method: 'GET', url: 'https://dav.test/a' },
      deps({ fetchImpl: f.impl, sleep: clock.sleep }),
    );
    expect(new TextDecoder().decode(res.bytes)).toBe('done');
    expect(f.calls()).toBe(3);
    expect(clock.waits).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2]);
  });

  it('重试用尽后抛 ServerError', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 500)]);
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: f.impl, sleep: clock.sleep, maxRetries: 2 }),
      ),
    ).rejects.toBeInstanceOf(ServerError);
    // maxRetries=2 → 首次 + 2 次重试 = 3 次请求。
    expect(f.calls()).toBe(3);
    expect(clock.waits).toHaveLength(2);
  });

  it('429 抛 RateLimited 并优先采用 Retry-After', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 429, { 'retry-after': '7' }), ok('ok', 200)]);
    await request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl, sleep: clock.sleep }));
    expect(clock.waits).toEqual([7000]);
  });

  it('Retry-After 只影响紧接着的一次等待，之后回到指数退避', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 429, { 'retry-after': '7' }), ok('', 503), ok('ok', 200)]);
    await request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl, sleep: clock.sleep }));
    expect(clock.waits).toEqual([7000, RETRY_BASE_MS * 2]);
  });

  it('maxRetries 为 0 时不重试', async () => {
    const f = stubFetch([ok('', 503)]);
    await expect(
      request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl, maxRetries: 0 })),
    ).rejects.toBeInstanceOf(ServerError);
    expect(f.calls()).toBe(1);
  });

  it('429 用尽重试后抛 RateLimited', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 429)]);
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: f.impl, sleep: clock.sleep, maxRetries: 1 }),
      ),
    ).rejects.toBeInstanceOf(RateLimited);
  });
});

describe('request — 网络错误与超时（NFR-1）', () => {
  it('网络错误重试后成功', async () => {
    const clock = fakeClock();
    const f = stubFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      ok('ok', 200),
    ]);
    const res = await request(
      { method: 'GET', url: 'https://dav.test/a' },
      deps({ fetchImpl: f.impl, sleep: clock.sleep }),
    );
    expect(res.status).toBe(200);
    expect(f.calls()).toBe(2);
  });

  it('网络错误用尽重试后抛 NetworkError', async () => {
    const clock = fakeClock();
    const f = stubFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: f.impl, sleep: clock.sleep, maxRetries: 1 }),
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('超时被中止并归类为 TimeoutError', async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const clock = fakeClock();
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: impl, sleep: clock.sleep, timeoutMs: 5, maxRetries: 1 }),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('每次尝试各自计时，前一次超时不影响后一次（NFR-1「每个请求独立超时」）', async () => {
    let call = 0;
    const impl = ((_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Promise((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return Promise.resolve(ok('ok', 200));
    }) as unknown as typeof fetch;
    const clock = fakeClock();
    const res = await request(
      { method: 'GET', url: 'https://dav.test/a' },
      deps({ fetchImpl: impl, sleep: clock.sleep, timeoutMs: 5 }),
    );
    expect(res.status).toBe(200);
    expect(call).toBe(2);
  });

  it('非 TypeError / 非 AbortError 的异常直接上抛，不重试', async () => {
    // 程序错误重试没有意义，只会把真正的堆栈埋掉。
    const f = stubFetch([
      () => {
        throw new RangeError('程序错误');
      },
    ]);
    await expect(
      request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl })),
    ).rejects.toBeInstanceOf(RangeError);
    expect(f.calls()).toBe(1);
  });
});

describe('request — 用户取消（INV-3：不清任何状态）', () => {
  it('已取消的信号立即抛 AbortedError，一次请求都不发', async () => {
    const f = stubFetch([ok('', 200)]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      request({ method: 'GET', url: 'https://dav.test/a' }, deps({ fetchImpl: f.impl, signal: controller.signal })),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(f.calls()).toBe(0);
  });

  it('退避等待期间取消 → AbortedError 而非 ServerError', async () => {
    const controller = new AbortController();
    const f = stubFetch([ok('', 503)]);
    const sleep = async (): Promise<void> => {
      controller.abort();
    };
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: f.impl, sleep, signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(AbortedError);
  });

  it('请求进行中取消 → AbortedError 而非 TimeoutError', async () => {
    // 两者都表现为 AbortError，靠外部信号状态区分 —— 分错会让「用户取消」
    // 被当成网络问题继续重试。
    const controller = new AbortController();
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        setTimeout(() => controller.abort(), 1);
      })) as unknown as typeof fetch;
    await expect(
      request(
        { method: 'GET', url: 'https://dav.test/a' },
        deps({ fetchImpl: impl, signal: controller.signal, timeoutMs: 10_000 }),
      ),
    ).rejects.toBeInstanceOf(AbortedError);
  });
});

describe('request — 重试可观测（方案第 11 节日志规范）', () => {
  it('每次重试回调，供日志记录原因与等待时长', async () => {
    const clock = fakeClock();
    const f = stubFetch([ok('', 503), ok('', 429), ok('ok', 200)]);
    const seen: { attempt: number; delayMs: number; reason: string }[] = [];
    await request(
      { method: 'GET', url: 'https://dav.test/a' },
      deps({ fetchImpl: f.impl, sleep: clock.sleep, onRetry: (info) => seen.push(info) }),
    );
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[0]!.reason).toMatch(/503/);
    expect(seen[1]!.reason).toMatch(/429/);
  });
});

describe('request — GET / HEAD 不得带请求体（C-1 的护栏）', () => {
  // Fetch 规范判定的是 init.body 这个字段在不在，不是长度是否为 0，所以零长
  // ArrayBuffer 同样会抛 TypeError。这条曾让整个 S3 后端不可用：s3.ts 为了
  // 给 SigV4 算空载荷哈希，把 new Uint8Array() 一路传到了 fetch。
  //
  // 更糟的是 TypeError 会被 classifyFetchError 归成可重试的 NetworkError，
  // 于是退避重试 5 次约 31 秒后报「网络错误」，与真实原因毫无关联。
  // 因此这里必须是**不可重试**的编程错误。

  it('GET 带 body 时立刻抛错，且一次 fetch 都不发', async () => {
    const stub = stubFetch([new Response('never', { status: 200 })]);
    const clock = fakeClock();
    await expect(
      request(
        { method: 'GET', url: 'https://a.test/x', body: body('') },
        { timeoutMs: 100, maxRetries: 5, fetchImpl: stub.impl, sleep: clock.sleep },
      ),
    ).rejects.toThrow(/不得带请求体/);
    expect(stub.calls()).toBe(0);
    // 关键断言：不重试。重试才是原缺陷「31 秒后报网络错误」的来源。
    expect(clock.waits).toEqual([]);
  });

  it('空 body 也不放过 —— 长度为 0 不代表字段不存在', async () => {
    const stub = stubFetch([new Response('never', { status: 200 })]);
    await expect(
      request(
        { method: 'get', url: 'https://a.test/x', body: new Uint8Array() },
        { timeoutMs: 100, maxRetries: 0, fetchImpl: stub.impl },
      ),
    ).rejects.toThrow(/不得带请求体/);
    expect(stub.calls()).toBe(0);
  });

  it('HEAD 同样禁止', async () => {
    const stub = stubFetch([new Response(null, { status: 200 })]);
    await expect(
      request(
        { method: 'HEAD', url: 'https://a.test/x', body: body('x') },
        { timeoutMs: 100, maxRetries: 0, fetchImpl: stub.impl },
      ),
    ).rejects.toThrow(/不得带请求体/);
    expect(stub.calls()).toBe(0);
  });

  it('不带 body 的 GET 与带 body 的 PUT / POST 都正常放行', async () => {
    for (const [method, withBody] of [
      ['GET', false],
      ['HEAD', false],
      ['PUT', true],
      ['POST', true],
      ['DELETE', true],
    ] as const) {
      const stub = stubFetch([new Response('ok', { status: 200 })]);
      const res = await request(
        { method, url: 'https://a.test/x', ...(withBody ? { body: body('payload') } : {}) },
        { timeoutMs: 100, maxRetries: 0, fetchImpl: stub.impl },
      );
      expect(res.status, method).toBe(200);
      expect(stub.calls(), method).toBe(1);
    }
  });

  it('isBodylessMethod 大小写不敏感', () => {
    for (const m of ['GET', 'get', 'Get', 'HEAD', 'head']) expect(isBodylessMethod(m)).toBe(true);
    for (const m of ['PUT', 'POST', 'DELETE', 'MKCOL', 'PROPFIND']) {
      expect(isBodylessMethod(m)).toBe(false);
    }
  });
});
