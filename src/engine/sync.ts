/**
 * engine/sync.ts —— 三种操作的编排（FR-1 / FR-2 / FR-3 / 方案 4.2）。
 *
 * 同步、上传、下载复用同一个提交状态机，只替换 MERGE 阶段的目标树算法。
 * 这不是为了少写代码，而是「三个操作的可靠性等价」的唯一保证 —— 各写一遍
 * 迟早会出现「上传路径漏了写后校验」这类不对称缺陷。
 *
 *   同步  T = merge(base, local, remote)
 *   上传  T = local            跳过删除保护（FR-12，弹窗已展示影响）
 *   下载  T = remote           同上；仍走 PUT 以推进 version，保持历史线性
 */

import { CONFIRM_LIST_LIMIT } from '../shared/config.js';
import { FirstSyncChoiceRequired } from '../shared/errors.js';
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
  return ({ base, local, remote, hasBaseline }): TargetComputation => {
    switch (req.kind) {
      case 'upload':
        // 本地整体覆盖远端。localOps 必然为空（目标就是本地现状）。
        return { target: local, skipGuard: true };

      case 'download':
        return { target: remote, skipGuard: true };

      case 'sync': {
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
