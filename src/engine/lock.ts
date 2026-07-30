/**
 * engine/lock.ts —— 单实例锁与僵死检测（NFR-10 / NFR-8）。
 *
 * 两层保护：
 *   内存锁   同一个 worker 里的并发调用，直接挡住；
 *   storage  worker 被杀后重启、或 popup 与 alarm 同时触发，靠 storage 标记挡住。
 *
 * 僵死检测（NFR-8）：worker 随时可能被终止，标记会留在 storage 里。超过阈值
 * 就视为上次同步已死，清除标记 —— **但绝不清除基线与映射**（INV-3）。
 * 这正是 floccus 缺陷二的教训：一次瞬时故障不该抹掉任何持久状态。
 */

import { STALE_SYNC_MS } from '../shared/config.js';
import { BusyError } from '../shared/errors.js';
import type { Phase, SyncKind, SyncState } from '../shared/types.js';

export interface LockStore {
  getSyncState(): Promise<SyncState | undefined>;
  setSyncState(state: SyncState): Promise<void>;
  clearSyncState(): Promise<void>;
}

export interface LockDeps {
  store: LockStore;
  now: () => number;
  /** 僵死判定阈值，默认 10 分钟（NFR-8）。 */
  staleMs?: number;
  onStale?: (state: SyncState) => void;
}

/** 进程内锁。模块级状态是有意的：一个 worker 只应有一个同步在跑。 */
let memoryLock: { runId: string } | null = null;

/** 仅供测试重置。生产代码不该调用。 */
export function resetMemoryLock(): void {
  memoryLock = null;
}

export interface LockHandle {
  runId: string;
  /** 更新阶段与进度，同时刷新 startedAt 以免长时间同步被误判僵死。 */
  update(phase: Phase, done: number, total: number): Promise<void>;
  release(): Promise<void>;
}

/**
 * 取锁。已有同步在跑时抛 BusyError（Fatal，UI 提示「已有同步正在进行」）。
 *
 * 注意 update 会刷新 startedAt。不刷新的话，一次 900 条书签的弱网同步跑过
 * 10 分钟就会被下一次调用判成僵死，两个同步就并行了。
 */
export async function acquireLock(
  kind: SyncKind,
  runId: string,
  deps: LockDeps,
): Promise<LockHandle> {
  const staleMs = deps.staleMs ?? STALE_SYNC_MS;

  if (memoryLock !== null) throw new BusyError();

  const existing = await deps.store.getSyncState();
  if (existing?.running === true) {
    const age = deps.now() - existing.startedAt;
    if (age <= staleMs) throw new BusyError();
    // 超过阈值：上次同步随 worker 一起没了。只清标记。
    deps.onStale?.(existing);
    await deps.store.clearSyncState();
  }

  memoryLock = { runId };

  const write = async (phase: Phase, done: number, total: number): Promise<void> => {
    await deps.store.setSyncState({
      running: true,
      startedAt: deps.now(),
      phase,
      done,
      total,
      runId,
      kind,
    });
  };

  await write('read', 0, 0);

  return {
    runId,
    async update(phase, done, total) {
      // 锁已被释放（或被别人抢走）时不再写，避免覆盖新一轮的状态。
      if (memoryLock?.runId !== runId) return;
      await write(phase, done, total);
    },
    async release() {
      if (memoryLock?.runId === runId) memoryLock = null;
      await deps.store.clearSyncState();
    },
  };
}

/**
 * 启动时清理僵死标记（NFR-8）。worker 重启后调用一次。
 * 返回是否清理过，供日志记录。
 */
export async function clearStaleLock(deps: LockDeps): Promise<boolean> {
  const staleMs = deps.staleMs ?? STALE_SYNC_MS;
  const existing = await deps.store.getSyncState();
  if (existing?.running !== true) return false;
  if (deps.now() - existing.startedAt <= staleMs) return false;
  deps.onStale?.(existing);
  await deps.store.clearSyncState();
  return true;
}

export function isLocked(): boolean {
  return memoryLock !== null;
}
