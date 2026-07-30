import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPlan, buildPlan, countRemovals, summarizePlan, type LocalOp } from '../../src/domain/plan.js';
import { ROOT_GUID } from '../../src/domain/tree.js';
import { bk, fd, rootsArb, tree } from '../fixtures/trees.js';

const B1 = 'b-000000000001';
const B2 = 'b-000000000002';
const B3 = 'b-000000000003';
const F1 = 'f-000000000001';
const F2 = 'f-000000000002';

const kindsOf = (ops: readonly LocalOp[]): string[] => ops.map((o) => o.kind);
const firstIndexOf = (ops: readonly LocalOp[], kind: LocalOp['kind']): number =>
  ops.findIndex((o) => o.kind === kind);
const lastIndexOf = (ops: readonly LocalOp[], kind: LocalOp['kind']): number =>
  ops.reduce((acc, o, i) => (o.kind === kind ? i : acc), -1);

describe('buildPlan — 操作生成', () => {
  it('相同的树不产生任何操作', () => {
    const t = tree([bk(B1, 'A'), fd(F1, '甲', [bk(B2, 'B')])]);
    expect(buildPlan(t, t)).toEqual([]);
  });

  it('目标独有的节点产出 create，带父、位置与内容', () => {
    const ops = buildPlan(tree(), tree([bk(B1, 'A', 'https://a.test/')]));
    expect(ops).toEqual([
      {
        kind: 'create',
        guid: B1,
        parentGuid: ROOT_GUID.bar,
        index: 0,
        type: 'bookmark',
        title: 'A',
        url: 'https://a.test/',
      },
    ]);
  });

  it('文件夹的 create 不带 url', () => {
    const ops = buildPlan(tree(), tree([fd(F1, '甲')]));
    expect(ops[0]).toEqual({
      kind: 'create',
      guid: F1,
      parentGuid: ROOT_GUID.bar,
      index: 0,
      type: 'folder',
      title: '甲',
    });
  });

  it('当前独有的节点产出 remove', () => {
    const ops = buildPlan(tree([bk(B1, 'A')]), tree());
    expect(ops).toEqual([{ kind: 'remove', guid: B1 }]);
  });

  it('标题与 url 变化产出 update，只带变化的字段', () => {
    const titleOnly = buildPlan(
      tree([bk(B1, 'A', 'https://a.test/')]),
      tree([bk(B1, 'A2', 'https://a.test/')]),
    );
    expect(titleOnly).toEqual([{ kind: 'update', guid: B1, title: 'A2' }]);

    const urlOnly = buildPlan(
      tree([bk(B1, 'A', 'https://a.test/')]),
      tree([bk(B1, 'A', 'https://b.test/')]),
    );
    expect(urlOnly).toEqual([{ kind: 'update', guid: B1, url: 'https://b.test/' }]);
  });

  it('父变化产出 move', () => {
    const ops = buildPlan(
      tree([bk(B1, 'A'), fd(F1, '甲')]),
      tree([fd(F1, '甲', [bk(B1, 'A')])]),
    );
    expect(ops.filter((o) => o.kind === 'move')).toEqual([
      { kind: 'move', guid: B1, parentGuid: F1, index: 0 },
    ]);
  });

  it('仅兄弟顺序变化时只产出 reorder，不产出 move', () => {
    const ops = buildPlan(tree([bk(B1, 'A'), bk(B2, 'B')]), tree([bk(B2, 'B'), bk(B1, 'A')]));
    expect(kindsOf(ops)).toEqual(['reorder']);
    expect(ops[0]).toEqual({ kind: 'reorder', parentGuid: ROOT_GUID.bar, childGuids: [B2, B1] });
  });
});

describe('buildPlan — 排序约束（方案 3.3）', () => {
  it('create 按自顶向下拓扑序：父先于子', () => {
    const target = tree([fd(F1, '甲', [fd(F2, '乙', [bk(B1, 'A')])])]);
    const ops = buildPlan(tree(), target);
    const order = ops.filter((o) => o.kind === 'create').map((o) => o.guid);
    expect(order.indexOf(F1)).toBeLessThan(order.indexOf(F2));
    expect(order.indexOf(F2)).toBeLessThan(order.indexOf(B1));
  });

  it('remove 按自底向上：子先于父', () => {
    const current = tree([fd(F1, '甲', [fd(F2, '乙', [bk(B1, 'A')])])]);
    const ops = buildPlan(current, tree());
    const order = ops.filter((o) => o.kind === 'remove').map((o) => o.guid);
    expect(order.indexOf(B1)).toBeLessThan(order.indexOf(F2));
    expect(order.indexOf(F2)).toBeLessThan(order.indexOf(F1));
  });

  it('move 位于全部 create 之后、全部 remove 之前', () => {
    // 同时需要新建目标文件夹、把条目移入、再删掉旧文件夹。
    const current = tree([fd(F1, '旧', [bk(B1, 'A')])]);
    const target = tree([fd(F2, '新', [bk(B1, 'A')])]);
    const ops = buildPlan(current, target);
    expect(kindsOf(ops)).toContain('create');
    expect(kindsOf(ops)).toContain('move');
    expect(kindsOf(ops)).toContain('remove');
    expect(lastIndexOf(ops, 'create')).toBeLessThan(firstIndexOf(ops, 'move'));
    expect(lastIndexOf(ops, 'move')).toBeLessThan(firstIndexOf(ops, 'remove'));
  });

  it('reorder 位于最后', () => {
    // 本地重排 + 末尾新增：create 之后顺序仍与目标不符，必须补一次 reorder。
    const current = tree([bk(B1, 'A'), bk(B2, 'B')]);
    const target = tree([bk(B2, 'B'), bk(B1, 'A'), bk(B3, 'C')]);
    const ops = buildPlan(current, target);
    expect(kindsOf(ops)).toContain('reorder');
    expect(firstIndexOf(ops, 'reorder')).toBe(ops.length - 1);
    expect(applyPlan(current, ops)).toEqual(target);
  });

  it('结构操作已顺带得到目标顺序时不发多余的 reorder', () => {
    // current [A,B] → target [C,B]：在 0 位插入 C 再删掉 A，顺序自然就是 [C,B]。
    // 照抄目标顺序会白发一条 reorder，弱网下多一轮 API 调用。
    const current = tree([bk(B1, 'A'), bk(B2, 'B')]);
    const target = tree([bk(B3, 'C'), bk(B2, 'B')]);
    const ops = buildPlan(current, target);
    expect(kindsOf(ops)).not.toContain('reorder');
    expect(applyPlan(current, ops)).toEqual(target);
  });

  it('把条目移出即将被删除的文件夹：move 先于 remove，过程中不删非空文件夹', () => {
    const current = tree([fd(F1, '待删', [bk(B1, 'A')])]);
    const target = tree([bk(B1, 'A')]);
    const ops = buildPlan(current, target);
    expect(lastIndexOf(ops, 'move')).toBeLessThan(firstIndexOf(ops, 'remove'));
    // applyPlan 是严格实现：删非空文件夹会抛错，因此这行同时验证了顺序正确。
    expect(applyPlan(current, ops)).toEqual(target);
  });

  it('把条目移入新建的文件夹：create 先于 move', () => {
    const current = tree([bk(B1, 'A')]);
    const target = tree([fd(F1, '新建', [bk(B1, 'A')])]);
    const ops = buildPlan(current, target);
    expect(lastIndexOf(ops, 'create')).toBeLessThan(firstIndexOf(ops, 'move'));
    expect(applyPlan(current, ops)).toEqual(target);
  });
});

describe('applyPlan — 严格前置条件', () => {
  it('create 的父不存在时抛错', () => {
    expect(() =>
      applyPlan(tree(), [
        { kind: 'create', guid: B1, parentGuid: F1, index: 0, type: 'bookmark', title: 'A', url: 'u' },
      ]),
    ).toThrow(/parent/i);
  });

  it('remove 非空文件夹时抛错', () => {
    expect(() => applyPlan(tree([fd(F1, '甲', [bk(B1, 'A')])]), [{ kind: 'remove', guid: F1 }])).toThrow(
      /not empty/i,
    );
  });

  it('move 到不存在的父时抛错', () => {
    expect(() =>
      applyPlan(tree([bk(B1, 'A')]), [{ kind: 'move', guid: B1, parentGuid: F2, index: 0 }]),
    ).toThrow(/parent/i);
  });

  it('reorder 的 childGuids 与实际子项不符时抛错', () => {
    expect(() =>
      applyPlan(tree([bk(B1, 'A')]), [
        { kind: 'reorder', parentGuid: ROOT_GUID.bar, childGuids: [B1, B2] },
      ]),
    ).toThrow(/reorder/i);
  });

  it('操作未知 GUID 时抛错', () => {
    expect(() => applyPlan(tree(), [{ kind: 'remove', guid: B1 }])).toThrow(/unknown/i);
    expect(() => applyPlan(tree(), [{ kind: 'update', guid: B1, title: 'x' }])).toThrow(/unknown/i);
  });

  it('不修改输入树', () => {
    const current = tree([bk(B1, 'A')]);
    const snapshot = structuredClone(current);
    applyPlan(current, buildPlan(current, tree([bk(B1, 'A2')])));
    expect(current).toEqual(snapshot);
  });

  it('索引越界视为追加到末尾，而不是报错', () => {
    // buildPlan 的 create 用的是目标树里的位置，但执行到该条时同一父下更靠前的
    // 兄弟可能还没建出来（create 按深度排序，不按兄弟序）。越界必须容忍，
    // 最终顺序由收尾的 reorder 校正。M2 的真实 applier 也须照此钳制。
    const out = applyPlan(tree([bk(B1, 'A')]), [
      { kind: 'create', guid: B2, parentGuid: ROOT_GUID.bar, index: 99, type: 'bookmark', title: 'B', url: 'u' },
      { kind: 'move', guid: B1, parentGuid: ROOT_GUID.bar, index: 99 },
    ]);
    expect(out.bar.children.map((c) => c.guid)).toEqual([B2, B1]);
  });

  it('负数索引被拒绝，而不是被当成「从末尾倒数」', () => {
    // splice(-1, …) 会静默插到倒数第二个位置。严格实现必须拒绝。
    expect(() =>
      applyPlan(tree(), [
        { kind: 'create', guid: B1, parentGuid: ROOT_GUID.bar, index: -1, type: 'bookmark', title: 'A', url: 'u' },
      ]),
    ).toThrow(/invalid index/i);

    expect(() =>
      applyPlan(tree([bk(B1, 'A'), bk(B2, 'B')]), [
        { kind: 'move', guid: B1, parentGuid: ROOT_GUID.bar, index: -1 },
      ]),
    ).toThrow(/invalid index/i);
  });

  it('拒绝把文件夹移入自己的子树', () => {
    // 浏览器 API 也会拒绝，但严格实现必须先于它发现 —— 否则 buildPlan 若哪天
    // 产出这种操作，错误会在真实书签树上才暴露。
    const current = tree([fd(F1, '甲', [fd(F2, '乙')])]);
    expect(() => applyPlan(current, [{ kind: 'move', guid: F1, parentGuid: F2, index: 0 }])).toThrow(
      /own subtree/i,
    );
  });
});

describe('summarizePlan / countRemovals', () => {
  it('按类别计数，供 popup 展示同步结果（resultSynced）', () => {
    const current = tree([bk(B1, 'A'), bk(B2, 'B'), fd(F1, '甲')]);
    const target = tree([fd(F1, '甲', [bk(B1, 'A2')]), bk(B3, 'C')]);
    expect(summarizePlan(buildPlan(current, target))).toEqual({
      create: 1,
      update: 1,
      move: 1,
      remove: 1,
      reorder: expect.any(Number),
    });
  });

  it('countRemovals 逐节点统计，文件夹的子孙各自计入（方案 4.1 的分子）', () => {
    const current = tree([fd(F1, '甲', [bk(B1, 'A'), fd(F2, '乙', [bk(B2, 'B')])])]);
    const ops = buildPlan(current, tree());
    // 删除保护的分子是条目数，不是操作数 —— 一个文件夹连带 3 个后代要算 4。
    expect(countRemovals(ops)).toBe(4);
    expect(countRemovals([])).toBe(0);
  });
});

/**
 * 属性测试（方案 7.2 第 3、4 条）。
 *
 * 第 3 条 apply(plan(a, b), a) = b 是整个本地应用路径的正确性依据：
 * plan.ts 只要满足它，M2 的 platform/bookmarks.ts 就只需忠实执行操作序列。
 * 第 4 条由 applyPlan 的严格前置条件承担 —— 顺序错了它会抛错。
 */
describe('plan 代数性质', () => {
  it('第 3 条：apply(plan(a, b), a) = b', () => {
    fc.assert(
      fc.property(rootsArb, rootsArb, (a, b) => {
        expect(applyPlan(a, buildPlan(a, b))).toEqual(b);
      }),
    );
  });

  it('第 4 条：按序应用过程中不出现「父不存在」或「删非空文件夹」', () => {
    // applyPlan 会在这两种情形抛错，因此「不抛」即为该性质成立。
    fc.assert(
      fc.property(rootsArb, rootsArb, (a, b) => {
        expect(() => applyPlan(a, buildPlan(a, b))).not.toThrow();
      }),
    );
  });

  it('第 1 条（计划侧）：plan(T, T) = []', () => {
    fc.assert(
      fc.property(rootsArb, (t) => {
        expect(buildPlan(t, t)).toEqual([]);
      }),
    );
  });

  it('幂等：计划应用一次后再算一次计划为空', () => {
    fc.assert(
      fc.property(rootsArb, rootsArb, (a, b) => {
        const once = applyPlan(a, buildPlan(a, b));
        expect(buildPlan(once, b)).toEqual([]);
      }),
    );
  });

  it('计划中每个 GUID 的操作类别不自相矛盾：create 与 remove 不同时出现', () => {
    fc.assert(
      fc.property(rootsArb, rootsArb, (a, b) => {
        const ops = buildPlan(a, b);
        const created = new Set(ops.filter((o) => o.kind === 'create').map((o) => o.guid));
        for (const op of ops) {
          if (op.kind === 'remove') expect(created.has(op.guid)).toBe(false);
        }
      }),
    );
  });
});
