import { describe, expect, it } from 'vitest';
import { canonicalize, computeContentHash, hashesEqual } from '../../src/domain/hash.js';
import { ROOT_GUID, emptyRoots, makeBookmark, makeFolder, type Roots } from '../../src/domain/tree.js';

/**
 * 注入式哈希：domain 保持纯函数，哈希实现由调用方提供（红线一 / 方案 3.2）。
 * 断言的是「喂给哈希函数的字节」而不是 SHA-256 本身，所以这里用一个廉价的
 * FNV-1a。不能用字符串长度充当假哈希 —— 节点在两棵根之间移动时总长度不变，
 * 长度函数会漏掉这种差异，那是假哈希的缺陷而非规范化的缺陷。
 */
function fakeHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fake:${h.toString(16).padStart(8, '0')}`;
}

/** 记录最后一次实际参与哈希的规范化文本。 */
function capturing(): { hash: (t: string) => string; last: () => string } {
  let last = '';
  return {
    hash: (t) => {
      last = t;
      return fakeHash(t);
    },
    last: () => last,
  };
}

function sample(): Roots {
  const roots = emptyRoots();
  roots.bar.children = [
    makeBookmark('b-000000000001', 'MDN', 'https://developer.mozilla.org/'),
    makeFolder('f-000000000001', '技术', [makeBookmark('b-000000000002', 'TS', 'https://www.typescriptlang.org/')]),
  ];
  roots.other.children = [makeFolder('f-000000000002', '稍后读')];
  return roots;
}

describe('canonicalize', () => {
  it('emits keys in fixed order with no whitespace', () => {
    const roots = emptyRoots();
    roots.bar.children = [makeBookmark('b-000000000001', 'T', 'https://a.test/')];
    const text = canonicalize(roots);
    expect(text).not.toMatch(/\s(?![^"]*"[^"]*$)/);
    // 方案 3.2：键顺序固定为 guid, type, title, url, children
    expect(text.indexOf('"guid"')).toBeLessThan(text.indexOf('"type"'));
    expect(text.indexOf('"type"')).toBeLessThan(text.indexOf('"title"'));
    expect(text.indexOf('"title"')).toBeLessThan(text.indexOf('"url"'));
  });

  it('is insensitive to object key insertion order', () => {
    // 同一棵树，节点字面量的键顺序不同，规范化结果必须一致。
    const a: Roots = {
      bar: { guid: ROOT_GUID.bar, type: 'folder', title: '栏', children: [] },
      other: { guid: ROOT_GUID.other, type: 'folder', title: '其他', children: [] },
    };
    const b: Roots = {
      other: { children: [], title: '其他', type: 'folder', guid: ROOT_GUID.other },
      bar: { title: '栏', children: [], guid: ROOT_GUID.bar, type: 'folder' },
    } as Roots;
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('always serializes bar before other', () => {
    const text = canonicalize(emptyRoots());
    expect(text.indexOf('"bar"')).toBeLessThan(text.indexOf('"other"'));
  });

  it('preserves children order — sibling order is content (需求 6.3)', () => {
    const one = emptyRoots();
    one.bar.children = [
      makeBookmark('b-000000000001', 'A', 'https://a.test/'),
      makeBookmark('b-000000000002', 'B', 'https://b.test/'),
    ];
    const two = emptyRoots();
    two.bar.children = [...one.bar.children].reverse();
    expect(canonicalize(one)).not.toBe(canonicalize(two));
  });

  it('applies NFC normalization to titles and urls', () => {
    // "é" 的合成形式与分解形式在 NFC 下等价（方案 3.2）。
    const composed = emptyRoots();
    composed.bar.children = [makeBookmark('b-000000000001', 'café', 'https://a.test/café')];
    const decomposed = emptyRoots();
    decomposed.bar.children = [makeBookmark('b-000000000001', 'café', 'https://a.test/café')];
    expect(canonicalize(composed)).toBe(canonicalize(decomposed));
  });

  it('omits url for folders and always includes children', () => {
    const roots = emptyRoots();
    roots.bar.children = [makeFolder('f-000000000001', '空目录')];
    const text = canonicalize(roots);
    expect(text).toContain('"children":[]');
    // 文件夹没有 url 字段。
    const folderPart = text.slice(text.indexOf('f-000000000001'));
    expect(folderPart.slice(0, folderPart.indexOf('}'))).not.toContain('"url"');
  });

  it('escapes characters that could otherwise forge structure', () => {
    const roots = emptyRoots();
    roots.bar.children = [makeBookmark('b-000000000001', '"},{"guid":"spoof', 'https://a.test/')];
    const text = canonicalize(roots);
    expect(text).not.toContain('"guid":"spoof"');
    expect(JSON.parse(text)).toBeTypeOf('object');
  });
});

describe('computeContentHash', () => {
  it('hashes only the canonical roots, never the snapshot envelope', () => {
    const cap = capturing();
    computeContentHash(sample(), cap.hash);
    const text = cap.last();
    // 信封字段（version / writtenAt / writtenBy / writerNonce）不得参与（需求 5.2）。
    for (const field of ['version', 'writtenAt', 'writtenBy', 'writerNonce', 'contentHash', 'formatVersion']) {
      expect(text, field).not.toContain(`"${field}"`);
    }
    expect(text).toContain('"roots"');
  });

  it('is stable across repeated calls on equal trees', () => {
    expect(computeContentHash(sample(), fakeHash)).toBe(computeContentHash(sample(), fakeHash));
  });

  it('changes when any synced field changes', () => {
    const base = computeContentHash(sample(), fakeHash);
    const titleChanged = sample();
    titleChanged.bar.children[0]!.title = 'MDN Web Docs';
    const urlChanged = sample();
    (urlChanged.bar.children[0] as { url: string }).url = 'https://developer.mozilla.org/zh-CN/';
    const moved = sample();
    moved.other.children.push(moved.bar.children.pop()!);

    expect(computeContentHash(titleChanged, fakeHash)).not.toBe(base);
    expect(computeContentHash(urlChanged, fakeHash)).not.toBe(base);
    expect(computeContentHash(moved, fakeHash)).not.toBe(base);
  });

  it('distinguishes an empty tree from a populated one', () => {
    expect(computeContentHash(emptyRoots(), fakeHash)).not.toBe(computeContentHash(sample(), fakeHash));
  });

  it('ignores the logical root titles — they are device-local labels', () => {
    // 「书签栏」在英文界面下叫 Bookmarks bar；不能因此判定内容变化（需求 5.2 只同步两棵树的内容）。
    const zh = sample();
    const en = sample();
    en.bar.title = 'Bookmarks bar';
    en.other.title = 'Other bookmarks';
    expect(computeContentHash(en, fakeHash)).toBe(computeContentHash(zh, fakeHash));
  });
});

describe('hashesEqual', () => {
  it('treats missing hashes as unequal', () => {
    // 空 contentHash 出现在空基线上（tree.emptySnapshot），不能与任何真实哈希相等。
    expect(hashesEqual('', '')).toBe(false);
    expect(hashesEqual('sha256:a', '')).toBe(false);
    expect(hashesEqual(undefined, 'sha256:a')).toBe(false);
  });

  it('compares non-empty hashes exactly', () => {
    expect(hashesEqual('sha256:a', 'sha256:a')).toBe(true);
    expect(hashesEqual('sha256:a', 'sha256:b')).toBe(false);
  });
});
