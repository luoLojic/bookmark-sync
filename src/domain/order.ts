/**
 * domain/order.ts —— 合并后 children 数组的顺序生成（需求 6.3 / 方案 2.5）。
 *
 * 需求 6.3 的三条规则：
 *   1. 以**改动过顺序的那一侧**为骨架；
 *   2. 另一侧独有的新条目，插入到它在那一侧顺序中的前驱之后；找不到前驱则追加末尾；
 *   3. 两侧都删除的条目直接移除。
 *
 * 规则 1 的措辞是本实现对需求的一处修正。需求原文写的是「以本地的顺序为骨架」，
 * 但无条件偏向本地不收敛：两台设备各自在同一文件夹追加一条书签，是最常见的
 * 并发编辑，而每台设备都会把对方的顺序改回自己的，导致
 *
 *     A: [a, b]   B: [b, a]   A: [a, b]   B: [b, a]   …
 *
 * 无限乒乓。副作用不止是顺序不稳：每轮同步都判定「内容有变化」，于是每次定时
 * 同步都写一份历史快照，FR-14 的无变化短路永远不生效。
 *
 * 改为三方判定后（拿本地顺序与基线比，只有真改过才当骨架），需求 6.3 自己写的
 * 那句「最终以先同步者的顺序为准，另一方的重排会在下次同步时被覆盖」才真正成立：
 * 先同步的一方改动过顺序，它是骨架；后同步的一方没动过顺序，采纳对方的。
 * 两侧都改过时仍以本地为准 —— 这仍是需求接受的取舍。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import type { Guid } from './tree.js';

export interface OrderInput {
  /** 合并判定后确定保留的子项（方案 2.2 阶段 B 的 Keep 集合）。 */
  survivors: Iterable<Guid>;
  /** 该文件夹在基线中的子项顺序。用于判断哪一侧真的动过顺序。 */
  base: readonly Guid[];
  /** 该文件夹在本地树中的子项顺序。 */
  local: readonly Guid[];
  /** 该文件夹在远端快照中的子项顺序。 */
  remote: readonly Guid[];
}

function sameSequence(a: readonly Guid[], b: readonly Guid[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

/**
 * 两个序列在其公共元素上的相对顺序是否不同。
 *
 * 只比公共元素：一侧新增或删除条目不算「重排」，否则任何一次追加都会被当作
 * 顺序改动，又回到无条件偏向本地的老问题。
 */
function reorderedAgainst(side: readonly Guid[], base: readonly Guid[]): boolean {
  const inBase = new Set(base);
  const inSide = new Set(side);
  return !sameSequence(
    side.filter((g) => inBase.has(g)),
    base.filter((g) => inSide.has(g)),
  );
}

/**
 * 生成目标树中某个文件夹的 children 顺序。
 *
 * 返回值恰好是 survivors 集合的一个排列：不含未存活项，不含重复项。
 */
export function mergeOrder(input: OrderInput): Guid[] {
  const survivors = new Set(input.survivors);

  // 规则 1：谁改过顺序谁当骨架；都改过时以本地为准（需求 6.3 的取舍）。
  const localMoved = reorderedAgainst(input.local, input.base);
  const skeleton = localMoved ? input.local : input.remote;
  const other = localMoved ? input.remote : input.local;

  const result: Guid[] = [];
  const placed = new Set<Guid>();

  // 骨架侧的存活项按原序落位，未存活项就地移除（规则 3）。
  for (const guid of skeleton) {
    if (survivors.has(guid) && !placed.has(guid)) {
      result.push(guid);
      placed.add(guid);
    }
  }

  // 规则 2：另一侧独有的存活项，按其在该侧的前驱定位。
  // 顺序遍历保证连续的多个新增项彼此保持相对顺序 —— 后一项会以前一项为前驱
  // 定位（前一项此时已入队）。
  for (let i = 0; i < other.length; i++) {
    const guid = other[i]!;
    if (!survivors.has(guid) || placed.has(guid)) continue;

    // 向前寻找最近的、已经落位的前驱。直接前驱可能已被删除（规则 3），
    // 此时继续往前退，尽量保持「处于某项之后」这个相对关系。
    let insertAfter = -1;
    for (let j = i - 1; j >= 0; j--) {
      const at = result.indexOf(other[j]!);
      if (at >= 0) {
        insertAfter = at;
        break;
      }
    }

    if (insertAfter >= 0) result.splice(insertAfter + 1, 0, guid);
    else result.push(guid); // 找不到前驱则追加到末尾（规则 2 后半句）。
    placed.add(guid);
  }

  // 两侧顺序都未提及的存活项。正常来自复活的祖先文件夹
  // （方案 2.4 resurrectAncestors），它可能只存在于 base。
  for (const guid of survivors) {
    if (!placed.has(guid)) {
      result.push(guid);
      placed.add(guid);
    }
  }

  return result;
}
