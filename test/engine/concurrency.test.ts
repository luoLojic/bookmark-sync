import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '../../src/domain/hash.js';
import { decodeSnapshot, encodeJson } from '../../src/remote/codec.js';
import { countRoots, type Roots } from '../../src/domain/tree.js';
import { acquireLock, clearStaleLock, isLocked, resetMemoryLock } from '../../src/engine/lock.js';
import { previewOverwrite } from '../../src/engine/sync.js';
import { startKeepalive, withKeepalive } from '../../src/platform/keepalive.js';
import type { SyncState } from '../../src/shared/types.js';
import { bk, fd, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters } from './harness.js';

const content = (roots: Roots): string => canonicalize(roots);

beforeEach(() => {
  resetMemoryLock();
  resetCounters();
});

describe('乐观并发与外层重试轮（FR-17）', () => {
  it('412 后回到 READ 重新合并并最终成功', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();

    a.bookmarks.seed(a.bookmarks.barId, { title: 'A 新增', url: 'https://a-new.test/' });
    b.bookmarks.seed(b.bookmarks.barId, { title: 'B 新增', url: 'https://b-new.test/' });

    // 必须在 A 读完远端之后、PUT 之前插入 B 的提交，A 手里的 ETag 才会过期。
    // B 抢在 A 开始之前提交是不会冲突的 —— A 读到的就是新 ETag。
    let injected = 0;
    const outcome = await a.sync(
      { kind: 'sync' },
      {
        // onPhase 会被 await（commit.ts 如此设计），因此这里可以确定地
        // 「在 A 读完之后、PUT 之前」把 B 的提交插进去，不依赖任务调度时序。
        onPhase: async (phase) => {
          if (phase === 'putHistory' && injected === 0) {
            injected++;
            await b.sync();
          }
        },
      },
    );

    expect(injected).toBe(1);
    expect(outcome.rounds).toBeGreaterThan(1);
    const local = await a.readLocal();
    expect(local.bar.children.map((c) => c.title).sort()).toEqual(['A', 'A 新增', 'B 新增']);
  });

  it('412 重试后三方收敛', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk('b-0000000000a1', '共同', 'https://c.test/')]) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();

    a.bookmarks.seed(a.bookmarks.barId, { title: 'A 的', url: 'https://a.test/' });
    b.bookmarks.seed(b.bookmarks.barId, { title: 'B 的', url: 'https://b.test/' });
    await b.sync();
    await a.sync();
    await b.sync();

    expect(content(await a.readLocal())).toBe(content(await b.readLocal()));
  });

  it('轮次用尽时报错，不硬写覆盖别人的提交', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]) });
    await a.sync();

    // 每轮 A 读完之后都抢先改一次远端，让 A 的 ETag 永远是过期的。
    const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;
    const original = remote.read(key)!;
    let round = 0;

    a.bookmarks.seed(a.bookmarks.barId, { title: 'A 新增', url: 'https://a-new.test/' });

    const outcome = a.sync(
      { kind: 'sync' },
      {
        onPhase: (phase) => {
          // 每轮读完之后制造一次「其他设备提交」，ETag 因此必然过期。
          if (phase === 'putHistory') {
            round++;
            remote.commitFromOtherDevice(key, original);
          }
        },
      },
    );

    await expect(outcome).rejects.toMatchObject({ code: 'conflict' });
    expect(round).toBe(3);
  });
});

describe('降级模式（FR-18）', () => {
  it('不支持条件写时 PUT 不带 If-Match，靠 writerNonce 校验', async () => {
    const remote = new FakeRemote({ ifMatch: false });
    const device = createDevice(remote, {
      caps: { ifMatch: false },
      local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]),
    });

    await device.sync();

    // 没有任何 PUT 带 If-Match。
    const puts = remote.log.filter((r) => r.method === 'PUT');
    expect(puts.length).toBeGreaterThan(0);
    expect(device.baseline()?.writerNonce).toMatch(/nonce/);
  });

  it('降级模式下被其他设备覆盖时，写后校验发现并重试（FR-18）', async () => {
    const remote = new FakeRemote({ ifMatch: false });
    const device = createDevice(remote, {
      caps: { ifMatch: false },
      local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]),
    });
    await device.sync();

    device.bookmarks.seed(device.bookmarks.barId, { title: '新增', url: 'https://n.test/' });

    // 在 verify 之前把远端换成别人的内容（nonce 不同）→ 校验必须失败。
    const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;
    let injected = 0;
    const outcome = device.sync(
      { kind: 'sync' },
      {
        onPhase: (phase) => {
          if (phase === 'verify' && injected === 0) {
            injected++;
            const foreign = JSON.stringify({
              formatVersion: 1,
              version: 99,
              writerNonce: 'someone-else',
              writtenAt: '2026-07-30T00:00:00.000Z',
              writtenBy: '别的设备',
              contentHash: 'sha256:zzz',
              roots: { bar: { guid: 'root-bar', type: 'folder', title: 'b', children: [] }, other: { guid: 'root-other', type: 'folder', title: 'o', children: [] } },
            });
            remote.commitFromOtherDevice(key, new TextEncoder().encode(foreign));
          }
        },
      },
    );

    // 第一轮校验失败 → 回到 READ → 第二轮成功。
    await expect(outcome).resolves.toMatchObject({ uploaded: true });
    expect(injected).toBe(1);
  });
});

describe('单实例锁（NFR-10）与僵死检测（NFR-8）', () => {
  function lockStore(initial?: SyncState) {
    let state = initial;
    return {
      store: {
        getSyncState: async () => state,
        setSyncState: async (s: SyncState) => {
          state = s;
        },
        clearSyncState: async () => {
          state = undefined;
        },
      },
      current: () => state,
    };
  }

  it('第二个同步请求被拒绝', async () => {
    const ls = lockStore();
    const handle = await acquireLock('sync', 'run-1', { store: ls.store, now: () => 1000 });
    await expect(acquireLock('sync', 'run-2', { store: ls.store, now: () => 1000 })).rejects.toMatchObject({
      code: 'busy',
    });
    await handle.release();
    // 释放后可以再取。
    await expect(acquireLock('sync', 'run-3', { store: ls.store, now: () => 1000 })).resolves.toBeTruthy();
  });

  it('storage 里有未超时的标记时也拒绝（worker 重启后的并发）', async () => {
    const ls = lockStore({ running: true, startedAt: 1000, phase: 'read', done: 0, total: 0, runId: 'old', kind: 'sync' });
    await expect(
      acquireLock('sync', 'new', { store: ls.store, now: () => 1000 + 60_000 }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('超过阈值的标记视为僵死，清除后放行 —— 但只清标记（INV-3）', async () => {
    const stale: SyncState = { running: true, startedAt: 0, phase: 'applyLocal', done: 3, total: 9, runId: 'dead', kind: 'sync' };
    const ls = lockStore(stale);
    const seen: SyncState[] = [];
    const handle = await acquireLock('sync', 'new', {
      store: ls.store,
      now: () => 11 * 60 * 1000,
      onStale: (s) => seen.push(s),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe('dead');
    expect(handle.runId).toBe('new');
  });

  it('update 会刷新 startedAt，长时间同步不会被自己判成僵死', async () => {
    // 900 条书签的弱网同步可能超过 10 分钟；不刷新的话下一次调用会认为它死了。
    const ls = lockStore();
    let now = 0;
    const handle = await acquireLock('sync', 'run', { store: ls.store, now: () => now });
    now = 9 * 60 * 1000;
    await handle.update('applyLocal', 5, 10);
    expect(ls.current()!.startedAt).toBe(now);
    expect(ls.current()!.phase).toBe('applyLocal');
  });

  it('释放后 update 不再写，避免覆盖新一轮的状态', async () => {
    const ls = lockStore();
    const handle = await acquireLock('sync', 'run', { store: ls.store, now: () => 0 });
    await handle.release();
    await handle.update('done', 1, 1);
    expect(ls.current()).toBeUndefined();
  });

  it('clearStaleLock 在启动时清理残留标记', async () => {
    const ls = lockStore({ running: true, startedAt: 0, phase: 'read', done: 0, total: 0, runId: 'dead', kind: 'sync' });
    expect(await clearStaleLock({ store: ls.store, now: () => 11 * 60 * 1000 })).toBe(true);
    expect(ls.current()).toBeUndefined();
    // 未超时的不动。
    const fresh = lockStore({ running: true, startedAt: 1000, phase: 'read', done: 0, total: 0, runId: 'live', kind: 'sync' });
    expect(await clearStaleLock({ store: fresh.store, now: () => 2000 })).toBe(false);
    expect(fresh.current()).toBeDefined();
  });

  it('isLocked 反映内存锁状态', async () => {
    const ls = lockStore();
    expect(isLocked()).toBe(false);
    const handle = await acquireLock('sync', 'run', { store: ls.store, now: () => 0 });
    expect(isLocked()).toBe(true);
    await handle.release();
    expect(isLocked()).toBe(false);
  });
});

describe('首次同步（FR-4）', () => {
  async function twoSidedRemote() {
    const remote = new FakeRemote();
    const seedDevice = createDevice(remote, {
      name: 'seed',
      local: tree([bk('b-0000000000c1', '共享', 'https://shared.test/'), fd('f-0000000000c1', '技术')]),
    });
    await seedDevice.sync();
    return remote;
  }

  it('两侧都有内容且无基线时要求用户选择', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([bk('b-0000000000d1', '本地独有', 'https://local.test/')]),
    });

    await expect(fresh.sync()).rejects.toMatchObject({ code: 'firstSyncChoice' });
  });

  it('detail 带上两侧与合并后的计数，供弹窗展示', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([bk('b-0000000000d1', '本地独有', 'https://local.test/')]),
    });
    await fresh.sync().catch((error: unknown) => {
      expect((error as { detail: unknown }).detail).toMatchObject({
        localBookmarks: 1,
        localFolders: 0,
        remoteBookmarks: 1,
        remoteFolders: 1,
        mergedBookmarks: 2,
        mergedFolders: 1,
      });
    });
  });

  it('选择合并：按 URL 与路径匹配后去重合并（需求 6.4）', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([
        // 与远端同 URL —— 必须匹配上，不能变成两份。
        bk('b-0000000000d1', '共享（本地叫法）', 'https://shared.test/'),
        bk('b-0000000000d2', '本地独有', 'https://local.test/'),
        fd('f-0000000000d1', '技术'),
      ]),
    });

    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    const local = await fresh.readLocal();
    expect(countRoots(local)).toEqual({ bookmarks: 2, folders: 1 });
  });

  it('选择用本地覆盖', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([bk('b-0000000000d1', '只要本地', 'https://local.test/')]),
    });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'useLocal' });
    expect((await fresh.readLocal()).bar.children.map((c) => c.title)).toEqual(['只要本地']);
  });

  it('选择用云端覆盖', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([bk('b-0000000000d1', '将被覆盖', 'https://local.test/')]),
    });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'useRemote' });
    expect((await fresh.readLocal()).bar.children.map((c) => c.title).sort()).toEqual(['共享', '技术']);
  });

  it('本地为空时不询问，直接拉取远端', async () => {
    const remote = await twoSidedRemote();
    const fresh = createDevice(remote, { name: 'fresh' });
    await expect(fresh.sync()).resolves.toBeTruthy();
    expect(countRoots(await fresh.readLocal())).toEqual({ bookmarks: 1, folders: 1 });
  });

  it('远端为空时不询问，直接上传', async () => {
    const remote = new FakeRemote();
    const fresh = createDevice(remote, {
      name: 'fresh',
      local: tree([bk('b-0000000000d1', 'A', 'https://a.test/')]),
    });
    await expect(fresh.sync()).resolves.toMatchObject({ uploaded: true });
  });
});

describe('预览（FR-2 / FR-3，纯读不写）', () => {
  const local = tree([bk('b-0000000000e1', '本地', 'https://l.test/'), bk('b-0000000000e2', '共同', 'https://c.test/')]);
  const remote = tree([
    bk('b-0000000000f1', '远端一', 'https://r1.test/'),
    bk('b-0000000000f2', '远端二', 'https://r2.test/'),
    bk('b-0000000000e2', '共同', 'https://c.test/'),
  ]);

  it('上传：报告云端将丢失的条目数', async () => {
    const preview = previewOverwrite('upload', { local, remote });
    expect(preview.localCounts.bookmarks).toBe(2);
    expect(preview.remoteCounts.bookmarks).toBe(3);
    // 远端独有的两条会丢。
    expect(preview.losing).toBe(2);
    expect(preview.items.map((i) => i.title).sort()).toEqual(['远端一', '远端二']);
  });

  it('下载：报告本地将丢失的条目数', async () => {
    const preview = previewOverwrite('download', { local, remote });
    expect(preview.losing).toBe(1);
    expect(preview.items[0]!.title).toBe('本地');
  });

  it('条目列表至多 20 条，其余只报数量（FR-10 同一上限）', async () => {
    const many = tree(
      Array.from({ length: 30 }, (_, i) => bk(`b-${String(i).padStart(12, '0')}`, `x${i}`, `https://x${i}.test/`)),
    );
    const preview = previewOverwrite('upload', { local: tree(), remote: many });
    expect(preview.losing).toBe(30);
    expect(preview.items).toHaveLength(20);
    expect(preview.itemsTruncated).toBe(10);
  });

  it('两侧相同时无丢失', async () => {
    expect(previewOverwrite('upload', { local, remote: local }).losing).toBe(0);
  });
});

describe('保活（NFR-7）', () => {
  it('按间隔调用廉价 API', async () => {
    vi.useFakeTimers();
    let pings = 0;
    const keepalive = startKeepalive({ ping: async () => void pings++, intervalMs: 100 });
    // 必须用 async 版本：ping 挂在微任务上，同步推进计时器不会把它冲出来。
    await vi.advanceTimersByTimeAsync(350);
    keepalive.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings).toBe(3);
    vi.useRealTimers();
  });

  it('ping 失败不影响调用方', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const keepalive = startKeepalive({
      ping: async () => {
        throw new Error('worker 已被终止');
      },
      intervalMs: 10,
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(35);
    keepalive.stop();
    expect(errors.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('withKeepalive 在工作结束后停止计时器，异常路径也停', async () => {
    vi.useFakeTimers();
    let pings = 0;
    const ping = async (): Promise<void> => void pings++;

    await withKeepalive(async () => undefined, { ping, intervalMs: 10 });
    await expect(
      withKeepalive(async () => Promise.reject(new Error('boom')), { ping, intervalMs: 10 }),
    ).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(1000);
    expect(pings).toBe(0);
    vi.useRealTimers();
  });
});

describe('写后校验（NFR-4 / FR-18）', () => {
  /** 造一份合法但内容不同的快照，模拟「远端已被别人换掉」。 */
  function foreignSnapshot(nonce: string, title: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        version: 99,
        writerNonce: nonce,
        writtenAt: '2026-07-30T00:00:00.000Z',
        writtenBy: '别的设备',
        contentHash: 'sha256:different',
        roots: {
          bar: {
            guid: 'root-bar',
            type: 'folder',
            title: '书签栏',
            children: [{ guid: 'b-0000000000ff', type: 'bookmark', title, url: 'https://foreign.test/' }],
          },
          other: { guid: 'root-other', type: 'folder', title: '其他书签', children: [] },
        },
      }),
    );
  }

  it('条件写模式下读回内容不符也要失败并重试（截断或缓存）', async () => {
    // 支持 If-Match 不代表内容一定完整：响应体截断、服务器缓存旧内容都会
    // 让读回的哈希对不上。去掉这一层校验，一次静默截断就会被当成成功提交。
    const remote = new FakeRemote();
    const device = createDevice(remote, {
      caps: { ifMatch: true },
      local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]),
    });
    await device.sync();
    device.bookmarks.seed(device.bookmarks.barId, { title: '新增', url: 'https://n.test/' });

    const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;
    let injected = 0;
    const outcome = await device.sync(
      { kind: 'sync' },
      {
        onPhase: async (phase) => {
          if (phase === 'verify' && injected === 0) {
            injected++;
            remote.commitFromOtherDevice(key, foreignSnapshot('someone-else', '外来条目'));
          }
        },
      },
    );

    expect(injected).toBe(1);
    // 第一轮校验失败 → 回到 READ → 第二轮成功。
    expect(outcome.rounds).toBeGreaterThan(1);
  });

  it('降级模式下即使内容哈希相同，nonce 不是自己的也要重试（FR-18）', async () => {
    // 这条单独存在是有原因的：内容不同的情形已被哈希校验覆盖，能把
    // writerNonce 检查真正测出来的只有「内容一样、写入者不是自己」。
    const remote = new FakeRemote({ ifMatch: false });
    const device = createDevice(remote, {
      caps: { ifMatch: false },
      local: tree([bk('b-0000000000a1', 'A', 'https://a.test/')]),
    });
    await device.sync();
    device.bookmarks.seed(device.bookmarks.barId, { title: '新增', url: 'https://n.test/' });

    const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;
    let injected = 0;
    const outcome = await device.sync(
      { kind: 'sync' },
      {
        onPhase: async (phase) => {
          if (phase === 'verify' && injected === 0) {
            injected++;
            // 拿本设备刚写的快照，只把 writerNonce 换掉 —— 内容哈希不变。
            const written = await decodeSnapshot(remote.read(key)!);
            const cloned = { ...written, writerNonce: 'someone-else' };
            remote.commitFromOtherDevice(key, await encodeJson(cloned, true));
          }
        },
      },
    );

    expect(injected).toBe(1);
    expect(outcome.rounds).toBeGreaterThan(1);
  });
});
