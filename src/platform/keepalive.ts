/**
 * platform/keepalive.ts —— 同步期间维持 service worker 存活（NFR-7）。
 *
 * MV3 的 worker 会被随时终止。这里定期调一个廉价的扩展 API 把空闲计时器
 * 顶回去，但**正确性绝不依赖它** —— worker 被杀只是让本次同步失败重来，
 * 由 INV-1 到 INV-4 保证不产生坏状态。
 *
 * 所以这个模块刻意做得很薄：不重试、不报错、不影响调用方的控制流。
 */

/** 间隔取 20 秒。Chrome 的空闲阈值是 30 秒，留出余量。 */
const PING_INTERVAL_MS = 20_000;

export interface KeepaliveDeps {
  /** 廉价的扩展 API 调用。默认用 chrome.runtime.getPlatformInfo。 */
  ping?: () => Promise<unknown>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface Keepalive {
  stop(): void;
}

function defaultPing(): Promise<unknown> {
  return chrome.runtime.getPlatformInfo();
}

/**
 * 开始保活，返回停止句柄。调用方必须在同步结束时 stop()，
 * 否则计时器会把 worker 永久顶活，白耗电。
 */
export function startKeepalive(deps: KeepaliveDeps = {}): Keepalive {
  const ping = deps.ping ?? defaultPing;
  const intervalMs = deps.intervalMs ?? PING_INTERVAL_MS;

  const timer = setInterval(() => {
    void Promise.resolve()
      .then(ping)
      .catch((error: unknown) => {
        // 保活失败不该影响同步。最多记一笔。
        deps.onError?.(error);
      });
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

/** 在一段异步工作期间保活，结束后自动停止。 */
export async function withKeepalive<T>(work: () => Promise<T>, deps?: KeepaliveDeps): Promise<T> {
  const keepalive = startKeepalive(deps);
  try {
    return await work();
  } finally {
    keepalive.stop();
  }
}
