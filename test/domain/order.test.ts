import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeOrder } from '../../src/domain/order.js';

/**
 * 需求 6.3 的三条规则：
 *   1. 以本地的顺序为骨架；
 *   2. 远端独有的新条目，插入到它在远端顺序中的前驱条目之后；找不到前驱则追加到末尾；
 *   3. 两侧都删除的条目直接移除。
 *
 * 顺序不做独立的冲突消解 —— 这是用户已确认接受的取舍（需求 6.3 代价一段）。
 */
describe('mergeOrder', () => {
  it('uses local order as the skeleton', () => {
    expect(
      mergeOrder({ survivors: ['a', 'b', 'c'], local: ['c', 'a', 'b'], remote: ['a', 'b', 'c'] }),
    ).toEqual(['c', 'a', 'b']);
  });

  it('drops entries that did not survive the merge', () => {
    expect(
      mergeOrder({ survivors: ['a', 'c'], local: ['a', 'b', 'c'], remote: ['a', 'b', 'c'] }),
    ).toEqual(['a', 'c']);
  });

  it('inserts a remote-only entry after its remote predecessor', () => {
    // 远端在 a 之后新增了 x；本地骨架是 a,b。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], local: ['a', 'b'], remote: ['a', 'x', 'b'] }),
    ).toEqual(['a', 'x', 'b']);
  });

  it('keeps consecutive remote-only entries in their remote order', () => {
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x', 'y'], local: ['a', 'b'], remote: ['a', 'x', 'y', 'b'] }),
    ).toEqual(['a', 'x', 'y', 'b']);
  });

  it('appends a remote-only entry that has no predecessor in remote', () => {
    // 需求 6.3 规则 2 的字面要求：找不到前驱则追加到末尾。
    // 代价：远端在文件夹头部新增的条目会落到末尾，而不是头部。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], local: ['a', 'b'], remote: ['x', 'a', 'b'] }),
    ).toEqual(['a', 'b', 'x']);
  });

  it('falls back to the nearest surviving predecessor when the immediate one is gone', () => {
    // 远端顺序 a,gone,x：x 的直接前驱 gone 未存活，退到更前的 a 之后。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], local: ['a', 'b'], remote: ['a', 'gone', 'x', 'b'] }),
    ).toEqual(['a', 'x', 'b']);
  });

  it('appends when every remote predecessor was dropped', () => {
    expect(
      mergeOrder({ survivors: ['a', 'x'], local: ['a'], remote: ['gone1', 'gone2', 'x', 'a'] }),
    ).toEqual(['a', 'x']);
  });

  it('appends survivors present in neither side', () => {
    // 复活的祖先文件夹（方案 2.4 resurrectAncestors）可能只存在于 base。
    expect(
      mergeOrder({ survivors: ['a', 'resurrected'], local: ['a'], remote: ['a'] }),
    ).toEqual(['a', 'resurrected']);
  });

  it('returns exactly the survivor set — no duplicates, no extras', () => {
    const out = mergeOrder({
      survivors: ['a', 'b', 'x'],
      local: ['a', 'b', 'dropped'],
      remote: ['a', 'x', 'b', 'alsoDropped'],
    });
    expect([...out].sort()).toEqual(['a', 'b', 'x']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('lets local win when both sides reordered the same folder', () => {
    // 需求 6.3 明确的取舍：以先同步者（此处为本地）的顺序为准。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'c'], local: ['b', 'c', 'a'], remote: ['c', 'b', 'a'] }),
    ).toEqual(['b', 'c', 'a']);
  });

  it('is idempotent when both sides already agree', () => {
    const same = ['a', 'b', 'c'];
    expect(mergeOrder({ survivors: same, local: same, remote: same })).toEqual(same);
  });

  it('handles empty folders and empty survivor sets', () => {
    expect(mergeOrder({ survivors: [], local: [], remote: [] })).toEqual([]);
    expect(mergeOrder({ survivors: [], local: ['a'], remote: ['b'] })).toEqual([]);
    expect(mergeOrder({ survivors: ['a'], local: [], remote: [] })).toEqual(['a']);
  });

  it('accepts a Set as the survivor collection', () => {
    expect(
      mergeOrder({ survivors: new Set(['a', 'x']), local: ['a'], remote: ['a', 'x'] }),
    ).toEqual(['a', 'x']);
  });

  it('ignores duplicate guids in the input orders', () => {
    // 防御性：上游索引理论上不会给出重复 GUID，但重复不应导致结果出现两份。
    expect(
      mergeOrder({ survivors: ['a', 'b'], local: ['a', 'a', 'b'], remote: ['a', 'b', 'b'] }),
    ).toEqual(['a', 'b']);
  });
});

/**
 * 属性测试（方案 7.2）。
 *
 * 「结果恰为 survivors 的一个排列」是 plan.ts 的前置条件 —— reorder 操作会把
 * 这个数组直接交给浏览器 API。若它漏项、重项或含未存活项，将直接表现为书签
 * 丢失或重复，所以这条不能只靠举例覆盖。
 */
describe('mergeOrder properties', () => {
  /** 从候选池中抽取一个无重复的 GUID 序列。 */
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const orderArb = fc.uniqueArray(fc.constantFrom(...pool), { maxLength: pool.length });

  const inputArb = fc
    .record({
      local: orderArb,
      remote: orderArb,
      survivorSeed: fc.uniqueArray(fc.constantFrom(...pool), { maxLength: pool.length }),
    })
    .map(({ local, remote, survivorSeed }) => ({ local, remote, survivors: survivorSeed }));

  it('always returns a permutation of the survivor set', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = mergeOrder(input);
        expect([...out].sort()).toEqual([...new Set(input.survivors)].sort());
        expect(new Set(out).size).toBe(out.length);
      }),
    );
  });

  it('preserves the relative order of every surviving local pair', () => {
    // 规则 1：本地顺序是骨架，远端插入不得打乱本地两项的先后。
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = mergeOrder(input);
        const localSurviving = input.local.filter((g) => input.survivors.includes(g));
        const projected = out.filter((g) => localSurviving.includes(g));
        expect(projected).toEqual(localSurviving);
      }),
    );
  });

  it('is idempotent — feeding the result back changes nothing', () => {
    // 幂等是 INV-4 收敛的基础（方案 2.3）：重跑同步不应产生新的顺序调整。
    fc.assert(
      fc.property(inputArb, (input) => {
        const once = mergeOrder(input);
        const twice = mergeOrder({ survivors: once, local: once, remote: once });
        expect(twice).toEqual(once);
      }),
    );
  });

  it('equals the shared order when both sides agree', () => {
    // merge(b, x, x) = x 的顺序侧对应物（方案 7.2 第 2 条）。
    fc.assert(
      fc.property(orderArb, (order) => {
        expect(mergeOrder({ survivors: order, local: order, remote: order })).toEqual(order);
      }),
    );
  });
});
