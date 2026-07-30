import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeOrder } from '../../src/domain/order.js';

/**
 * 需求 6.3 的三条规则（规则 1 按 order.ts 头部说明修正为三方判定）：
 *   1. 以改动过顺序的那一侧为骨架；两侧都改过时以本地为准；
 *   2. 另一侧独有的新条目，插入到它在该侧顺序中的前驱之后；找不到前驱则追加末尾；
 *   3. 两侧都删除的条目直接移除。
 */
describe('mergeOrder — 骨架的选择（规则 1）', () => {
  it('本地改过顺序 → 以本地为骨架', () => {
    expect(
      mergeOrder({ survivors: ['a', 'b', 'c'], base: ['a', 'b', 'c'], local: ['c', 'a', 'b'], remote: ['a', 'b', 'c'] }),
    ).toEqual(['c', 'a', 'b']);
  });

  it('本地未改过顺序 → 采纳远端的顺序', () => {
    // 需求 6.3 说「另一方的重排会在下次同步时被覆盖」，成立的前提正是这一条：
    // 没动过顺序的一方不该把对方的重排改回去。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'c'], base: ['a', 'b', 'c'], local: ['a', 'b', 'c'], remote: ['c', 'b', 'a'] }),
    ).toEqual(['c', 'b', 'a']);
  });

  it('两侧都改过顺序 → 本地优先（需求 6.3 接受的取舍）', () => {
    expect(
      mergeOrder({ survivors: ['a', 'b', 'c'], base: ['a', 'b', 'c'], local: ['b', 'c', 'a'], remote: ['c', 'b', 'a'] }),
    ).toEqual(['b', 'c', 'a']);
  });

  it('仅新增条目不算改过顺序', () => {
    // 否则任何一次追加都会被当成重排，又回到无条件偏向本地、两台设备无限乒乓的老问题。
    // 远端作骨架 [b,a]，本地独有的 x 按规则 2 落在它的本地前驱 b 之后。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], base: ['a', 'b'], local: ['a', 'b', 'x'], remote: ['b', 'a'] }),
    ).toEqual(['b', 'x', 'a']);
  });

  it('仅删除条目不算改过顺序', () => {
    expect(
      mergeOrder({ survivors: ['a', 'c'], base: ['a', 'b', 'c'], local: ['a', 'c'], remote: ['c', 'a', 'b'] }),
    ).toEqual(['c', 'a']);
  });
});

describe('mergeOrder — 另一侧独有条目的定位（规则 2）', () => {
  it('插入到它在该侧顺序中的前驱之后', () => {
    // 本地改过顺序，故本地是骨架；远端新增的 x 按其远端前驱 a 定位。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], base: ['a', 'b'], local: ['b', 'a'], remote: ['a', 'x', 'b'] }),
    ).toEqual(['b', 'a', 'x']);
  });

  it('连续的多个新增项保持彼此的相对顺序', () => {
    expect(
      mergeOrder({
        survivors: ['a', 'b', 'x', 'y'],
        base: ['a', 'b'],
        local: ['b', 'a'],
        remote: ['a', 'x', 'y', 'b'],
      }),
    ).toEqual(['b', 'a', 'x', 'y']);
  });

  it('前驱不存在时追加到末尾', () => {
    // 远端把 x 放在最前面，但本地是骨架且 x 在本地没有前驱可依 → 追加。
    expect(
      mergeOrder({ survivors: ['a', 'b', 'x'], base: ['a', 'b'], local: ['b', 'a'], remote: ['x', 'a', 'b'] }),
    ).toEqual(['b', 'a', 'x']);
  });

  it('直接前驱已被删除时退到更前的存活前驱', () => {
    expect(
      mergeOrder({
        survivors: ['a', 'b', 'x'],
        base: ['a', 'b'],
        local: ['b', 'a'],
        remote: ['a', 'gone', 'x', 'b'],
      }),
    ).toEqual(['b', 'a', 'x']);
  });

  it('全部前驱都已删除时追加到末尾', () => {
    expect(
      mergeOrder({ survivors: ['a', 'x'], base: ['a', 'z'], local: ['z', 'a'], remote: ['gone1', 'x', 'a'] }),
    ).toEqual(['a', 'x']);
  });
});

describe('mergeOrder — 存活集合（规则 3）与边界', () => {
  it('未存活的条目就地移除', () => {
    expect(
      mergeOrder({ survivors: ['a', 'c'], base: ['a', 'b', 'c'], local: ['c', 'a', 'b'], remote: ['a', 'b', 'c'] }),
    ).toEqual(['c', 'a']);
  });

  it('两侧顺序都未提及的存活项追加末尾', () => {
    // 复活的祖先文件夹（方案 2.4 resurrectAncestors）可能只存在于 base。
    expect(
      mergeOrder({ survivors: ['a', 'resurrected'], base: ['a'], local: ['a'], remote: ['a'] }),
    ).toEqual(['a', 'resurrected']);
  });

  it('结果恰为存活集合：无重复、无多余', () => {
    const out = mergeOrder({
      survivors: ['a', 'b', 'x'],
      base: ['a', 'b', 'dropped'],
      local: ['a', 'b', 'dropped'],
      remote: ['a', 'x', 'b', 'alsoDropped'],
    });
    expect([...out].sort()).toEqual(['a', 'b', 'x']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('三侧一致时原样返回', () => {
    const same = ['a', 'b', 'c'];
    expect(mergeOrder({ survivors: same, base: same, local: same, remote: same })).toEqual(same);
  });

  it('空文件夹与空存活集合', () => {
    expect(mergeOrder({ survivors: [], base: [], local: [], remote: [] })).toEqual([]);
    expect(mergeOrder({ survivors: [], base: [], local: ['a'], remote: ['b'] })).toEqual([]);
    expect(mergeOrder({ survivors: ['a'], base: [], local: [], remote: [] })).toEqual(['a']);
  });

  it('接受 Set 作为存活集合', () => {
    expect(
      mergeOrder({ survivors: new Set(['a', 'x']), base: ['a'], local: ['a'], remote: ['a', 'x'] }),
    ).toEqual(['a', 'x']);
  });

  it('输入序列中的重复 GUID 不会让结果出现两份', () => {
    expect(
      mergeOrder({ survivors: ['a', 'b'], base: ['a', 'b'], local: ['a', 'a', 'b'], remote: ['a', 'b', 'b'] }),
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
describe('mergeOrder 代数性质', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const orderArb = fc.uniqueArray(fc.constantFrom(...pool), { maxLength: pool.length });

  const inputArb = fc.record({
    base: orderArb,
    local: orderArb,
    remote: orderArb,
    survivors: orderArb,
  });

  it('结果始终是存活集合的一个排列', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = mergeOrder(input);
        expect([...out].sort()).toEqual([...new Set(input.survivors)].sort());
        expect(new Set(out).size).toBe(out.length);
      }),
    );
  });

  it('骨架侧存活项的相对顺序被保留', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = mergeOrder(input);
        // 与实现同样的骨架判定：只比公共元素的相对顺序。
        const common = (a: readonly string[], b: readonly string[]): string[] => {
          const inB = new Set(b);
          return a.filter((g) => inB.has(g));
        };
        const localMoved =
          common(input.local, input.base).join() !== common(input.base, input.local).join();
        const skeleton = localMoved ? input.local : input.remote;
        const surviving = skeleton.filter((g) => input.survivors.includes(g));
        expect(out.filter((g) => surviving.includes(g))).toEqual(surviving);
      }),
    );
  });

  it('幂等：把结果当作三侧输入再算一次不变', () => {
    // 幂等是 INV-4 收敛的基础：重跑同步不应产生新的顺序调整。
    fc.assert(
      fc.property(inputArb, (input) => {
        const once = mergeOrder(input);
        expect(mergeOrder({ survivors: once, base: once, local: once, remote: once })).toEqual(once);
      }),
    );
  });

  it('三侧一致时等于该顺序（merge(b,x,x)=x 的顺序侧）', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        expect(mergeOrder({ survivors: order, base: order, local: order, remote: order })).toEqual(order);
      }),
    );
  });

  it('本地未改顺序时结果与远端顺序一致（收敛的关键）', () => {
    // 这条正是「两台设备各加一条书签也不收敛」那个缺陷的直接判据。
    fc.assert(
      fc.property(orderArb, orderArb, (base, remote) => {
        const survivors = remote.filter((g) => base.includes(g));
        if (survivors.length === 0) return;
        const out = mergeOrder({ survivors, base, local: base, remote });
        expect(out).toEqual(remote.filter((g) => survivors.includes(g)));
      }),
    );
  });
});
