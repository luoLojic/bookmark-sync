import { describe, expect, it } from 'vitest';
import { canonicalize, computeContentHash } from '../../src/domain/hash.js';
import { emptyRoots, makeBookmark, makeFolder, type Roots } from '../../src/domain/tree.js';
import { contentHasher, randomHex, randomSource, sha256Hex } from '../../src/platform/crypto.js';

/** WebCrypto 的权威实现，用于交叉校验同步版 SHA-256。 */
async function webcryptoSha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256Hex', () => {
  it('matches the published NIST test vectors', () => {
    // 空串与 "abc" 是 FIPS 180-4 的标准向量。
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches WebCrypto across lengths that straddle the 64-byte block boundary', async () => {
    // 55/56/57 与 63/64/65 是填充逻辑的边界：一个块尾放不下 8 字节长度字段时需要追加一整块。
    const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200];
    for (const n of lengths) {
      const text = 'a'.repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(await webcryptoSha256Hex(text));
    }
  });

  it('matches WebCrypto on multi-byte UTF-8 content', async () => {
    // 书签标题以中文为主，且可能含 emoji（代理对）。
    for (const text of ['书签栏', '技术/前端', 'café', '🔖📁', '中文 mixed with ascii']) {
      expect(sha256Hex(text), text).toBe(await webcryptoSha256Hex(text));
    }
  });

  it('matches WebCrypto on a realistic 100KB payload', async () => {
    // 设计指标下快照约 100KB（需求第 3 节）。
    const text = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ guid: `b-${i}`, title: `条目 ${i}` })));
    expect(text.length).toBeGreaterThan(50_000);
    expect(sha256Hex(text)).toBe(await webcryptoSha256Hex(text));
  });

  it('avalanches on a single-character change', () => {
    const a = sha256Hex('https://example.test/a');
    const b = sha256Hex('https://example.test/b');
    expect(a).not.toBe(b);
    // 至少一半的十六进制位不同，确认不是截断或弱混淆。
    const differing = [...a].filter((ch, i) => ch !== b[i]).length;
    expect(differing).toBeGreaterThan(a.length / 2);
  });

  it('always returns 64 lowercase hex digits', () => {
    for (const text of ['', 'a', '书签', 'x'.repeat(1000)]) {
      expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('contentHasher', () => {
  function sample(): Roots {
    const roots = emptyRoots();
    roots.bar.children = [
      makeBookmark('b-000000000001', 'MDN', 'https://developer.mozilla.org/'),
      makeFolder('f-000000000001', '技术', [makeBookmark('b-000000000002', 'TS', 'https://www.typescriptlang.org/')]),
    ];
    return roots;
  }

  it('prefixes the algorithm name (需求 5.2)', () => {
    expect(contentHasher(canonicalize(sample()))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces the documented hash format when wired into the domain layer', () => {
    const hash = computeContentHash(sample(), contentHasher);
    expect(hash).toBe(`sha256:${sha256Hex(canonicalize(sample()))}`);
  });

  it('agrees on trees built by different key insertion orders', () => {
    // 跨平台一致性（方案 3.2）：同一棵树的哈希不依赖对象字面量的书写顺序。
    const a = sample();
    const b = emptyRoots();
    b.bar.children = [
      { url: 'https://developer.mozilla.org/', title: 'MDN', type: 'bookmark', guid: 'b-000000000001' },
      {
        children: [{ title: 'TS', url: 'https://www.typescriptlang.org/', guid: 'b-000000000002', type: 'bookmark' }],
        title: '技术',
        guid: 'f-000000000001',
        type: 'folder',
      },
    ];
    expect(computeContentHash(b, contentHasher)).toBe(computeContentHash(a, contentHasher));
  });
});

describe('randomHex / randomSource', () => {
  it('returns the requested number of hex digits', () => {
    for (const bytes of [1, 2, 8, 16]) {
      expect(randomHex(bytes)).toMatch(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
    }
  });

  it('does not repeat across many draws', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => randomHex(16)));
    expect(seen.size).toBe(2000);
  });

  it('exposes a [0,1) source suitable for injection into domain/guid', () => {
    const random = randomSource();
    for (let i = 0; i < 1000; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
