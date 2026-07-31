/**
 * remote/store.ts —— 远端存储抽象与能力探测（方案 5.1）。
 *
 * WebDAV 与 S3 都实现同一个 RemoteStore，engine 因此完全不知道底下是什么。
 * 接口刻意做得很小：一次同步只需要「读一个文件、写一个文件、删一个文件」，
 * 目录列举只在「刷新索引」时用到（FR-15 明确要求正常路径不依赖 PROPFIND）。
 */

import { AuthError, ConflictError, NotFoundError, ServerError, VerificationError } from '../shared/errors.js';
import type { HttpResponse } from '../platform/http.js';
import type { RemoteCaps } from '../shared/types.js';

export interface GetResult {
  bytes: Uint8Array;
  /** 条件写用的版本标识。服务器不给就是 undefined（走降级模式）。 */
  etag?: string;
}

export interface PutResult {
  etag?: string;
}

export interface PutOptions {
  /** 条件写（FR-17）。'*' 表示「要求该文件当前不存在」。 */
  ifMatch?: string;
  /** 内容类型，默认 application/json。 */
  contentType?: string;
}

export interface RemoteStore {
  /** 读一个文件。404 → null（不是错误：首次同步时远端本来就没有）。 */
  get(path: string): Promise<GetResult | null>;
  /** 写一个文件。带 ifMatch 且服务器返回 412 时抛 ConflictError。 */
  put(path: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  remove(path: string): Promise<void>;
  /** 列举前缀下的文件名。仅「刷新索引」使用，可能较慢。 */
  list(prefix: string): Promise<string[]>;
  /** 确保目录存在。对象存储是空操作。 */
  ensureContainer(): Promise<void>;
}

/**
 * 把 HTTP 状态映射为错误分类（方案第 6 节）。
 *
 * 分类不是装饰：TransientError 会被重试且绝不清状态，FatalError 直接报给
 * 用户。把 401 当成瞬时错误会让用户看到「一直在重试」而不是「密码错了」。
 */
export function assertOk(res: HttpResponse, context: { method: string; path: string }): HttpResponse {
  if (res.status >= 200 && res.status < 300) return res;
  if (res.status === 401 || res.status === 403) throw new AuthError(res.status);
  if (res.status === 404 || res.status === 410) throw new NotFoundError(context.path);
  if (res.status === 412) throw new ConflictError(`${context.method} ${context.path} 的条件写未通过`);
  if (res.status >= 500) throw new ServerError(res.status, `HTTP ${res.status} ${context.method} ${context.path}`);
  throw new ServerError(res.status, `HTTP ${res.status} ${context.method} ${context.path}`);
}

// ── 能力探测（方案 5.1 / FR-18） ──────────────────────────────────────

/** 故意用一个不可能匹配的 ETag，用来试探服务器是否真的执行条件写。 */
const IMPOSSIBLE_ETAG = '"bookmark-sync-probe-nonexistent-etag"';

/**
 * 缓存的能力记录还能不能用（审计 H-1）。
 *
 * 两个条件：后缀要与当前压缩开关一致，且 probedAt 必须非空。
 *
 * 后者不是多余的防御。早先的版本作废缓存的做法是写一条
 * `{ ifMatch: false, suffix, probedAt: '' }` 的占位记录，而判定只看 suffix ——
 * 于是那条「作废」记录被当成有效缓存，条件写永久停在 FR-18 的降级模式（失去
 * 唯一的原子提交保护），且 ensureContainer 唯一的调用点在 probeStore 里，
 * 探测不再发生就意味着换到新的 WebDAV 目录后 MKCOL 不执行，PUT 一直 409。
 * 作废现在走 clearCaps() 直接删键；这里继续认得哨兵，好让已经写进 storage
 * 的那条记录自愈。
 */
export function isCapsUsable(cached: RemoteCaps | undefined, compress: boolean): cached is RemoteCaps {
  if (cached === undefined) return false;
  if (cached.probedAt === '') return false;
  return cached.suffix === (compress ? '.json.gz' : '.json');
}

export interface ProbeDeps {
  /** 探测文件的路径，默认 `.probe`。 */
  path?: string;
  /** 注入时间，便于测试与保持可重放。 */
  now: () => Date;
  /** 上传时是否压缩，决定 caps.suffix。 */
  compress: boolean;
}

/**
 * 一次往返同时验证三件事（对应需求 13 的两条风险）：
 *   1. 能写、能读、且读回的内容与写入一致 —— 顺带验证了「同名覆盖」行为；
 *   2. 服务器是否支持 If-Match 条件写（FR-17 / FR-18）；
 *   3. 能删。
 *
 * 用一个独立的 .probe 文件而不是 bookmarks.json：探测会故意写坏数据、
 * 故意触发 412，绝不能拿真实快照做实验。
 */
export async function probeStore(store: RemoteStore, deps: ProbeDeps): Promise<RemoteCaps> {
  const path = deps.path ?? '.probe';
  const payload = new TextEncoder().encode(`bookmark-sync probe ${deps.now().toISOString()}`);

  await store.ensureContainer();

  const first = await store.put(path, payload, { contentType: 'text/plain' });

  const readBack = await store.get(path);
  if (readBack === null) {
    throw new VerificationError('探测文件写入后读不到，远端可能不支持覆盖写或有缓存');
  }
  if (!sameBytes(readBack.bytes, payload)) {
    throw new VerificationError('探测文件读回的内容与写入不一致');
  }

  const ifMatch = await detectIfMatch(store, path, payload, readBack.etag ?? first.etag);

  // 清理。删不掉不影响同步，留一个小文件而已。
  try {
    await store.remove(path);
  } catch {
    // 故意忽略。
  }

  return {
    ifMatch,
    suffix: deps.compress ? '.json.gz' : '.json',
    probedAt: deps.now().toISOString(),
  };
}

/**
 * 判断服务器是否真的执行 If-Match。
 *
 * 关键是「用错的 ETag 必须被拒」，而不是「用对的 ETag 能通过」——
 * 完全忽略 If-Match 的服务器对两者都会返回 2xx，只测后者查不出问题。
 */
async function detectIfMatch(
  store: RemoteStore,
  path: string,
  payload: Uint8Array,
  etag: string | undefined,
): Promise<boolean> {
  // 服务器连 ETag 都不给，条件写无从谈起。
  if (etag === undefined || etag === '') return false;

  try {
    await store.put(path, payload, { ifMatch: IMPOSSIBLE_ETAG, contentType: 'text/plain' });
    // 用错的 ETag 也写成功了 —— 服务器忽略了 If-Match，只能降级（FR-18）。
    return false;
  } catch (error) {
    if (error instanceof ConflictError) return true;
    // 其他错误（网络、认证）不该被解读成「支持条件写」。
    throw error;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
