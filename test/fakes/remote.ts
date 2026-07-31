/**
 * test/fakes/remote.ts —— 可注入弱网条件的假 WebDAV 服务器（方案 7.3）。
 *
 * 刻意做成「假的 fetch」而不是「假的 RemoteStore」：这样 platform/http.ts
 * 的超时重试、remote/webdav.ts 的 URL 拼接与状态映射、remote/store.ts 的
 * 错误分类全都在测试路径上。若只替换 RemoteStore，这三层就一行都没被验证。
 *
 * 可注入的条件（方案 7.3 逐项）：
 *   · 固定 / 随机延迟
 *   · 丢包率（表现为 fetch 抛 TypeError，与真实网络故障一致）
 *   · If-Match 支持开关（验证 FR-18 的降级模式）
 *   · 响应体截断（验证 NFR-4 的写后校验）
 *   · 429 / 5xx 注入
 *   · 并发写（多个 store 实例指向同一个 server）
 *
 * 随机源是可播种的，因此弱网用例可复现 —— 不可复现的弱网测试没法定位缺陷。
 */

export interface FakeRemoteOptions {
  /** 是否支持条件写。false 时服务器完全忽略 If-Match（FR-18 的降级场景）。 */
  ifMatch?: boolean;
  /** 是否返回 ETag。部分服务器不给，此时也应降级。 */
  etags?: boolean;
  /** 每个请求的固定延迟（毫秒）。 */
  latencyMs?: number;
  /** 额外的随机延迟上限（毫秒）。 */
  jitterMs?: number;
  /** 丢包率 0–1。命中时 fetch 抛 TypeError。 */
  lossRate?: number;
  /** 5xx 注入率 0–1。 */
  errorRate?: number;
  /** 429 注入率 0–1。 */
  throttleRate?: number;
  /** 响应体截断率 0–1。命中时只返回一半字节（NFR-4）。 */
  truncateRate?: number;
  /** 随机种子，保证弱网用例可复现。 */
  seed?: number;
  /** 是否支持 MKCOL。false 时返回 405，模拟只允许写文件的服务器。 */
  mkcol?: boolean;
}

interface StoredFile {
  bytes: Uint8Array;
  etag: string;
}

/** xorshift32：小、确定、够随机。 */
function seededRandom(seed: number): () => number {
  let state = seed | 0 || 0x2f6e2b1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

export class FakeRemote {
  private readonly files = new Map<string, StoredFile>();
  private readonly dirs = new Set<string>();
  private etagCounter = 0;
  private readonly random: () => number;
  private readonly options: Required<Omit<FakeRemoteOptions, 'seed'>>;

  /** 请求日志，用来断言「没发多余请求」这类要求。 */
  readonly log: { method: string; path: string; status: number }[] = [];

  constructor(options: FakeRemoteOptions = {}) {
    this.random = seededRandom(options.seed ?? 1);
    this.options = {
      ifMatch: options.ifMatch ?? true,
      etags: options.etags ?? true,
      latencyMs: options.latencyMs ?? 0,
      jitterMs: options.jitterMs ?? 0,
      lossRate: options.lossRate ?? 0,
      errorRate: options.errorRate ?? 0,
      throttleRate: options.throttleRate ?? 0,
      truncateRate: options.truncateRate ?? 0,
      mkcol: options.mkcol ?? true,
    };
  }

  // ── 直接操作内容，供测试搭场景 ─────────────────────────────────────

  seed(path: string, bytes: Uint8Array): void {
    this.files.set(this.normalize(path), { bytes, etag: this.nextEtag() });
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(this.normalize(path))?.bytes;
  }

  has(path: string): boolean {
    return this.files.has(this.normalize(path));
  }

  /**
   * 直接删掉一个文件，模拟「远端文件被误删 / 换了地址 / 路径填错」。
   * 这三种情况在协议上都表现为 GET 404，是 C-2 那条数据丢失路径的入口。
   */
  unlink(path: string): boolean {
    return this.files.delete(this.normalize(path));
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  etagOf(path: string): string | undefined {
    return this.files.get(this.normalize(path))?.etag;
  }

  /** 模拟其他设备提交：直接改内容并推进 ETag。 */
  commitFromOtherDevice(path: string, bytes: Uint8Array): void {
    this.seed(path, bytes);
  }

  countRequests(method?: string): number {
    return method === undefined ? this.log.length : this.log.filter((r) => r.method === method).length;
  }

  clearLog(): void {
    this.log.length = 0;
  }

  private nextEtag(): string {
    return `"v${++this.etagCounter}"`;
  }

  /** URL → 内部路径。丢掉协议与主机，保留路径并解码。 */
  private normalize(pathOrUrl: string): string {
    let path = pathOrUrl;
    const schemeAt = path.indexOf('://');
    if (schemeAt >= 0) {
      const afterHost = path.indexOf('/', schemeAt + 3);
      path = afterHost < 0 ? '/' : path.slice(afterHost);
    }
    const decoded = path
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join('/');
    return decoded.replace(/\/+/g, '/');
  }

  // ── 假 fetch ───────────────────────────────────────────────────────

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = this.normalize(href);

    // 与真实 fetch 对齐：GET / HEAD 带 body 在构造 Request 时就抛 TypeError，
    // 判定的是 body 字段在不在而非长度。假实现比真实平台宽松是 C-1 的成因，
    // 这条断言让同类错误在测试里就暴露，而不是等到真机。
    if ((method === 'GET' || method === 'HEAD') && init?.body != null) {
      throw new TypeError(`Failed to execute 'fetch': Request with ${method} method cannot have body.`);
    }

    await this.delay(init?.signal);

    // 丢包：表现为 TypeError，与真实 fetch 的网络故障一致。
    if (this.hit(this.options.lossRate)) {
      this.record(method, path, 0);
      throw new TypeError('fetch failed');
    }
    if (this.hit(this.options.throttleRate)) {
      this.record(method, path, 429);
      return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    }
    if (this.hit(this.options.errorRate)) {
      this.record(method, path, 503);
      return new Response('unavailable', { status: 503 });
    }

    switch (method) {
      case 'GET':
        return this.handleGet(path);
      case 'PUT':
        return this.handlePut(path, init);
      case 'DELETE':
        return this.handleDelete(path);
      case 'MKCOL':
        return this.handleMkcol(path);
      case 'PROPFIND':
        return this.handlePropfind(path);
      default:
        this.record(method, path, 405);
        return new Response('method not allowed', { status: 405 });
    }
  }) as unknown as typeof fetch;

  private async delay(signal?: AbortSignal | null): Promise<void> {
    const ms = this.options.latencyMs + Math.floor(this.random() * (this.options.jitterMs + 1));
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  private hit(rate: number): boolean {
    return rate > 0 && this.random() < rate;
  }

  private record(method: string, path: string, status: number): void {
    this.log.push({ method, path, status });
  }

  private handleGet(path: string): Response {
    const file = this.files.get(path);
    if (file === undefined) {
      this.record('GET', path, 404);
      return new Response('not found', { status: 404 });
    }
    // 截断：只返回一半字节，模拟弱网下响应体被切断（NFR-4）。
    const truncated = this.hit(this.options.truncateRate);
    const bytes = truncated ? file.bytes.slice(0, Math.floor(file.bytes.length / 2)) : file.bytes;
    this.record('GET', path, 200);
    const headers: Record<string, string> = {};
    if (this.options.etags) headers['etag'] = file.etag;
    return new Response(bytes as BlobPart, { status: 200, headers });
  }

  private async handlePut(path: string, init?: RequestInit): Promise<Response> {
    // 先把请求体读完，再做「检查 ETag 并写入」。真实服务器的条件写是原子的，
    // 若在检查与写入之间留下 await，两个并发提交会双双通过 —— 那是假实现的
    // 缺陷，会让 FR-17 的乐观并发看起来生效实则没有。
    const bytes = await bodyBytes(init?.body);
    const ifMatch = headerOf(init, 'if-match');
    const existing = this.files.get(path);

    // 不支持条件写的服务器完全忽略 If-Match —— 这正是 FR-18 要探测的行为。
    if (this.options.ifMatch && ifMatch !== undefined) {
      const current = existing?.etag;
      const matches = ifMatch === '*' ? existing !== undefined : current !== undefined && ifMatch === current;
      if (!matches) {
        this.record('PUT', path, 412);
        return new Response('precondition failed', { status: 412 });
      }
    }

    const etag = this.nextEtag();
    this.files.set(path, { bytes, etag });
    this.record('PUT', path, existing === undefined ? 201 : 204);

    const headers: Record<string, string> = {};
    if (this.options.etags) headers['etag'] = etag;
    return new Response(null, { status: existing === undefined ? 201 : 204, headers });
  }

  private handleDelete(path: string): Response {
    const existed = this.files.delete(path);
    this.record('DELETE', path, existed ? 204 : 404);
    return new Response(null, { status: existed ? 204 : 404 });
  }

  private handleMkcol(path: string): Response {
    if (!this.options.mkcol) {
      this.record('MKCOL', path, 405);
      return new Response('not supported', { status: 405 });
    }
    const dir = path.endsWith('/') ? path : `${path}/`;
    const existed = this.dirs.has(dir);
    this.dirs.add(dir);
    this.record('MKCOL', path, existed ? 405 : 201);
    return new Response(null, { status: existed ? 405 : 201 });
  }

  private handlePropfind(path: string): Response {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const hrefs = [...this.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => `<D:response><D:href>${p.split('/').map(encodeURIComponent).join('/')}</D:href></D:response>`);
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
      `<D:response><D:href>${prefix}</D:href></D:response>${hrefs.join('')}</D:multistatus>`;
    this.record('PROPFIND', path, 207);
    return new Response(xml, { status: 207 });
  }
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
    return undefined;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (body instanceof Uint8Array) return body.slice();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
