/**
 * test/remote/snapshot-validation.test.ts —— 快照校验与写后校验（H-5 / H-6）。
 *
 * H-6：原先 parseSnapshot 只看两层（formatVersion、roots.bar/other.children 是
 * 数组），随后 `roots as unknown as Snapshot['roots']` 一断言了之。后面每一层
 * 代码都按类型定义信任这棵树，于是畸形节点会在很远的地方炸开，炸出来的是
 * TypeError 而不是 ProtocolError —— 而 TypeError 曾被 toAppError 兜底成
 * NetworkError（瞬时），用户看到「网络错误」，重试也没有用。
 *
 * H-5：写后校验比较的是快照**自报**的 contentHash 字段。那个字段是本扩展自己
 * 写进 JSON 的，只要 JSON 能解析出来它就必然等于写入值 —— 这条检查永远通过。
 * NFR-4 要求发现的是「JSON 仍然合法但 roots 内容不对」。
 */

import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../../src/shared/errors.js';
import { computeContentHash } from '../../src/domain/hash.js';
import { contentHasher } from '../../src/platform/crypto.js';
import { decodeSnapshot, encodeJson, parseSnapshot } from '../../src/remote/codec.js';
import { makeSnapshot } from '../../src/domain/tree.js';
import { bk, fd, tree } from '../fixtures/trees.js';

/** 一份合法快照的 JSON 结构，测试按需破坏其中一处。 */
function snapshotJson(barChildren: unknown[]): Record<string, unknown> {
  return {
    formatVersion: 1,
    version: 3,
    writerNonce: 'nonce',
    writtenAt: '2026-07-30T10:00:00.000Z',
    writtenBy: 'device',
    contentHash: 'sha256:0',
    roots: {
      bar: { guid: 'root-bar', type: 'folder', title: '书签栏', children: barChildren },
      other: { guid: 'root-other', type: 'folder', title: '其他书签', children: [] },
    },
  };
}

const okBookmark = { guid: 'b-0000000000a1', type: 'bookmark', title: '甲', url: 'https://a.test/' };
const okFolder = { guid: 'f-0000000000a1', type: 'folder', title: '夹', children: [] };

describe('parseSnapshot 递归校验节点（H-6）', () => {
  it('合法快照照常解析，并保留结构', () => {
    const snap = parseSnapshot(snapshotJson([okFolder, okBookmark]));
    expect(snap.roots.bar.children).toHaveLength(2);
    expect(snap.roots.bar.children[1]).toMatchObject({ guid: 'b-0000000000a1', url: 'https://a.test/' });
  });

  it('★ 文件夹缺 children 抛 ProtocolError，而不是等 tree.ts 读长度时抛 TypeError', () => {
    const bad = { guid: 'f-0000000000a2', type: 'folder', title: '坏夹' };
    expect(() => parseSnapshot(snapshotJson([bad]))).toThrow(ProtocolError);
  });

  it('★ 书签缺 url（或 url 为空串）抛 ProtocolError', () => {
    expect(() => parseSnapshot(snapshotJson([{ guid: 'b-0000000000a3', type: 'bookmark', title: '无址' }]))).toThrow(
      ProtocolError,
    );
    expect(() =>
      parseSnapshot(snapshotJson([{ guid: 'b-0000000000a4', type: 'bookmark', title: '空址', url: '' }])),
    ).toThrow(ProtocolError);
  });

  it('★ 缺 type 的节点被拒，不再被当成书签一路带到 chrome.bookmarks.create', () => {
    expect(() => parseSnapshot(snapshotJson([{ guid: 'b-0000000000a5', title: '无类型' }]))).toThrow(ProtocolError);
    expect(() =>
      parseSnapshot(snapshotJson([{ guid: 'b-0000000000a6', type: 'link', title: '怪类型', url: 'https://x.test/' }])),
    ).toThrow(ProtocolError);
  });

  it('★ 重复的 GUID 被拒 —— 否则 indexRoots 会静默丢掉一整棵子树', () => {
    // indexRoots 用 Map 去重，后出现的覆盖先出现的，没有任何日志。
    expect(() => parseSnapshot(snapshotJson([okBookmark, { ...okBookmark, title: '重复' }]))).toThrow(
      /重复/,
    );
  });

  it('GUID 格式不合法被拒（不是 b-/f- 加 12 位十六进制）', () => {
    for (const guid of ['x-0000000000a1', 'b-00', 'b-0000000000A1', '', 'b-0000000000ag']) {
      expect(() => parseSnapshot(snapshotJson([{ ...okBookmark, guid }])), guid).toThrow(ProtocolError);
    }
  });

  it('title 不是字符串被拒（数字标题会在比较与哈希时行为不定）', () => {
    expect(() => parseSnapshot(snapshotJson([{ ...okBookmark, title: 42 }]))).toThrow(ProtocolError);
  });

  it('嵌套层里的畸形节点也会被发现', () => {
    const nested = {
      guid: 'f-0000000000b1',
      type: 'folder',
      title: '外',
      children: [{ guid: 'f-0000000000b2', type: 'folder', title: '内' }],
    };
    expect(() => parseSnapshot(snapshotJson([nested]))).toThrow(ProtocolError);
  });

  it('逻辑根的 GUID 取本地常量，不接受远端改写（需求 6.5）', () => {
    const json = snapshotJson([]);
    (json['roots'] as Record<string, Record<string, unknown>>)['bar']!['guid'] = 'f-0000000000ff';
    expect(parseSnapshot(json).roots.bar.guid).toBe('root-bar');
  });

  it('节点上多余的字段不会进入内存树', () => {
    const snap = parseSnapshot(snapshotJson([{ ...okBookmark, dateAdded: 123, extra: 'x' }]));
    expect(Object.keys(snap.roots.bar.children[0]!).sort()).toEqual(['guid', 'title', 'type', 'url']);
  });

  it('roots 缺一棵逻辑根被拒', () => {
    const json = snapshotJson([]);
    delete (json['roots'] as Record<string, unknown>)['other'];
    expect(() => parseSnapshot(json)).toThrow(ProtocolError);
  });
});

describe('内容哈希必须重算（H-5）', () => {
  it('roots 被改过但 contentHash 字段没跟着改时，重算的哈希对不上', async () => {
    const roots = tree([bk('b-0000000000c1', '甲', 'https://a.test/'), fd('f-0000000000c1', '夹')]);
    const snap = makeSnapshot(roots, {
      version: 1,
      contentHash: computeContentHash(roots, contentHasher),
      writerNonce: 'n',
      writtenAt: '2026-07-30T10:00:00.000Z',
      writtenBy: 'dev',
    });

    // 模拟「文件被手工编辑 / 代理改写」：JSON 仍然合法，contentHash 字段没动。
    const tampered = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    const bar = (tampered['roots'] as Record<string, Record<string, unknown>>)['bar']!;
    (bar['children'] as Record<string, unknown>[])[0]!['title'] = '被改过';

    const readBack = await decodeSnapshot(await encodeJson(tampered, true));
    // 自报字段与原来一致 —— 这就是原实现唯一比较的东西，它发现不了任何问题。
    expect(readBack.contentHash).toBe(snap.contentHash);
    // 重算之后才对不上。
    expect(computeContentHash(readBack.roots, contentHasher)).not.toBe(snap.contentHash);
  });

  it('未被改动的快照重算哈希仍然一致（避免误报）', async () => {
    const roots = tree([bk('b-0000000000c2', '乙', 'https://b.test/')]);
    const hash = computeContentHash(roots, contentHasher);
    const snap = makeSnapshot(roots, {
      version: 2,
      contentHash: hash,
      writerNonce: 'n',
      writtenAt: '2026-07-30T10:00:00.000Z',
      writtenBy: 'dev',
    });
    const readBack = await decodeSnapshot(await encodeJson(snap, true));
    expect(computeContentHash(readBack.roots, contentHasher)).toBe(hash);
  });
});
