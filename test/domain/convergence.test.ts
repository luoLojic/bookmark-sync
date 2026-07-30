import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/domain/hash.js';
import { mergeTrees } from '../../src/domain/merge.js';
import { applyPlan, buildPlan } from '../../src/domain/plan.js';
import {
  cloneRoots,
  indexRoots,
  isFolder,
  makeBookmark,
  walk,
  type Guid,
  type Roots,
  type TreeNode,
} from '../../src/domain/tree.js';
import { rootsArb } from '../fixtures/trees.js';

/**
 * 方案 7.2 第 5 条：双设备收敛。文档称其为「整个项目最有价值的一个测试」。
 *
 * 这里在 domain 层做，不需要 engine 与远端：一次同步在纯函数层面就是
 *   T = merge(baseline, local, remote) → local' = apply(plan(local, T)) → baseline' = T → remote' = T
 * 崩溃、重试、网络都不影响这个恒等式，因此收敛性可以在 M1 就验证。
 */

interface Device {
  local: Roots;
  baseline: Roots;
}

/** 一次完整同步。返回新的远端快照内容。 */
function syncOnce(device: Device, remote: Roots): Roots {
  const target = mergeTrees({ base: device.baseline, local: device.local, remote });
  device.local = applyPlan(device.local, buildPlan(device.local, target));
  // INV-1：基线只在远端提交成功后写入。这里远端提交即返回值生效，故同时更新。
  device.baseline = target;
  return target;
}

// ── 随机编辑 ─────────────────────────────────────────────────────────

type Edit =
  | { k: 'add'; at: number; slot: number }
  | { k: 'del'; at: number }
  | { k: 'rename'; at: number; slot: number }
  | { k: 'move'; at: number; to: number }
  | { k: 'reorder'; at: number; to: number };

const editArb = fc.oneof(
  fc.record({ k: fc.constant<'add'>('add'), at: fc.nat({ max: 20 }), slot: fc.nat({ max: 99 }) }),
  fc.record({ k: fc.constant<'del'>('del'), at: fc.nat({ max: 20 }) }),
  fc.record({ k: fc.constant<'rename'>('rename'), at: fc.nat({ max: 20 }), slot: fc.nat({ max: 99 }) }),
  fc.record({ k: fc.constant<'move'>('move'), at: fc.nat({ max: 20 }), to: fc.nat({ max: 20 }) }),
  fc.record({ k: fc.constant<'reorder'>('reorder'), at: fc.nat({ max: 20 }), to: fc.nat({ max: 20 }) }),
);

const editsArb = fc.array(editArb, { maxLength: 6 });

/** 树中全部节点（前序）与全部可作父的容器（两棵逻辑根 + 文件夹）。 */
function inventory(roots: Roots): { nodes: TreeNode[]; parents: TreeNode[] } {
  const nodes: TreeNode[] = [];
  const parents: TreeNode[] = [roots.bar, roots.other];
  for (const { node } of walk(roots)) {
    nodes.push(node);
    if (isFolder(node)) parents.push(node);
  }
  return { nodes, parents };
}

function detachFrom(roots: Roots, guid: Guid): TreeNode | null {
  const { parents } = inventory(roots);
  for (const parent of parents) {
    if (!isFolder(parent)) continue;
    const at = parent.children.findIndex((c) => c.guid === guid);
    if (at >= 0) return parent.children.splice(at, 1)[0] ?? null;
  }
  return null;
}

/** candidate 是否在 guid 的子树内（含自身）。移动时不得把文件夹放进自己里面。 */
function within(node: TreeNode, guid: Guid): boolean {
  if (node.guid === guid) return true;
  return isFolder(node) && node.children.some((c) => within(c, guid));
}

/**
 * 把随机编辑应用到树上。越界或非法的编辑直接跳过 —— 生成器不必只产出合法编辑，
 * 让它自由生成、这里做筛选，收缩出的反例更小。
 */
function applyEdits(roots: Roots, edits: readonly Edit[], device: string): Roots {
  const out = cloneRoots(roots);
  let seq = 0;

  for (const edit of edits) {
    const { nodes, parents } = inventory(out);

    switch (edit.k) {
      case 'add': {
        const parent = parents[edit.at % parents.length];
        if (parent === undefined || !isFolder(parent)) break;
        const id = `${device}${String(++seq).padStart(11, '0')}`;
        parent.children.push(makeBookmark(`b-${id}`, `${device}-新增${seq}`, `https://${device}${edit.slot}.test/`));
        break;
      }
      case 'del': {
        const victim = nodes[edit.at % Math.max(1, nodes.length)];
        if (victim !== undefined) detachFrom(out, victim.guid);
        break;
      }
      case 'rename': {
        const target = nodes[edit.at % Math.max(1, nodes.length)];
        if (target !== undefined) target.title = `${device}-改名${edit.slot}`;
        break;
      }
      case 'move': {
        const node = nodes[edit.at % Math.max(1, nodes.length)];
        const dest = parents[edit.to % parents.length];
        if (node === undefined || dest === undefined || !isFolder(dest)) break;
        if (within(node, dest.guid) || dest.children.some((c) => c.guid === node.guid)) break;
        const detached = detachFrom(out, node.guid);
        if (detached !== null) dest.children.push(detached);
        break;
      }
      case 'reorder': {
        // 兄弟重排：需求 6.3 明确接受「同时重排同一文件夹」的取舍，
        // 但收敛性不能因此丢掉，所以这类编辑必须进入生成器。
        const parent = parents[edit.at % parents.length];
        if (parent === undefined || !isFolder(parent) || parent.children.length < 2) break;
        const from = edit.to % parent.children.length;
        const to = (from + 1) % parent.children.length;
        const [a, b] = [parent.children[from]!, parent.children[to]!];
        parent.children[from] = b;
        parent.children[to] = a;
        break;
      }
    }
  }

  return out;
}

/** 内容一致性判据。canonicalize 覆盖 GUID、标题、URL、父子关系与兄弟顺序。 */
const content = (roots: Roots): string => canonicalize(roots);

describe('双设备收敛（方案 7.2 第 5 条）', () => {
  it('两设备各自随机编辑后交替同步 2 轮，三方内容一致', () => {
    fc.assert(
      fc.property(rootsArb, editsArb, editsArb, (initial, editsA, editsB) => {
        // 两台设备都已与远端同步过一次，因此基线相同。
        let remote = cloneRoots(initial);
        const a: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };
        const b: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };

        a.local = applyEdits(a.local, editsA, 'a');
        b.local = applyEdits(b.local, editsB, 'b');

        for (let round = 0; round < 2; round++) {
          remote = syncOnce(a, remote);
          remote = syncOnce(b, remote);
        }

        expect(content(a.local)).toBe(content(remote));
        expect(content(b.local)).toBe(content(remote));
      }),
      { numRuns: 300 },
    );
  });

  it('收敛后再同步不产生任何操作（幂等，INV-4）', () => {
    fc.assert(
      fc.property(rootsArb, editsArb, editsArb, (initial, editsA, editsB) => {
        let remote = cloneRoots(initial);
        const a: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };
        const b: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };
        a.local = applyEdits(a.local, editsA, 'a');
        b.local = applyEdits(b.local, editsB, 'b');

        for (let round = 0; round < 2; round++) {
          remote = syncOnce(a, remote);
          remote = syncOnce(b, remote);
        }

        // 第三轮必须是空操作 —— 否则两台设备会无限互相推翻对方。
        for (const device of [a, b]) {
          const target = mergeTrees({ base: device.baseline, local: device.local, remote });
          expect(buildPlan(device.local, target)).toEqual([]);
          expect(content(target)).toBe(content(remote));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('无条目丢失：两侧编辑后仍存在的条目都出现在最终结果里', () => {
    fc.assert(
      fc.property(rootsArb, editsArb, editsArb, (initial, editsA, editsB) => {
        let remote = cloneRoots(initial);
        const a: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };
        const b: Device = { local: cloneRoots(initial), baseline: cloneRoots(initial) };
        a.local = applyEdits(a.local, editsA, 'a');
        b.local = applyEdits(b.local, editsB, 'b');

        // 两侧都还留着的条目，合并后绝不该消失（需求 6.2「只有一侧改动 → 直接采纳」）。
        const keptByBoth = [...indexRoots(a.local).keys()].filter((g) => indexRoots(b.local).has(g));

        for (let round = 0; round < 2; round++) {
          remote = syncOnce(a, remote);
          remote = syncOnce(b, remote);
        }

        const final = indexRoots(remote);
        for (const guid of keptByBoth) expect(final.has(guid), guid).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
