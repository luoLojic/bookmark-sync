/**
 * test/engine/lock-race.test.ts —— 单实例锁的交错取锁与失败回滚（H-2 / M-3）。
 *
 * 现有的 concurrency.test.ts 只覆盖「先取到、再取一次被拒」这种**顺序**调用。
 * 审计指出的缺陷恰恰不在顺序路径上：原实现的顺序是
 *
 *     检查 memoryLock → await getSyncState() → 赋值 memoryLock
 *
 * 检查与赋值之间那个 await 是可打断点。定时 alarm 与用户手点同步几乎同时到达
 * 时，两者都能通过检查、都读到「无人在跑」，后者再覆盖前者的锁 —— 两个同步
 * 同时改浏览器书签与远端，而 NFR-10 要求同一时刻只有一个。
 *
 * 用「storage 读取故意慢一拍」来复现这个交错：真实的 chrome.storage.local
 * 每次调用都是一个真的异步跳转，本来就有这个窗口。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isLocked, resetMemoryLock } from '../../src/engine/lock.js';
import type { SyncState } from '../../src/shared/types.js';

beforeEach(() => {
  resetMemoryLock();
});

/** 可控延迟的锁存储：每个方法都在微任务队列里多绕几圈，放大交错窗口。 */
function slowLockStore(initial?: SyncState, hops = 3) {
  let state = initial;
  const yieldTimes = async (): Promise<void> => {
    for (let i = 0; i < hops; i++) await Promise.resolve();
  };
  return {
    store: {
      getSyncState: async (): Promise<SyncState | undefined> => {
        await yieldTimes();
        return state;
      },
      setSyncState: async (s: SyncState): Promise<void> => {
        await yieldTimes();
        state = s;
      },
      clearSyncState: async (): Promise<void> => {
        await yieldTimes();
        state = undefined;
      },
    },
    current: (): SyncState | undefined => state,
  };
}

describe('并发取锁只能有一个成功（NFR-10 / H-2）', () => {
  it('两个同时发起的取锁，一个成功一个 BusyError', async () => {
    const ls = slowLockStore();
    const results = await Promise.allSettled([
      acquireLock('sync', 'run-a', { store: ls.store, now: () => 1000 }),
      acquireLock('sync', 'run-b', { store: ls.store, now: () => 1000 }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'busy' });

    // storage 里的 runId 必须属于那个胜出者，不能是被拒者写进去的。
    const winner = (ok[0] as PromiseFulfilledResult<{ runId: string }>).value.runId;
    expect(ls.current()?.runId).toBe(winner);
  });

  it('五个同时发起的取锁，也只有一个成功', async () => {
    const ls = slowLockStore();
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd', 'e'].map((id) =>
        acquireLock('sync', `run-${id}`, { store: ls.store, now: () => 1000 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'busy' });
    }
  });

  it('手动同步与定时同步同时触发时只有一个进入', async () => {
    // 这就是真实触发场景：alarm 回调与 popup 的请求落在同一个 tick 附近。
    const ls = slowLockStore();
    const manual = acquireLock('sync', 'manual', { store: ls.store, now: () => 5000 });
    const scheduled = acquireLock('sync', 'alarm', { store: ls.store, now: () => 5000 });
    const settled = await Promise.allSettled([manual, scheduled]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('取锁失败必须归还内存锁（M-3）', () => {
  it('storage 写入失败时不留下内存锁', async () => {
    // 原实现在 memoryLock 赋值之后才写 storage，且没有 finally：写失败后锁永久
    // 留在内存里，此后该 worker 每次同步都报「已有同步正在进行」，而 storage 里
    // 并没有标记，僵死检测（只看 storage）也救不回来 —— 只能等 worker 被回收。
    const store = {
      getSyncState: async (): Promise<SyncState | undefined> => undefined,
      setSyncState: async (): Promise<void> => {
        throw new Error('QUOTA_BYTES quota exceeded');
      },
      clearSyncState: async (): Promise<void> => undefined,
    };

    await expect(acquireLock('sync', 'run-1', { store, now: () => 1000 })).rejects.toThrow(/quota/);
    expect(isLocked()).toBe(false);

    // 关键：下一次取锁必须还能成功。
    const ls = slowLockStore();
    await expect(
      acquireLock('sync', 'run-2', { store: ls.store, now: () => 2000 }),
    ).resolves.toMatchObject({ runId: 'run-2' });
  });

  it('storage 读取失败时也不留下内存锁', async () => {
    const store = {
      getSyncState: async (): Promise<SyncState | undefined> => {
        throw new Error('storage unavailable');
      },
      setSyncState: async (): Promise<void> => undefined,
      clearSyncState: async (): Promise<void> => undefined,
    };
    await expect(acquireLock('sync', 'run-1', { store, now: () => 1000 })).rejects.toThrow(
      /unavailable/,
    );
    expect(isLocked()).toBe(false);
  });

  it('清理僵死标记失败时也不留下内存锁', async () => {
    const stale: SyncState = {
      running: true,
      startedAt: 0,
      phase: 'applyLocal',
      done: 1,
      total: 9,
      runId: 'dead',
      kind: 'sync',
    };
    const store = {
      getSyncState: async (): Promise<SyncState | undefined> => stale,
      setSyncState: async (): Promise<void> => undefined,
      clearSyncState: async (): Promise<void> => {
        throw new Error('clear failed');
      },
    };
    await expect(
      acquireLock('sync', 'run-1', { store, now: () => 11 * 60 * 1000 }),
    ).rejects.toThrow(/clear failed/);
    expect(isLocked()).toBe(false);
  });

  it('因 BusyError 被拒的一方不会把胜出者的内存锁带走', async () => {
    const ls = slowLockStore();
    const held = await acquireLock('sync', 'winner', { store: ls.store, now: () => 1000 });
    await expect(
      acquireLock('sync', 'loser', { store: ls.store, now: () => 1000 }),
    ).rejects.toMatchObject({ code: 'busy' });
    // 被拒之后锁仍属于 winner —— 它还在跑，update 必须继续生效。
    expect(isLocked()).toBe(true);
    await held.update('merge', 1, 2);
    expect(ls.current()).toMatchObject({ runId: 'winner', phase: 'merge' });
  });
});

describe('release 只清自己的标记（compare-and-release）', () => {
  it('锁已被新一轮接手时，旧一轮的 release 不清除新状态', async () => {
    // 场景：第一轮被判僵死后新一轮接管；旧一轮此时才走到 release。
    // 无条件 clearSyncState 会让 popup 显示「就绪」而实际仍在跑，
    // 并且立刻放行第三个同步。
    const ls = slowLockStore();
    const first = await acquireLock('sync', 'run-old', { store: ls.store, now: () => 0 });

    // 模拟内存锁已随 worker 重启丢失，storage 标记被判僵死后由新一轮接管。
    resetMemoryLock();
    const second = await acquireLock('sync', 'run-new', {
      store: ls.store,
      now: () => 11 * 60 * 1000,
    });
    expect(ls.current()?.runId).toBe('run-new');

    await first.release();

    // 新一轮的标记必须还在。
    expect(ls.current()?.runId).toBe('run-new');
    expect(ls.current()?.running).toBe(true);

    await second.release();
    expect(ls.current()).toBeUndefined();
  });

  it('正常路径下 release 照常清除自己的标记', async () => {
    const ls = slowLockStore();
    const handle = await acquireLock('sync', 'run-1', { store: ls.store, now: () => 1000 });
    expect(ls.current()?.running).toBe(true);
    await handle.release();
    expect(ls.current()).toBeUndefined();
    expect(isLocked()).toBe(false);
  });
});
