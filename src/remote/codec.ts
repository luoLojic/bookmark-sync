/**
 * remote/codec.ts —— 快照与索引的编解码（NFR-5 / 方案 3.2）。
 *
 * 上传前 gzip（约 25KB → 8KB），读取时按魔术字节判断是否压缩、兼容明文。
 * 「兼容明文」不是可选的贴心功能：用户可能手工上传过未压缩的快照，也可能
 * 中途关掉压缩开关，读到什么都必须能解出来。
 *
 * 解析失败一律归入 ProtocolError（Fatal）—— 格式坏了重试没有意义，
 * 必须让用户看到，而不是当成网络抖动反复重试（INV-3 的分类要求）。
 */

import { ProtocolError, FormatVersionTooNew } from '../shared/errors.js';
import { FORMAT_VERSION, type Snapshot } from '../domain/tree.js';
import type { HistoryIndex } from '../shared/types.js';

/** gzip 魔术字节。 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return collect(stream as ReadableStream<Uint8Array>);
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await collect(stream as ReadableStream<Uint8Array>);
  } catch (error) {
    // 截断的 gzip 会在这里失败 —— 弱网下的真实风险（NFR-4）。
    throw new ProtocolError('远端数据不是有效的 gzip 流（可能被截断）', { cause: error });
  }
}

/** 编码为可上传的字节。compress 为 false 时输出明文 JSON。 */
export async function encodeJson(value: unknown, compress: boolean): Promise<Uint8Array> {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  return compress ? gzip(bytes) : bytes;
}

/** 解码：先嗅探魔术字节，再按 UTF-8 解析 JSON。 */
export async function decodeJson(bytes: Uint8Array): Promise<unknown> {
  const plain = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(plain);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProtocolError('远端数据不是有效的 JSON', { cause: error });
  }
}

// ── 快照校验 ──────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 校验并返回快照。
 *
 * formatVersion 高于本扩展支持的版本时抛 FormatVersionTooNew ——
 * 这是 INV-3 里唯一允许重置基线的错误，因此必须在这里准确识别，
 * 不能混进泛化的 ProtocolError。
 */
export function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new ProtocolError('快照不是对象');

  const version = value['formatVersion'];
  if (typeof version !== 'number') throw new ProtocolError('快照缺少 formatVersion');
  if (version > FORMAT_VERSION) throw new FormatVersionTooNew(version);
  if (version < FORMAT_VERSION) throw new ProtocolError(`不支持的 formatVersion ${version}`);

  const roots = value['roots'];
  if (!isRecord(roots)) throw new ProtocolError('快照缺少 roots');
  for (const key of ['bar', 'other']) {
    const root = roots[key];
    if (!isRecord(root) || !Array.isArray(root['children'])) {
      throw new ProtocolError(`快照的 roots.${key} 结构不正确`);
    }
  }

  // 其余字段缺失时补默认值，而不是拒绝整份快照：它们只影响展示与降级校验，
  // 缺一个 writtenBy 不该让用户完全无法同步。
  const snapshot: Snapshot = {
    formatVersion: FORMAT_VERSION,
    version: typeof value['version'] === 'number' ? value['version'] : 0,
    writerNonce: typeof value['writerNonce'] === 'string' ? value['writerNonce'] : '',
    writtenAt: typeof value['writtenAt'] === 'string' ? value['writtenAt'] : '',
    writtenBy: typeof value['writtenBy'] === 'string' ? value['writtenBy'] : '',
    contentHash: typeof value['contentHash'] === 'string' ? value['contentHash'] : '',
    roots: roots as unknown as Snapshot['roots'],
  };
  return snapshot;
}

export async function decodeSnapshot(bytes: Uint8Array): Promise<Snapshot> {
  return parseSnapshot(await decodeJson(bytes));
}

/**
 * 校验历史索引（FR-15）。
 *
 * 索引损坏不影响同步正确性，只影响历史列表展示，因此这里宽容处理：
 * 整体不可解析时返回空索引，让「刷新索引」去重建，而不是让设置页报错。
 */
export function parseHistoryIndex(value: unknown): HistoryIndex {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return { formatVersion: 1, entries: [] };
  const entries = value['entries'].filter(
    (e): e is HistoryIndex['entries'][number] =>
      isRecord(e) && typeof e['file'] === 'string' && typeof e['version'] === 'number',
  );
  return { formatVersion: 1, entries };
}
