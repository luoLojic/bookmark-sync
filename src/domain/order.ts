/**
 * domain/order.ts —— 合并后 children 数组的顺序生成（需求 6.3 / 方案 2.5）。
 *
 * 顺序不做独立的冲突消解。规则只有三条：
 *   1. 以本地的顺序为骨架；
 *   2. 远端独有的新条目，插入到它在远端顺序中的前驱条目之后；找不到前驱则追加到末尾；
 *   3. 两侧都删除的条目直接移除。
 *
 * 已知代价（需求 6.3 明确接受）：两台设备同时重排同一文件夹时，以先同步者的
 * 顺序为准，另一方的重排会在下次同步时被覆盖。换来的是不必实现 floccus 那套
 * reconcileReorderings + reconcileConcurrentReorderings（约 600–800 行）。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import type { Guid } from './tree.js';

export interface OrderInput {
  /** 合并判定后确定保留的子项（方案 2.2 阶段 B 的 Keep 集合）。 */
  survivors: Iterable<Guid>;
  /** 该文件夹在本地树中的子项顺序。 */
  local: readonly Guid[];
  /** 该文件夹在远端快照中的子项顺序。 */
  remote: readonly Guid[];
}

/**
 * 生成目标树中某个文件夹的 children 顺序。
 *
 * 返回值恰好是 survivors 集合的一个排列：不含未存活项，不含重复项。
 */
export function mergeOrder(input: OrderInput): Guid[] {
  const survivors = new Set(input.survivors);
  const result: Guid[] = [];
  const placed = new Set<Guid>();

  // 规则 1 与规则 3：本地顺序作骨架，未存活项就地移除。
  for (const guid of input.local) {
    if (survivors.has(guid) && !placed.has(guid)) {
      result.push(guid);
      placed.add(guid);
    }
  }

  // 规则 2：按远端顺序处理远端独有的存活项。
  // 顺序遍历保证连续的多个远端新增项彼此保持远端相对顺序 —— 后一项会以前一项
  // 为前驱定位（前一项此时已入队）。
  for (let i = 0; i < input.remote.length; i++) {
    const guid = input.remote[i]!;
    if (!survivors.has(guid) || placed.has(guid)) continue;

    // 向前寻找最近的、已经落位的前驱。直接前驱可能已被删除（规则 3），
    // 此时继续往前退，尽量保持「在远端处于某项之后」这个相对关系。
    let insertAfter = -1;
    for (let j = i - 1; j >= 0; j--) {
      const at = result.indexOf(input.remote[j]!);
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
