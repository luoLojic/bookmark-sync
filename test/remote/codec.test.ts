import { describe, expect, it } from 'vitest';
import {
  decodeJson,
  decodeSnapshot,
  encodeJson,
  gunzip,
  gzip,
  isGzip,
  parseHistoryIndex,
  parseSnapshot,
} from '../../src/remote/codec.js';
import { FormatVersionTooNew, ProtocolError } from '../../src/shared/errors.js';
import { emptyRoots, makeSnapshot } from '../../src/domain/tree.js';

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function sampleSnapshot() {
  return makeSnapshot(emptyRoots(), {
    version: 7,
    writerNonce: 'nonce-1',
    writtenAt: '2026-07-30T10:00:00.000Z',
    writtenBy: '我的台式机',
    contentHash: 'sha256:abc',
  });
}

describe('gzip / gunzip（NFR-5）', () => {
  it('往返还原原始字节', async () => {
    const original = utf8.encode('书签同步器'.repeat(200));
    expect(text(await gunzip(await gzip(original)))).toBe(text(original));
  });

  it('压缩后带 gzip 魔术字节', async () => {
    const packed = await gzip(utf8.encode('hello'));
    expect(isGzip(packed)).toBe(true);
    expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
  });

  it('对真实量级的快照有明显压缩效果', async () => {
    // 需求第 3 节：约 25KB → 8KB。这里只断言「显著小于原文」。
    const payload = JSON.stringify(
      Array.from({ length: 900 }, (_, i) => ({
        guid: `b-${String(i).padStart(12, '0')}`,
        type: 'bookmark',
        title: `书签 ${i}`,
        url: `https://example${i}.test/path/${i}`,
      })),
    );
    const raw = utf8.encode(payload);
    const packed = await gzip(raw);
    expect(packed.length).toBeLessThan(raw.length * 0.35);
  });

  it('明文不被误判为 gzip', () => {
    expect(isGzip(utf8.encode('{"a":1}'))).toBe(false);
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
    expect(isGzip(new Uint8Array())).toBe(false);
  });

  it('截断的 gzip 抛 ProtocolError 而不是静默返回残缺数据', async () => {
    // 弱网下响应体被截断是真实风险（NFR-4）。
    const packed = await gzip(utf8.encode('x'.repeat(5000)));
    await expect(gunzip(packed.slice(0, Math.floor(packed.length / 2)))).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('encodeJson / decodeJson', () => {
  it('压缩开启时输出 gzip，关闭时输出明文', async () => {
    const packed = await encodeJson({ a: 1 }, true);
    const plain = await encodeJson({ a: 1 }, false);
    expect(isGzip(packed)).toBe(true);
    expect(isGzip(plain)).toBe(false);
    expect(text(plain)).toBe('{"a":1}');
  });

  it('两种编码都能被同一个解码函数读出（兼容明文）', async () => {
    // 用户可能手工上传过未压缩快照，或中途关掉了压缩开关。
    const value = { list: [1, 2, 3], 名称: '书签' };
    expect(await decodeJson(await encodeJson(value, true))).toEqual(value);
    expect(await decodeJson(await encodeJson(value, false))).toEqual(value);
  });

  it('非 JSON 内容抛 ProtocolError', async () => {
    await expect(decodeJson(utf8.encode('<html>登录页</html>'))).rejects.toBeInstanceOf(ProtocolError);
  });

  it('多字节字符往返正确', async () => {
    const value = { t: '书签栏 / 技术 / café / 🔖' };
    expect(await decodeJson(await encodeJson(value, true))).toEqual(value);
  });
});

describe('parseSnapshot', () => {
  it('接受合法快照并保留字段', () => {
    const snap = parseSnapshot(JSON.parse(JSON.stringify(sampleSnapshot())));
    expect(snap).toMatchObject({ version: 7, writerNonce: 'nonce-1', contentHash: 'sha256:abc' });
  });

  it('formatVersion 更高时抛 FormatVersionTooNew（INV-3 唯一允许重置基线的错误）', () => {
    const future = { ...sampleSnapshot(), formatVersion: 2 };
    expect(() => parseSnapshot(future)).toThrow(FormatVersionTooNew);
  });

  it('formatVersion 更低时抛 ProtocolError，而不是当作可升级', () => {
    expect(() => parseSnapshot({ ...sampleSnapshot(), formatVersion: 0 })).toThrow(ProtocolError);
  });

  it('缺 formatVersion / roots / 根结构不对时抛 ProtocolError', () => {
    expect(() => parseSnapshot(null)).toThrow(ProtocolError);
    expect(() => parseSnapshot({})).toThrow(ProtocolError);
    expect(() => parseSnapshot({ formatVersion: 1 })).toThrow(ProtocolError);
    expect(() => parseSnapshot({ formatVersion: 1, roots: {} })).toThrow(ProtocolError);
    expect(() => parseSnapshot({ formatVersion: 1, roots: { bar: {}, other: {} } })).toThrow(ProtocolError);
  });

  it('信封字段缺失时补默认值，不因此拒绝整份快照', () => {
    // writtenBy 只用于历史展示，缺它不该让用户完全无法同步。
    const snap = parseSnapshot({ formatVersion: 1, roots: emptyRoots() });
    expect(snap).toMatchObject({ version: 0, writerNonce: '', writtenBy: '', contentHash: '' });
  });

  it('decodeSnapshot 串起解压与校验', async () => {
    const bytes = await encodeJson(sampleSnapshot(), true);
    expect((await decodeSnapshot(bytes)).version).toBe(7);
  });
});

describe('parseHistoryIndex（FR-15）', () => {
  it('接受合法索引', () => {
    const index = parseHistoryIndex({
      formatVersion: 1,
      entries: [
        { version: 1, writtenAt: 'a', writtenBy: 'b', bookmarks: 1, folders: 2, file: 'history/v000001-x.json.gz' },
      ],
    });
    expect(index.entries).toHaveLength(1);
  });

  it('整体损坏时返回空索引，交给「刷新索引」重建', () => {
    // 索引不影响同步正确性，只影响历史列表；报错会让设置页整块不可用。
    expect(parseHistoryIndex(null)).toEqual({ formatVersion: 1, entries: [] });
    expect(parseHistoryIndex({ entries: 'nope' })).toEqual({ formatVersion: 1, entries: [] });
  });

  it('丢弃结构不对的单条，保留其余', () => {
    const good = 'history/v000001-2026-07-30T10-00-00-000Z.json.gz';
    const index = parseHistoryIndex({
      entries: [
        { version: 1, file: good },
        { version: 'x', file: 'history/v000002-2026-07-30T10-00-00-000Z.json' },
        { file: 'history/v000003-2026-07-30T10-00-00-000Z.json' },
        null,
      ],
    });
    expect(index.entries.map((e) => e.file)).toEqual([good]);
  });

  it('★ file 不是合法历史路径的条目一并丢弃（BUG-13）', () => {
    // 索引是远端内容，file 会被直接交给 store.get，而 joinUrl 不过滤 `..`。
    // 不合形状的条目在解析时就该消失，设置页连列都不会列。
    const index = parseHistoryIndex({
      entries: [
        { version: 1, file: '../../../etc/passwd' },
        { version: 2, file: 'history/../bookmarks.json' },
        { version: 3, file: 'history/sub/dir/v000003-x.json' },
        { version: 4, file: '/absolute/path.json' },
        { version: 5, file: 'bookmarks.json' },
        { version: 6, file: 'history/v000006-2026-07-30T10-00-00-000Z.json' },
      ],
    });
    expect(index.entries.map((e) => e.version)).toEqual([6]);
  });
});
