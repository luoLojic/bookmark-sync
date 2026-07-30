/**
 * domain/guard.ts —— 删除保护判定（FR-10 / 方案 4.1）。
 *
 * 两个阈值必须**同时**满足才触发：
 *   deletes > countThreshold  且  deletes / total > ratioThreshold
 *
 * 都是严格大于，不含等号 —— 需求写的是「> 10 个」且「> 10%」，所以恰好 10 个
 * 不触发、恰好 10% 也不触发。这两个边界各有单测，M5 验收还要再核对一遍。
 *
 * 为什么要「同时」：只看条数会让大书签库的正常整理频繁被打断（900 条里删 15 条
 * 很平常）；只看比例会让小书签库的一次小改动就报警（20 条里删 3 条就是 15%）。
 *
 * 两侧独立判定：任一侧触发即中止，side 告知 UI 该展示哪一侧的条目列表。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

export interface GuardInput {
  /** 将从浏览器删除的条目数（localOps 中 remove 的数量，文件夹按子树全部计入）。 */
  localDeletes: number;
  /** 本地树条目总数，作分母。 */
  localTotal: number;
  /** 相对远端快照将消失的条目数（remoteDelta 中的删除）。 */
  remoteDeletes: number;
  /** 远端快照条目总数，作分母。 */
  remoteTotal: number;
  /** 条数阈值，默认 10（需求第 10 节）。 */
  countThreshold: number;
  /** 比例阈值，默认 0.10。 */
  ratioThreshold: number;
}

export interface GuardSideStat {
  deletes: number;
  total: number;
  /** total 为 0 时记为 0，避免 NaN 流入界面。 */
  ratio: number;
  tripped: boolean;
}

export type GuardSide = 'local' | 'remote' | 'both';

export type GuardVerdict =
  | { tripped: false; local: GuardSideStat; remote: GuardSideStat }
  | { tripped: true; side: GuardSide; local: GuardSideStat; remote: GuardSideStat };

/** 计数规整：负数与小数都不该出现，真出现时向下取整并截到 0，绝不放宽保护。 */
function normalizeCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function evaluateSide(
  deletes: number,
  total: number,
  countThreshold: number,
  ratioThreshold: number,
): GuardSideStat {
  const d = normalizeCount(deletes);
  const t = normalizeCount(total);
  const ratio = t === 0 ? 0 : d / t;
  // 严格大于，见文件头说明。
  return { deletes: d, total: t, ratio, tripped: d > countThreshold && ratio > ratioThreshold };
}

export function checkGuard(input: GuardInput): GuardVerdict {
  const local = evaluateSide(
    input.localDeletes,
    input.localTotal,
    input.countThreshold,
    input.ratioThreshold,
  );
  const remote = evaluateSide(
    input.remoteDeletes,
    input.remoteTotal,
    input.countThreshold,
    input.ratioThreshold,
  );

  if (!local.tripped && !remote.tripped) return { tripped: false, local, remote };

  const side: GuardSide = local.tripped && remote.tripped ? 'both' : local.tripped ? 'local' : 'remote';
  return { tripped: true, side, local, remote };
}
