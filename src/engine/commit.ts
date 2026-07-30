/**
 * engine/commit.ts —— 提交协议状态机（需求 5.3 / 方案第 4 节）。
 *
 * 九个步骤的顺序不可调整，每个状态转移都记日志，便于弱网现场诊断：
 *
 *   READ → MERGE → [GUARD] → APPLY_LOCAL → PUT_HISTORY → PUT_BOOKMARKS ★
 *                                                            ↓
 *                        WRITE_BASELINE ← PUT_INDEX ← VERIFY ┘
 *
 * ★ 是唯一的原子提交点。之前的一切都可以安全重来；它成功之后同步即算成功。
 *
 * ★ 之后不可再中止（方案 4 要点 3）：
 *   · VERIFY 通过即视为成功；
 *   · PUT_INDEX 失败只记警告（索引落后，下次提交会重写修复）；
 *   · WRITE_BASELINE 失败必须重试 —— 此刻的状态不一致窗口最危险。
 *
 * ★ 之后忽略取消请求（方案 4 要点 4）。之前允许取消，按瞬时错误处理（INV-3）。
 *
 * ★ 唯一写基线的地方就在本文件末尾（INV-1 / 方案 1.2 红线二）。
 */

import { BASELINE_WRITE_RETRIES, MAX_MERGE_ROUNDS, REMOTE_FILES } from '../shared/config.js';
import {
  AbortedError,
  ConflictError,
  DeleteGuardTripped,
  VerificationError,
  type GuardItem,
} from '../shared/errors.js';
import { countDeletions, deletedRecords, diff } from '../domain/diff.js';
import { checkGuard } from '../domain/guard.js';
import { computeContentHash, hashesEqual, type HashFn } from '../domain/hash.js';
import { buildPlan, countRemovals, summarizePlan, type LocalOp } from '../domain/plan.js';
import {
  ROOT_KEYS,
  countRoots,
  emptyRoots,
  emptySnapshot,
  indexRoots,
  makeSnapshot,
  totalEntries,
  type NodeRecord,
  type RootKey,
  type Roots,
  type Snapshot,
} from '../domain/tree.js';
import { decodeSnapshot, encodeJson, parseHistoryIndex } from '../remote/codec.js';
import { EMPTY_INDEX, appendToIndex, historyFileName } from '../remote/history.js';
import type { RemoteStore } from '../remote/store.js';
import { applyLocalPlan, readLocalTree, type BookmarksApi, type MappingTable } from '../platform/bookmarks.js';
import type { Config, HistoryIndex, Phase, RemoteCaps, ResultCounts, SyncKind } from '../shared/types.js';

/** 目标树的算法（方案 4.2：三种操作复用同一状态机，只换 MERGE 阶段的产物）。 */
export interface TargetComputation {
  /** 合并后的目标树。 */
  target: Roots;
  /** 是否跳过删除保护（上传/下载自带确认弹窗，FR-12）。 */
  skipGuard: boolean;
}

export interface CommitDeps {
  kind: SyncKind;
  store: RemoteStore;
  bookmarks: BookmarksApi;
  mapping: MappingTable;
  caps: RemoteCaps;
  config: Config;

  /** 注入的不纯来源，保证 domain 保持纯函数（红线一）。 */
  now: () => Date;
  nonce: () => string;
  hash: HashFn;
  newGuid: (type: 'bookmark' | 'folder') => string;

  loadBaseline: () => Promise<Snapshot | undefined>;
  /** ★ INV-1：唯一写基线处的落盘回调。 */
  saveBaseline: (snapshot: Snapshot) => Promise<void>;

  /**
   * 给定三棵树，算出目标树。sync / upload / download 在此分流（方案 4.2）。
   * hasBaseline 用于区分「基线是空树」与「没有基线」—— 后者要走首次同步
   * 的宽松匹配（需求 6.4），两者从 base 本身看不出来。
   */
  computeTarget: (input: {
    base: Roots;
    local: Roots;
    remote: Roots;
    hasBaseline: boolean;
  }) => TargetComputation;

  onPhase?: (phase: Phase, done: number, total: number) => void | Promise<void>;
  log?: { info: (m: string, ...a: unknown[]) => void; warn: (m: string, ...a: unknown[]) => void };
  signal?: AbortSignal;

  /** 崩溃注入（方案 7.4）：在指定阶段开始处抛错。仅测试使用。 */
  crashAfter?: Phase;
  /**
   * 崩溃注入：应用本地改动到第 N 条时抛错。仅测试使用。
   * 单独一个开关是必要的 —— INV-4 的第一个崩溃点是「应用本地改动的中途」，
   * 阶段级注入只能停在阶段边界，测不到「部分已应用」这个状态。
   */
  crashAfterOps?: number;
}

export interface CommitOutcome {
  result: ResultCounts;
  /** 本轮是否真的写了远端。无变化短路时为 false（FR-14）。 */
  uploaded: boolean;
  /** 用掉的合并轮次（FR-17）。 */
  rounds: number;
  phase: Phase;
}

class CrashInjected extends Error {}

/** 远端 bookmarks 文件名。压缩开关决定后缀（方案 3.2）。 */
function bookmarksPath(caps: RemoteCaps): string {
  return caps.suffix === '.json.gz' ? `${REMOTE_FILES.bookmarks}.gz` : REMOTE_FILES.bookmarks;
}

function otherPath(caps: RemoteCaps): string {
  return caps.suffix === '.json.gz' ? REMOTE_FILES.bookmarks : `${REMOTE_FILES.bookmarks}.gz`;
}

export async function runCommit(deps: CommitDeps): Promise<CommitOutcome> {
  let rounds = 0;
  let lastConflict: Error | undefined;

  // 外层重试轮：412 或写后校验失败时整体回到 READ（FR-17，最多 3 轮）。
  // 与 HTTP 层的重试严格分开 —— 这里重试的是逻辑冲突，不是网络抖动。
  while (rounds < MAX_MERGE_ROUNDS) {
    rounds++;
    try {
      return { ...(await runOnce(deps, rounds)), rounds };
    } catch (error) {
      if (error instanceof ConflictError || error instanceof VerificationError) {
        lastConflict = error;
        deps.log?.warn(`第 ${rounds} 轮遇到冲突，回到 READ 重新合并`, error);
        continue;
      }
      throw error;
    }
  }

  // 轮次用尽：如实报错让用户重试，不硬写覆盖别人的提交。
  throw lastConflict ?? new ConflictError('合并轮次用尽');
}

async function runOnce(deps: CommitDeps, round: number): Promise<Omit<CommitOutcome, 'rounds'>> {
  const at = async (phase: Phase, done = 0, total = 0): Promise<void> => {
    deps.log?.info(`[${phase}] 第 ${round} 轮`);
    await deps.onPhase?.(phase, done, total);
    if (deps.crashAfter === phase) throw new CrashInjected(`crash injected after ${phase}`);
  };

  const abortIfRequested = (): void => {
    // ★ 之前允许取消，按瞬时错误处理（INV-3：不清任何状态）。
    if (deps.signal?.aborted === true) throw new AbortedError();
  };

  // ── READ ────────────────────────────────────────────────────────────
  await at('read');
  abortIfRequested();

  const remoteRead = await readRemoteSnapshot(deps);
  const localRead = await readLocalTree(deps.bookmarks, deps.mapping, deps.newGuid);
  for (const warning of localRead.warnings) deps.log?.warn(warning);

  const storedBaseline = await deps.loadBaseline();
  const baseline = storedBaseline ?? emptySnapshot();

  // ── MERGE（纯计算，无副作用） ────────────────────────────────────────
  await at('merge');
  abortIfRequested();

  const remoteRoots = remoteRead.snapshot?.roots ?? emptyRoots();
  const { target, skipGuard } = deps.computeTarget({
    base: baseline.roots,
    local: localRead.roots,
    remote: remoteRoots,
    hasBaseline: storedBaseline !== undefined,
  });

  const localOps = buildPlan(localRead.roots, target);
  const remoteDelta = diff(remoteRoots, target);
  const targetHash = computeContentHash(target, deps.hash);

  // ── GUARD（位于 APPLY_LOCAL 之前，此时尚无任何副作用） ────────────────
  if (!skipGuard) {
    await at('guard');
    const verdict = checkGuard({
      localDeletes: countRemovals(localOps),
      localTotal: totalEntries(localRead.roots),
      remoteDeletes: countDeletions(remoteDelta),
      remoteTotal: totalEntries(remoteRoots),
      countThreshold: deps.config.deleteGuardCount,
      ratioThreshold: deps.config.deleteGuardRatio,
    });
    if (verdict.tripped) {
      deps.log?.warn(`删除保护触发：${verdict.side}`, verdict.local, verdict.remote);
      throw new DeleteGuardTripped({
        side: verdict.side,
        localDeletes: verdict.local.deletes,
        localTotal: verdict.local.total,
        remoteDeletes: verdict.remote.deletes,
        remoteTotal: verdict.remote.total,
        ...collectGuardItems(verdict.side, localRead.roots, localOps, remoteDelta),
      });
    }
  }

  // 无变化短路（FR-14 / 方案第 4 节）。
  const remoteUnchanged =
    remoteRead.snapshot !== null && hashesEqual(targetHash, remoteRead.snapshot.contentHash);

  // ── APPLY_LOCAL ─────────────────────────────────────────────────────
  let applied = { created: 0, updated: 0, moved: 0, removed: 0, reordered: 0 };
  if (localOps.length > 0) {
    await at('applyLocal', 0, localOps.length);
    abortIfRequested();
    applied = await applyLocalPlan(deps.bookmarks, localOps, {
      mapping: deps.mapping,
      rootIds: localRead.rootIds,
      onProgress: (done, total) => {
        void deps.onPhase?.('applyLocal', done, total);
        if (deps.crashAfterOps !== undefined && done >= deps.crashAfterOps) {
          throw new CrashInjected(`crash injected after ${done} local ops`);
        }
      },
    });
    deps.log?.info('本地改动已应用', summarizePlan(localOps));
  }

  const nextVersion = (remoteRead.snapshot?.version ?? 0) + 1;
  const writtenAt = deps.now().toISOString();
  const snapshot = makeSnapshot(target, {
    version: nextVersion,
    writerNonce: deps.nonce(),
    writtenAt,
    writtenBy: deps.config.deviceName,
    contentHash: targetHash,
  });

  if (remoteUnchanged) {
    // 远端内容已经等于目标：跳过三个 PUT，但基线仍需更新 —— 远端 version
    // 可能已被其他设备推进（方案第 4 节「无变化短路」）。
    deps.log?.info('远端内容无变化，跳过写入');
    await writeBaseline(deps, remoteRead.snapshot ?? snapshot, at);
    return {
      result: countsOf(target, applied, remoteRead.snapshot?.version ?? 0),
      uploaded: false,
      phase: 'done',
    };
  }

  // ── PUT_HISTORY（步骤 5，先于原子提交点） ─────────────────────────────
  // 幂等、重复写无害。若步骤 6 失败，远端只多一个无人引用的孤儿历史文件。
  await at('putHistory');
  abortIfRequested();
  const historyFile = historyFileName(nextVersion, writtenAt, deps.caps.suffix);
  const snapshotBytes = await encodeJson(snapshot, deps.config.compress);
  await deps.store.put(historyFile, snapshotBytes);

  // ── PUT_BOOKMARKS ★ 原子提交点（步骤 6） ─────────────────────────────
  await at('putBookmarks');
  abortIfRequested(); // ★ 之前最后一次允许取消

  const path = bookmarksPath(deps.caps);
  const putOpts: { ifMatch?: string } = {};
  if (deps.caps.ifMatch && remoteRead.etag !== undefined) {
    putOpts.ifMatch = remoteRead.etag;
  }
  const put = await deps.store.put(path, snapshotBytes, putOpts);

  // ── VERIFY（步骤 7） ────────────────────────────────────────────────
  // 此后不再检查取消：★ 已经成功，必须走到终态（方案 4 要点 4）。
  await at('verify');
  await verifyCommit(deps, path, snapshot, put.etag);

  // ── PUT_INDEX（步骤 8，尽力而为） ────────────────────────────────────
  await at('putIndex');
  try {
    await putHistoryIndex(deps, snapshot, historyFile);
  } catch (error) {
    // 失败只导致历史列表少几项，下次成功提交会重写修复（需求 5.3 关键点）。
    deps.log?.warn('历史索引更新失败，不影响本次同步', error);
  }

  // ── WRITE_BASELINE（步骤 9，终态） ──────────────────────────────────
  await writeBaseline(deps, snapshot, at);

  return {
    result: countsOf(target, applied, nextVersion),
    uploaded: true,
    phase: 'done',
  };
}

// ── 各步骤实现 ────────────────────────────────────────────────────────

interface RemoteRead {
  snapshot: Snapshot | null;
  etag?: string;
}

/**
 * 读远端快照。双后缀探测（方案 3.2）：先按 caps 记录的后缀，404 再试另一个。
 * 这样用户中途切换压缩开关不会导致「远端明明有数据却当成首次同步」。
 */
async function readRemoteSnapshot(deps: CommitDeps): Promise<RemoteRead> {
  for (const path of [bookmarksPath(deps.caps), otherPath(deps.caps)]) {
    const got = await deps.store.get(path);
    if (got === null) continue;
    const snapshot = await decodeSnapshot(got.bytes);
    deps.log?.info(`远端快照 version=${snapshot.version} 来自 ${path}`);
    return got.etag === undefined ? { snapshot } : { snapshot, etag: got.etag };
  }
  deps.log?.info('远端没有快照，按首次上传处理');
  return { snapshot: null };
}

/**
 * 写后校验（步骤 7 / NFR-4）。
 *
 * 支持条件写时，ETag 变化本身就说明写入生效；但内容截断不会改变 ETag 的
 * 存在性，所以仍要重新读回比对 contentHash。
 * 降级模式下（FR-18）靠 writerNonce 判断有没有被别人并发覆盖。
 */
async function verifyCommit(
  deps: CommitDeps,
  path: string,
  written: Snapshot,
  putEtag: string | undefined,
): Promise<void> {
  const got = await deps.store.get(path);
  if (got === null) throw new VerificationError('写入后读不到 bookmarks 文件');

  const readBack = await decodeSnapshot(got.bytes);

  if (!hashesEqual(readBack.contentHash, written.contentHash)) {
    throw new VerificationError('写后校验失败：读回的内容哈希与写入不一致');
  }

  if (!deps.caps.ifMatch) {
    // 降级模式：nonce 不是自己的，说明这中间有别的设备提交并覆盖了（FR-18）。
    if (readBack.writerNonce !== written.writerNonce) {
      throw new VerificationError('降级模式写后校验失败：远端已被其他设备覆盖');
    }
  }

  deps.log?.info(`写后校验通过 version=${readBack.version} etag=${putEtag ?? got.etag ?? '(无)'}`);
}

async function putHistoryIndex(deps: CommitDeps, snapshot: Snapshot, file: string): Promise<void> {
  const existing = await deps.store.get(REMOTE_FILES.historyIndex);
  let index: HistoryIndex = EMPTY_INDEX;
  if (existing !== null) {
    const { decodeJson } = await import('../remote/codec.js');
    index = parseHistoryIndex(await decodeJson(existing.bytes));
  }
  const counts = countRoots(snapshot.roots);
  const next = appendToIndex(index, {
    version: snapshot.version,
    writtenAt: snapshot.writtenAt,
    writtenBy: snapshot.writtenBy,
    bookmarks: counts.bookmarks,
    folders: counts.folders,
    file,
  });
  // 索引始终明文：设置页要读它，压缩省下的几 KB 不值得多一层解压。
  await deps.store.put(REMOTE_FILES.historyIndex, await encodeJson(next, false));
}

/**
 * ★ 写基线 —— INV-1 的唯一落盘点（方案 1.2 红线二）。
 *
 * 此刻远端已提交成功，状态不一致窗口最危险，因此单独给 3 次重试
 * （方案 4 要点 3）。失败到底才抛错。
 */
async function writeBaseline(
  deps: CommitDeps,
  snapshot: Snapshot,
  at: (phase: Phase) => Promise<void>,
): Promise<void> {
  await at('writeBaseline');
  let lastError: unknown;
  for (let attempt = 1; attempt <= BASELINE_WRITE_RETRIES; attempt++) {
    try {
      await deps.saveBaseline(snapshot);
      return;
    } catch (error) {
      lastError = error;
      deps.log?.warn(`写基线失败（第 ${attempt} 次）`, error);
    }
  }
  throw lastError;
}

// ── 辅助 ─────────────────────────────────────────────────────────────

function countsOf(
  target: Roots,
  applied: { created: number; updated: number; moved: number; removed: number },
  version: number,
): ResultCounts {
  return {
    local: countRoots(target),
    remote: countRoots(target),
    created: applied.created,
    updated: applied.updated,
    moved: applied.moved,
    removed: applied.removed,
    uploaded: true,
    version,
  };
}

/** 为确认弹窗收集将要删除的条目（FR-10：至多 20 条）。 */
function collectGuardItems(
  side: 'local' | 'remote' | 'both',
  localRoots: Roots,
  localOps: readonly LocalOp[],
  remoteDelta: ReturnType<typeof diff>,
): { items: GuardItem[]; itemsTruncated: number } {
  const records: NodeRecord[] = [];

  if (side === 'local' || side === 'both') {
    const index = indexRoots(localRoots);
    for (const op of localOps) {
      if (op.kind !== 'remove') continue;
      const rec = index.get(op.guid);
      if (rec !== undefined) records.push(rec);
    }
  }
  if (side === 'remote' || side === 'both') {
    records.push(...deletedRecords(remoteDelta));
  }

  const paths = pathIndex(localRoots);
  const items: GuardItem[] = records.slice(0, 20).map((rec) => {
    const item: GuardItem = { title: rec.title, path: paths.get(rec.guid) ?? '' };
    if (rec.url !== undefined) item.url = rec.url;
    return item;
  });
  return { items, itemsTruncated: Math.max(0, records.length - items.length) };
}

/** GUID → 可读路径，用于弹窗里显示条目位置。 */
function pathIndex(roots: Roots): Map<string, string> {
  const out = new Map<string, string>();
  const rootLabel: Record<RootKey, string> = { bar: roots.bar.title, other: roots.other.title };
  for (const key of ROOT_KEYS) {
    const walkInto = (children: Roots[RootKey]['children'], prefix: string): void => {
      for (const node of children) {
        out.set(node.guid, prefix);
        if (node.type === 'folder') walkInto(node.children, `${prefix}${node.title}/`);
      }
    };
    walkInto(roots[key].children, `${rootLabel[key]}/`);
  }
  return out;
}

export { CrashInjected };
