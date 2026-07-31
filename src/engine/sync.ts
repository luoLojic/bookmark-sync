/**
 * engine/sync.ts —— 三种操作的编排（FR-1 / FR-2 / FR-3 / 方案 4.2）。
 *
 * 同步、上传、下载复用同一个提交状态机，只替换 MERGE 阶段的目标树算法。
 * 这不是为了少写代码，而是「三个操作的可靠性等价」的唯一保证 —— 各写一遍
 * 迟早会出现「上传路径漏了写后校验」这类不对称缺陷。
 *
 *   同步  T = merge(base, local, remote)
 *   上传  T = local            跳过删除保护（FR-12，弹窗已展示影响）
 *   下载  T = remote           同上；远端内容不变时走无变化短路，不写新版本
 *
 * 三者都必须先分辨「远端文件不存在」与「远端是一棵空树」。前者不代表远端删空
 * 了书签，而代表本设备的基线不属于这个远端 —— 见 case 'sync' 里的说明。
 */

import { CONFIRM_LIST_LIMIT } from '../shared/config.js';
import { FirstSyncChoiceRequired, RemoteSnapshotMissing } from '../shared/errors.js';
import { diff, deletedRecords } from '../domain/diff.js';
import { applyGuidMapping, matchFirstSync } from '../domain/firstsync.js';
import { mergeTrees } from '../domain/merge.js';
import { countRoots, emptyRoots, type Roots } from '../domain/tree.js';
import { runCommit, type CommitDeps, type CommitOutcome, type TargetComputation } from './commit.js';

/** 首次同步的三种选择（FR-4）。与 ui/messages.ts 的 FirstSyncChoice 一致。 */
export type FirstSyncChoice = 'merge' | 'useLocal' | 'useRemote';

export type SyncRequest =
  | { kind: 'sync'; skipDeleteGuard?: boolean; firstSyncChoice?: FirstSyncChoice }
  | { kind: 'upload' }
  | { kind: 'download' };

export type EngineDeps = Omit<CommitDeps, 'kind' | 'computeTarget'>;

/**
 * 首次同步的「合并」：先按需求 6.4 的宽松规则统一 GUID，再以空树为基线三方合并。
 * 不先匹配的话，同一条书签会因两侧 GUID 不同而各留一份。
 */
export function mergeFirstSync(local: Roots, remote: Roots): Roots {
  const { mapping } = matchFirstSync(local, remote);
  return mergeTrees({ base: emptyRoots(), local: applyGuidMapping(local, mapping), remote });
}

function isEmptyTree(roots: Roots): boolean {
  return roots.bar.children.length === 0 && roots.other.children.length === 0;
}

function computeTargetFor(req: SyncRequest): CommitDeps['computeTarget'] {
  return ({ base, local, remote, hasBaseline, remoteExists }): TargetComputation => {
    switch (req.kind) {
      case 'upload':
        // 本地整体覆盖远端。localOps 必然为空（目标就是本地现状）。
        return { target: local, skipGuard: true };

      case 'download':
        // 远端文件不存在时不能把本地清空 —— 那不是「远端删了一切」，
        // 而是没有可下载的内容。交给调用方报错，别默默毁掉本地。
        if (!remoteExists) throw new RemoteSnapshotMissing();
        return { target: remote, skipGuard: true };

      case 'sync': {
        // ★ 远端快照不存在时，必须区分「从没同步过」与「基线不属于这个远端」。
        //
        // 若把「文件不存在」折叠成「远端是一棵空树」，三方合并会把每一条
        // 「基线有、本地未改」的条目判成「仅远端删除」而删掉本地 —— 换远端
        // 地址、改基础路径、远端文件被误删都会触发。而且全量删除的比例恒为
        // 100%，条目总数 ≤ 阈值条数的用户连删除保护都拦不住（guard 要求条数
        // 与比例同时超标）。协议层这两种状态本来可区分，折叠掉才丢了信息。
        if (!remoteExists) {
          // 有基线却读不到远端：本设备曾与某个远端达成一致，现在那份数据不在
          // 了。不能猜用户想要哪个方向 —— 上传会用本地覆盖（若其实是地址填错，
          // 就在错误的位置建了一份垃圾数据并推进历史），合并会删空本地。中止
          // 并让用户核对配置，需要重建远端时显式点「上传」。
          if (hasBaseline) throw new RemoteSnapshotMissing();
          // 没有基线也没有远端：干净的首次上传，本地就是目标。删除保护照常跑
          // ——「目标 = 本地」且远端为空，两侧删除数都是 0，它必然通过，但保持
          // 九步序列完整比省掉一次空转更重要。
          return { target: local, skipGuard: req.skipDeleteGuard === true };
        }

        if (!hasBaseline && !isEmptyTree(local) && !isEmptyTree(remote)) {
          // 新设备接入且两侧都有内容 —— 必须让用户选（FR-4）。
          const choice = req.firstSyncChoice;
          if (choice === undefined) {
            const merged = mergeFirstSync(local, remote);
            const lc = countRoots(local);
            const rc = countRoots(remote);
            const mc = countRoots(merged);
            throw new FirstSyncChoiceRequired({
              localBookmarks: lc.bookmarks,
              localFolders: lc.folders,
              remoteBookmarks: rc.bookmarks,
              remoteFolders: rc.folders,
              mergedBookmarks: mc.bookmarks,
              mergedFolders: mc.folders,
            });
          }
          if (choice === 'useLocal') return { target: local, skipGuard: true };
          if (choice === 'useRemote') return { target: remote, skipGuard: true };
          // 首次合并没有基线可比，删除保护的分母不成立，跳过（与上传下载同理）。
          return { target: mergeFirstSync(local, remote), skipGuard: true };
        }

        return {
          target: mergeTrees({ base, local, remote }),
          skipGuard: req.skipDeleteGuard === true,
        };
      }
    }
  };
}

export async function runSync(req: SyncRequest, deps: EngineDeps): Promise<CommitOutcome> {
  return runCommit({
    ...deps,
    kind: req.kind,
    computeTarget: computeTargetFor(req),
  });
}

// ── 预览（FR-2 / FR-3，纯读不写） ─────────────────────────────────────

export interface PreviewInput {
  local: Roots;
  remote: Roots;
}

export interface PreviewResult {
  localCounts: { bookmarks: number; folders: number };
  remoteCounts: { bookmarks: number; folders: number };
  /** 将要丢失的条目数。 */
  losing: number;
  items: { title: string; url?: string; path: string }[];
  itemsTruncated: number;
}

/**
 * 算出上传或下载会丢掉什么（FR-2 / FR-3 的弹窗数据）。
 *
 * 纯计算，不碰远端也不碰本地 —— 用户还没确认，任何副作用都不该发生。
 * 「丢失」的定义是「在被覆盖的那一侧存在、覆盖后不再存在」。
 */
export function previewOverwrite(op: 'upload' | 'download', input: PreviewInput): PreviewResult {
  const target = op === 'upload' ? input.local : input.remote;
  const victim = op === 'upload' ? input.remote : input.local;

  const lost = deletedRecords(diff(victim, target));
  const items = lost.slice(0, CONFIRM_LIST_LIMIT).map((rec) => {
    const item: { title: string; url?: string; path: string } = { title: rec.title, path: '' };
    if (rec.url !== undefined) item.url = rec.url;
    return item;
  });

  return {
    localCounts: countRoots(input.local),
    remoteCounts: countRoots(input.remote),
    losing: lost.length,
    items,
    itemsTruncated: Math.max(0, lost.length - items.length),
  };
}
