import { describe, expect, it } from 'vitest';
import { ROOT_GUID } from '../../src/domain/tree.js';
import { GUID_RE, guidType, isValidGuid, makeGuidFactory, newGuid } from '../../src/domain/guid.js';

/** 确定性随机源：domain 必须保持纯函数，随机数由调用方注入（红线一）。 */
function seqRandom(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('guid', () => {
  it('formats bookmark and folder guids with a type prefix and 12 hex digits', () => {
    const rnd = seqRandom(0);
    expect(newGuid('bookmark', rnd)).toBe('b-000000000000');
    expect(newGuid('folder', rnd)).toBe('f-000000000000');
  });

  it('renders the maximum byte value without truncation', () => {
    const rnd = seqRandom(0xff / 0x100 + 0.999 / 0x100);
    expect(newGuid('bookmark', rnd)).toBe('b-ffffffffffff');
  });

  it('accepts its own output and the two logical root guids', () => {
    const factory = makeGuidFactory(seqRandom(0.5));
    for (const guid of [factory('bookmark'), factory('folder'), ROOT_GUID.bar, ROOT_GUID.other]) {
      expect(isValidGuid(guid)).toBe(true);
    }
  });

  it('rejects malformed guids', () => {
    const bad = [
      '',
      'b-',
      'b-00000000000', // 11 位
      'b-0000000000000', // 13 位
      'b-00000000000G', // 非十六进制
      'x-000000000000', // 未知前缀
      'B-000000000000', // 大写前缀
      'b-00000000000A', // 大写十六进制
      'root-mobile', // 移动书签不同步（需求 6.5）
      ' b-000000000000',
    ];
    for (const guid of bad) expect(isValidGuid(guid), guid).toBe(false);
  });

  it('reports the node type a guid denotes', () => {
    expect(guidType('b-0123456789ab')).toBe('bookmark');
    expect(guidType('f-0123456789ab')).toBe('folder');
    // 逻辑根是文件夹容器（需求 6.5）。
    expect(guidType(ROOT_GUID.bar)).toBe('folder');
    expect(guidType(ROOT_GUID.other)).toBe('folder');
    expect(guidType('nonsense')).toBeNull();
  });

  it('generates distinct guids across many draws', () => {
    // 用真实随机源做碰撞抽样：48 位空间下 5000 次抽取不应重复。
    // 随机源必须显式注入 —— domain 不提供默认值（红线一）。
    const factory = makeGuidFactory(Math.random);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(factory('bookmark'));
    expect(seen.size).toBe(5000);
  });

  it('exposes a regex anchored at both ends', () => {
    expect(GUID_RE.test('b-0123456789ab')).toBe(true);
    expect(GUID_RE.test('prefix b-0123456789ab suffix')).toBe(false);
  });
});
