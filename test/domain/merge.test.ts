import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeTrees } from '../../src/domain/merge.js';
import {
  ROOT_GUID,
  emptyRoots,
  isRootGuid,
  indexRoots,
  makeFolder,
  type NodeRecord,
  type Roots,
  type TreeNode,
} from '../../src/domain/tree.js';
import { bk, fd, rootsArb, tree } from '../fixtures/trees.js';

const B1 = 'b-000000000001';
const B2 = 'b-000000000002';
const B3 = 'b-000000000003';
const F1 = 'f-000000000001';
const F2 = 'f-000000000002';
const F3 = 'f-000000000003';

/** 合并后展平为索引，便于逐 GUID 断言最终形态。 */
function merged(base: Roots, local: Roots, remote: Roots): Map<string, NodeRecord> {
  return indexRoots(mergeTrees({ base, local, remote }));
}

function guidsOf(base: Roots, local: Roots, remote: Roots): string[] {
  return [...merged(base, local, remote).keys()].sort();
}

function recordOf(base: Roots, local: Roots, remote: Roots, guid: string): NodeRecord | undefined {
  return merged(base, local, remote).get(guid);
}

/**
 * 方案 2.4 的判定矩阵，逐行对照。B = base、L = local、R = remote，∅ 表示不存在。
 *
 * 实现上 11 行折叠为 7 个存在性分支：第 5/7 行是 `b-r` 的两种结果，第 6/8 行是
 * `bl-` 的两种结果，第 9/10/11 行统一由字段级三方判定处理。
 */
describe('merge 判定矩阵（方案 2.4）', () => {
  it('第 1 行 ∅ ∅ x → Keep(R)：远端新增', () => {
    const r = recordOf(tree(), tree(), tree([bk(B1, '远端新增')]), B1);
    expect(r).toMatchObject({ title: '远端新增', parentGuid: ROOT_GUID.bar });
  });

  it('第 2 行 ∅ x ∅ → Keep(L)：本地新增', () => {
    const r = recordOf(tree(), tree([bk(B1, '本地新增')]), tree(), B1);
    expect(r).toMatchObject({ title: '本地新增' });
  });

  it('第 3 行 ∅ x x → Keep(L)：两侧各自新增，同 GUID 只可能来自首次同步匹配', () => {
    const r = recordOf(tree(), tree([bk(B1, '本地')]), tree([bk(B1, '远端')]), B1);
    expect(r?.title).toBe('本地');
  });

  it('第 4 行 b ∅ ∅ → Drop：两侧都删', () => {
    expect(guidsOf(tree([bk(B1, 'X')]), tree(), tree())).toEqual([]);
  });

  it('第 5 行 b ∅ b → Drop：仅本地删，远端未变', () => {
    expect(guidsOf(tree([bk(B1, 'X')]), tree(), tree([bk(B1, 'X')]))).toEqual([]);
  });

  it('第 6 行 b b ∅ → Drop：仅远端删，本地未变', () => {
    expect(guidsOf(tree([bk(B1, 'X')]), tree([bk(B1, 'X')]), tree())).toEqual([]);
  });

  it('第 7 行 b ∅ r≠b → Keep(R)：删除 vs 修改，保留修改后状态', () => {
    // 需求 6.2：修改视为「仍在使用」的信号。
    const r = recordOf(tree([bk(B1, '旧')]), tree(), tree([bk(B1, '远端改过')]), B1);
    expect(r?.title).toBe('远端改过');
  });

  it('第 8 行 b l≠b ∅ → Keep(L)：镜像情形', () => {
    const r = recordOf(tree([bk(B1, '旧')]), tree([bk(B1, '本地改过')]), tree(), B1);
    expect(r?.title).toBe('本地改过');
  });

  it('第 9 行 b b r≠b → Keep(R)：仅远端改', () => {
    const r = recordOf(tree([bk(B1, '旧')]), tree([bk(B1, '旧')]), tree([bk(B1, '新')]), B1);
    expect(r?.title).toBe('新');
  });

  it('第 10 行 b l≠b b → Keep(L)：仅本地改', () => {
    const r = recordOf(tree([bk(B1, '旧')]), tree([bk(B1, '新')]), tree([bk(B1, '旧')]), B1);
    expect(r?.title).toBe('新');
  });

  it('第 11 行 b l r 且 l=r → Keep：两侧相同改动视为一致，无冲突', () => {
    // 需求 6.2 第二行，也是 INV-4 幂等性的来源。
    const r = recordOf(tree([bk(B1, '旧')]), tree([bk(B1, '同')]), tree([bk(B1, '同')]), B1);
    expect(r?.title).toBe('同');
  });

  it('第 11 行 b l r 且 l≠r → 逐字段本地优先', () => {
    const r = recordOf(tree([bk(B1, '旧')]), tree([bk(B1, '本地')]), tree([bk(B1, '远端')]), B1);
    expect(r?.title).toBe('本地');
  });

  it('删除 vs 移动：保留在移动后的位置（需求 6.2）', () => {
    const base = tree([bk(B1, 'X'), fd(F1, '目标')]);
    const local = tree([fd(F1, '目标')]); // 本地删除 B1
    const remote = tree([fd(F1, '目标', [bk(B1, 'X')])]); // 远端把 B1 移入 F1
    expect(recordOf(base, local, remote, B1)).toMatchObject({ parentGuid: F1 });
  });

  it('两侧在同一父目录下各自新增：两者都保留（需求 6.2）', () => {
    const out = guidsOf(tree(), tree([bk(B1, 'L')]), tree([bk(B2, 'R')]));
    expect(out).toEqual([B1, B2]);
  });
});

/**
 * 字段级独立判定（方案 2.4 末段）。
 *
 * title、url、parentGuid 三者各自走一遍矩阵。这样「A 改标题、B 移位置」两个
 * 改动都能保留，而不是整节点二选一 —— 方案称其为「低成本的正确性提升」。
 */
describe('merge 字段级独立判定', () => {
  it('本地改标题、远端移位置：两个改动都保留', () => {
    const base = tree([bk(B1, '旧标题'), fd(F1, '目标')]);
    const local = tree([bk(B1, '新标题'), fd(F1, '目标')]);
    const remote = tree([fd(F1, '目标', [bk(B1, '旧标题')])]);
    // 整节点二选一会丢掉其中一个改动；字段级判定两者兼得。
    expect(recordOf(base, local, remote, B1)).toMatchObject({ title: '新标题', parentGuid: F1 });
  });

  it('本地改 url、远端改标题：各取改动方', () => {
    const base = tree([bk(B1, '旧标题', 'https://old.test/')]);
    const local = tree([bk(B1, '旧标题', 'https://new.test/')]);
    const remote = tree([bk(B1, '新标题', 'https://old.test/')]);
    expect(recordOf(base, local, remote, B1)).toMatchObject({
      title: '新标题',
      url: 'https://new.test/',
    });
  });

  it('同一字段双改时本地优先，其他字段仍各取改动方', () => {
    const base = tree([bk(B1, '旧', 'https://old.test/')]);
    const local = tree([bk(B1, '本地', 'https://old.test/')]);
    const remote = tree([bk(B1, '远端', 'https://remote.test/')]);
    expect(recordOf(base, local, remote, B1)).toMatchObject({
      title: '本地',
      url: 'https://remote.test/',
    });
  });

  it('本地移位置、远端移到别处：位置以本地为准（需求 6.2）', () => {
    const base = tree([bk(B1, 'X'), fd(F1, '甲'), fd(F2, '乙')]);
    const local = tree([fd(F1, '甲', [bk(B1, 'X')]), fd(F2, '乙')]);
    const remote = tree([fd(F1, '甲'), fd(F2, '乙', [bk(B1, 'X')])]);
    expect(recordOf(base, local, remote, B1)).toMatchObject({ parentGuid: F1 });
  });

  it('文件夹标题同样逐字段判定', () => {
    const base = tree([fd(F1, '旧名')]);
    const local = tree([fd(F1, '旧名')]);
    const remote = tree([fd(F1, '新名')]);
    expect(recordOf(base, local, remote, F1)?.title).toBe('新名');
  });
});

/**
 * 悬空父处理（方案 2.4 末段 resurrectAncestors）。
 *
 * 对应需求 6.2 最后一条：一侧删除文件夹、另一侧在该文件夹内新增条目 ——
 * 保留文件夹与新条目，删除文件夹内其余条目。
 */
describe('merge 悬空父与祖先复活', () => {
  it('情形 1：删文件夹 vs 内部新增 → 文件夹复活，其余子项仍删除', () => {
    const base = tree([fd(F1, '技术', [bk(B1, '旧条目')])]);
    const local = tree(); // 本地整个删掉 F1 与 B1
    const remote = tree([fd(F1, '技术', [bk(B1, '旧条目'), bk(B2, '远端新增')])]);

    const idx = merged(base, local, remote);
    expect([...idx.keys()].sort()).toEqual([B2, F1]);
    expect(idx.get(B2)).toMatchObject({ parentGuid: F1 });
    expect(idx.get(F1)?.title).toBe('技术');
  });

  it('情形 2：多层祖先都被删，最深处有存活子项 → 整条父链复活', () => {
    const base = tree([fd(F1, '甲', [fd(F2, '乙', [fd(F3, '丙')])])]);
    const local = tree(); // 本地删掉整棵子树
    const remote = tree([fd(F1, '甲', [fd(F2, '乙', [fd(F3, '丙', [bk(B1, '深处新增')])])])]);

    const idx = merged(base, local, remote);
    expect([...idx.keys()].sort()).toEqual([B1, F1, F2, F3]);
    expect(idx.get(B1)).toMatchObject({ parentGuid: F3 });
    expect(idx.get(F3)).toMatchObject({ parentGuid: F2 });
    expect(idx.get(F2)).toMatchObject({ parentGuid: F1 });
    expect(idx.get(F1)).toMatchObject({ parentGuid: ROOT_GUID.bar });
  });

  it('情形 3：一侧删文件夹、另一侧把既有条目移入其中 → 文件夹复活并容纳该条目', () => {
    const base = tree([fd(F1, '技术'), bk(B1, '外部条目')]);
    const local = tree([bk(B1, '外部条目')]); // 本地删掉空文件夹 F1
    const remote = tree([fd(F1, '技术', [bk(B1, '外部条目')])]); // 远端把 B1 移入 F1

    const idx = merged(base, local, remote);
    expect([...idx.keys()].sort()).toEqual([B1, F1]);
    expect(idx.get(B1)).toMatchObject({ parentGuid: F1 });
  });

  it('复活的文件夹取任一侧最后已知的标题', () => {
    // 方案 2.4：「用它在任一侧的最后已知标题」。本地已删除，只有远端还有标题。
    const base = tree([fd(F1, '基线标题')]);
    const local = tree();
    const remote = tree([fd(F1, '远端改名后', [bk(B1, '新增')])]);
    expect(recordOf(base, local, remote, F1)?.title).toBe('远端改名后');
  });

  it('情形 4：父子互换形成循环 → 打破循环且两个节点都不丢', () => {
    // 本地把 F1 移入 F2，远端把 F2 移入 F1。字段级 parentGuid 本地优先会
    // 同时得到 F1.parent=F2 与 F2.parent=F1，若不处理，两棵子树都装配不上根。
    const base = tree([fd(F1, '甲'), fd(F2, '乙')]);
    const local = tree([fd(F2, '乙', [fd(F1, '甲')])]);
    const remote = tree([fd(F1, '甲', [fd(F2, '乙')])]);

    const idx = merged(base, local, remote);
    expect([...idx.keys()].sort()).toEqual([F1, F2]);
    // 循环被打破：两者不可能互为祖先。
    const p1 = idx.get(F1)!.parentGuid;
    const p2 = idx.get(F2)!.parentGuid;
    expect(p1 === F2 && p2 === F1).toBe(false);
  });

  it('★ 打破循环只提环上的节点，环下面的子树跟着走（审计 L-7）', () => {
    // 本地把 F1 移入 F2、远端把 F2 移入 F1 —— F1 与 F2 成环。而 F3 与 B1 是挂在
    // F1 下面的正常子节点，它们的父链只是恰好经过环，本身没有任何问题。
    //
    // 原实现对每个节点独立判断「父能否到达根」，成环节点的 false 被写进备忘录，
    // 于是 F3 与 B1 也被判成不可用、一起提到书签栏第一层。条目不丢，但层级散架：
    // 用户看到几十个书签突然全跑到书签栏根下，而且这个结果会上传。
    const base = tree([fd(F1, '甲', [fd(F3, '丙', [bk(B1, '书签')])]), fd(F2, '乙')]);
    const local = tree([fd(F2, '乙', [fd(F1, '甲', [fd(F3, '丙', [bk(B1, '书签')])])])]);
    const remote = tree([fd(F1, '甲', [fd(F3, '丙', [bk(B1, '书签')]), fd(F2, '乙')])]);

    const idx = merged(base, local, remote);
    expect([...idx.keys()].sort()).toEqual([B1, F1, F2, F3].sort());
    // 环被打破。
    const p1 = idx.get(F1)!.parentGuid;
    const p2 = idx.get(F2)!.parentGuid;
    expect(p1 === F2 && p2 === F1).toBe(false);
    // ★ 关键：F3 仍在 F1 下，B1 仍在 F3 下 —— 层级没有被打平。
    expect(idx.get(F3)!.parentGuid).toBe(F1);
    expect(idx.get(B1)!.parentGuid).toBe(F3);
  });

  it('循环发生在「其他书签」深处时，兜底挂回原所属逻辑根而非书签栏', () => {
    // 兜底必须挑对根：挂错会让条目在两棵树之间凭空搬家，用户看到的是书签
    // 从「其他书签」跑进了「书签栏」。
    const base = tree([], [fd(F3, '容器', [fd(F1, '甲'), fd(F2, '乙')])]);
    const local = tree([], [fd(F3, '容器', [fd(F2, '乙', [fd(F1, '甲')])])]);
    const remote = tree([], [fd(F3, '容器', [fd(F1, '甲', [fd(F2, '乙')])])]);

    const out = mergeTrees({ base, local, remote });
    const idx = indexRoots(out);
    expect([...idx.keys()].sort()).toEqual([F1, F2, F3].sort());
    expect(out.bar.children).toEqual([]);
    // 三者都还在 other 子树内。
    for (const guid of [F1, F2, F3]) {
      let cur = guid;
      while (!isRootGuid(idx.get(cur)!.parentGuid)) cur = idx.get(cur)!.parentGuid;
      expect(idx.get(cur)!.parentGuid, guid).toBe(ROOT_GUID.other);
    }
  });
});

describe('merge 结构与顺序', () => {
  it('保留两棵逻辑根并采用本地的根标题', () => {
    const local = emptyRoots({ bar: '书签栏', other: '其他书签' });
    const remote = emptyRoots({ bar: 'Bookmarks bar', other: 'Other bookmarks' });
    const out = mergeTrees({ base: emptyRoots(), local, remote });
    // 根标题是设备本地界面标签，不参与同步（与 hash.ts 的处理一致）。
    expect(out.bar.title).toBe('书签栏');
    expect(out.other.title).toBe('其他书签');
    expect(out.bar.guid).toBe(ROOT_GUID.bar);
    expect(out.other.guid).toBe(ROOT_GUID.other);
  });

  it('children 顺序按 order.ts 生成：本地骨架 + 远端新增按前驱插入', () => {
    const base = tree([bk(B1, 'A'), bk(B2, 'B')]);
    const local = tree([bk(B2, 'B'), bk(B1, 'A')]); // 本地重排
    const remote = tree([bk(B1, 'A'), bk(B3, 'C'), bk(B2, 'B')]); // 远端在 A 后新增 C
    const out = mergeTrees({ base, local, remote });
    expect(out.bar.children.map((c) => c.guid)).toEqual([B2, B1, B3]);
  });

  it('分别处理两棵根，互不串扰', () => {
    const base = tree([bk(B1, 'A')], [bk(B2, 'B')]);
    const local = tree([bk(B1, 'A2')], [bk(B2, 'B')]);
    const remote = tree([bk(B1, 'A')], [bk(B2, 'B2')]);
    const out = mergeTrees({ base, local, remote });
    expect(out.bar.children.map((c) => c.title)).toEqual(['A2']);
    expect(out.other.children.map((c) => c.title)).toEqual(['B2']);
  });

  it('跨逻辑根的移动被视为一次父变化', () => {
    const base = tree([bk(B1, 'X')]);
    const local = tree([], [bk(B1, 'X')]); // 本地移到「其他书签」
    const remote = tree([bk(B1, 'X')]);
    const out = mergeTrees({ base, local, remote });
    expect(out.bar.children).toEqual([]);
    expect(out.other.children.map((c) => c.guid)).toEqual([B1]);
  });

  it('嵌套结构完整重建', () => {
    const deep = tree([fd(F1, '甲', [fd(F2, '乙', [bk(B1, '深')])])]);
    const out = mergeTrees({ base: deep, local: deep, remote: deep });
    expect(out).toEqual(deep);
  });
});

/**
 * 属性测试（方案 7.2 第 1、2 条）。
 *
 * 这两条是 INV-4「中断后必须收敛」的代数基础：方案 2.3 指出幂等与收敛是
 * 恒等式的推论，而不是需要单独实现的性质 —— 因此必须真的验证恒等式成立。
 */
describe('merge 代数性质', () => {
  it('幂等：merge(T, T, T) = T', () => {
    fc.assert(
      fc.property(rootsArb, (t) => {
        expect(mergeTrees({ base: t, local: t, remote: t })).toEqual(t);
      }),
    );
  });

  it('同值收敛：merge(b, x, x) = x —— 直接覆盖 INV-4 第三个崩溃点', () => {
    // 「远端 PUT 成功、写基线之前」崩溃后重跑：base 是旧的，local 与 remote
    // 已一致，合并必须原样得到 x，从而产出空操作、只更新基线。
    fc.assert(
      fc.property(rootsArb, rootsArb, (base, x) => {
        expect(mergeTrees({ base, local: x, remote: x })).toEqual(x);
      }),
    );
  });

  it('确定性：同一组输入重复合并结果一致', () => {
    // 实现内部用了 Set/Map，这条防止迭代序泄漏到输出。
    fc.assert(
      fc.property(rootsArb, rootsArb, rootsArb, (base, local, remote) => {
        const once = mergeTrees({ base, local, remote });
        const twice = mergeTrees({ base, local, remote });
        expect(twice).toEqual(once);
      }),
    );
  });

  it('结果始终是可装配的合法森林：无重复 GUID、无悬空父', () => {
    fc.assert(
      fc.property(rootsArb, rootsArb, rootsArb, (base, local, remote) => {
        const out = mergeTrees({ base, local, remote });
        const idx = indexRoots(out);
        const seen = new Set<string>();
        for (const [guid, rec] of idx) {
          expect(seen.has(guid)).toBe(false);
          seen.add(guid);
          // 父必须是逻辑根或另一个存活的文件夹。
          const isRoot = rec.parentGuid === ROOT_GUID.bar || rec.parentGuid === ROOT_GUID.other;
          if (!isRoot) expect(idx.get(rec.parentGuid)?.type).toBe('folder');
        }
      }),
    );
  });

  it('两侧都存在的节点绝不在装配阶段凭空消失', () => {
    // 「合法森林」不足以捕获整片丢失：若父链成环，环上节点从根出发不可达，
    // 会被静默丢弃 —— 输出仍然合法，但书签没了。这条属性专门盯住那种情形。
    fc.assert(
      fc.property(rootsArb, rootsArb, rootsArb, (base, local, remote) => {
        const out = indexRoots(mergeTrees({ base, local, remote }));
        const lIdx = indexRoots(local);
        const rIdx = indexRoots(remote);
        for (const guid of lIdx.keys()) {
          // 同时存在于两侧 ⇒ 判定矩阵必然 Keep（∅xx 或 blr 两种分支）。
          if (rIdx.has(guid)) expect(out.has(guid), guid).toBe(true);
        }
      }),
    );
  });

  it('本地新增的条目绝不丢失 —— INV-1 违规会表现为这条失败', () => {
    // 「应用本地改动之后、远端 PUT 之前」崩溃（INV-4 第二个崩溃点）：
    // 本地已有改动、远端还是旧值、基线是旧的，本地改动必须被采纳并上传。
    fc.assert(
      fc.property(rootsArb, (base) => {
        const local = tree(
          [...base.bar.children, bk('b-ffffffffffff', '崩溃前新增')],
          base.other.children,
        );
        const out = mergeTrees({ base, local, remote: base });
        expect(indexRoots(out).get('b-ffffffffffff')).toBeDefined();
      }),
    );
  });
});

/**
 * 针对循环的定向属性测试。
 *
 * 上面那组随机森林几乎不会撞出父链循环 —— 需要两侧各自改动不同节点的父，
 * 且恰好互为祖先。因此单独生成这种局面：同一批文件夹，两侧各按一种随机
 * 嵌套方式组织。字段级 parentGuid「本地优先」在这里会真的造出环。
 */
describe('merge 循环打破（定向生成）', () => {
  const FOLDERS: string[] = ['f-0000000000a1', 'f-0000000000a2', 'f-0000000000a3', 'f-0000000000a4'];

  /** 随机但一定无环的嵌套：按给定顺序，每个文件夹挂到更早出现的某个之下或根上。 */
  function nest(order: readonly string[], parentPick: readonly number[]): Roots {
    const nodes = new Map<string, TreeNode>(order.map((g) => [g, makeFolder(g, `F${g.slice(-2)}`)]));
    const roots = emptyRoots();
    order.forEach((guid, i) => {
      const choice = parentPick[i] ?? 0;
      // 0 表示挂到 bar 根，否则挂到第 (choice-1) % i 个更早的文件夹之下。
      if (choice === 0 || i === 0) {
        roots.bar.children.push(nodes.get(guid)!);
        return;
      }
      const parent = nodes.get(order[(choice - 1) % i]!)!;
      (parent as { children: TreeNode[] }).children.push(nodes.get(guid)!);
    });
    return roots;
  }

  const permutationArb = fc.shuffledSubarray([...FOLDERS], {
    minLength: FOLDERS.length,
    maxLength: FOLDERS.length,
  });
  const picksArb = fc.array(fc.nat({ max: FOLDERS.length }), {
    minLength: FOLDERS.length,
    maxLength: FOLDERS.length,
  });

  it('两侧任意嵌套组合下，全部文件夹都保留且结果无环', () => {
    fc.assert(
      fc.property(permutationArb, picksArb, permutationArb, picksArb, (lo, lp, ro, rp) => {
        const base = nest(FOLDERS, [0, 0, 0, 0]); // 基线：四个文件夹平铺在根下
        const out = mergeTrees({ base, local: nest(lo, lp), remote: nest(ro, rp) });
        const idx = indexRoots(out);

        // 一个都不能少 —— 成环时若不打破，整片子树从根出发不可达而静默消失。
        expect([...idx.keys()].sort()).toEqual([...FOLDERS].sort());

        // 每个节点都能沿父链走到逻辑根，即结果无环。
        for (const guid of idx.keys()) {
          let cur = guid;
          let hops = 0;
          while (!isRootGuid(idx.get(cur)!.parentGuid)) {
            cur = idx.get(cur)!.parentGuid;
            expect(++hops).toBeLessThanOrEqual(FOLDERS.length);
          }
        }
      }),
    );
  });
});
