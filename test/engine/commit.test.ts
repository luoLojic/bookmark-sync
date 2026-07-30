import { describe, expect, it, beforeEach } from 'vitest';
import { canonicalize } from '../../src/domain/hash.js';
import { countRoots, type Roots } from '../../src/domain/tree.js';
import { resetMemoryLock } from '../../src/engine/lock.js';
import { bk, fd, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters } from './harness.js';

const content = (roots: Roots): string => canonicalize(roots);

const B1 = 'b-0000000000a1';
const B2 = 'b-0000000000a2';
const F1 = 'f-0000000000a1';

beforeEach(() => {
  resetMemoryLock();
  resetCounters();
});

describe('提交协议：正常路径（需求 5.3）', () => {
  it('首次上传：远端为空时把本地树推上去', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree([bk(B1, 'MDN', 'https://mdn.test/')]) });

    const outcome = await device.sync();

    expect(outcome.uploaded).toBe(true);
    expect(remote.paths().some((p) => p.endsWith('bookmarks.json.gz'))).toBe(true);
    expect(device.baseline()?.version).toBe(1);
  });

  it('九个阶段按需求 5.3 的顺序发生', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await device.sync();

    // read → merge → guard → putHistory → putBookmarks → verify → putIndex → writeBaseline
    // （applyLocal 在首次上传时无操作可做，因此不出现）
    expect(device.phases).toEqual([
      'read',
      'merge',
      'guard',
      'putHistory',
      'putBookmarks',
      'verify',
      'putIndex',
      'writeBaseline',
    ]);
  });

  it('历史快照先于 bookmarks 写入（步骤 5 先于步骤 6）', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await device.sync();

    const puts = remote.log.filter((r) => r.method === 'PUT').map((r) => r.path);
    const historyAt = puts.findIndex((p) => p.includes('/history/v'));
    const bookmarksAt = puts.findIndex((p) => p.endsWith('bookmarks.json.gz'));
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(historyAt).toBeLessThan(bookmarksAt);
  });

  it('写入历史索引（FR-15）', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await device.sync();
    expect(remote.paths().some((p) => p.endsWith('history/index.json'))).toBe(true);
  });

  it('第二次同步无改动时不写远端（FR-14）', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await device.sync();

    remote.clearLog();
    const second = await device.sync();

    expect(second.uploaded).toBe(false);
    expect(remote.countRequests('PUT')).toBe(0);
    // 仍然走到写基线：远端 version 可能已被其他设备推进（方案第 4 节）。
    expect(device.phases).toContain('writeBaseline');
    expect(device.phases).not.toContain('putBookmarks');
  });

  it('无变化时仍更新基线 —— 远端 version 可能已被其他设备推进', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await a.sync();

    // B 加一条并提交，把 version 推到 2。
    const b = createDevice(remote, { name: 'B' });
    await b.sync();
    b.bookmarks.seed(b.bookmarks.barId, { title: 'B 的书签', url: 'https://b.test/' });
    await b.sync();

    await a.sync();
    expect(a.baseline()?.version).toBe(b.baseline()?.version);
  });
});

describe('提交协议：删除保护（FR-10 / FR-11）', () => {
  function bigTree(n: number): Roots {
    return tree(
      Array.from({ length: n }, (_, i) =>
        bk(`b-${String(i).padStart(12, '0')}`, `书签 ${i}`, `https://x${i}.test/`),
      ),
    );
  }

  it('远端将大量删除时中止，且不产生任何副作用', async () => {
    const remote = new FakeRemote();
    // 两台设备先同步到 100 条。
    const a = createDevice(remote, { name: 'A', local: bigTree(100) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();

    // B 删掉 40 条并提交。
    for (const id of b.bookmarks.idsOf(b.bookmarks.barId).slice(0, 40)) {
      await b.bookmarks.remove(id);
    }
    // B 自己这一步也会触发保护（远端要少 40 条），那是它的用户已确认的操作。
    await b.sync({ kind: 'sync', skipDeleteGuard: true });

    // A 同步时会看到「本地要删 40 条」→ 触发保护。
    remote.clearLog();
    await expect(a.sync()).rejects.toMatchObject({ code: 'deleteGuard' });

    // 关键：GUARD 在 APPLY_LOCAL 之前，本地一条都没动，远端一个字节都没写。
    expect(a.bookmarks.idsOf(a.bookmarks.barId)).toHaveLength(100);
    expect(remote.countRequests('PUT')).toBe(0);
  });

  it('detail 带上侧别、数量与至多 20 条条目（FR-10）', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: bigTree(100) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();
    for (const id of b.bookmarks.idsOf(b.bookmarks.barId).slice(0, 40)) {
      await b.bookmarks.remove(id);
    }
    await b.sync({ kind: 'sync', skipDeleteGuard: true });

    await a.sync().catch((error: unknown) => {
      const detail = (error as { detail: { side: string; items: unknown[]; itemsTruncated: number; localDeletes: number } }).detail;
      expect(detail.side).toBe('local');
      expect(detail.localDeletes).toBe(40);
      expect(detail.items).toHaveLength(20);
      expect(detail.itemsTruncated).toBe(20);
    });
  });

  it('skipDeleteGuard 后从 READ 完整重跑并成功（FR-11）', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: bigTree(100) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();
    for (const id of b.bookmarks.idsOf(b.bookmarks.barId).slice(0, 40)) {
      await b.bookmarks.remove(id);
    }
    await b.sync({ kind: 'sync', skipDeleteGuard: true });

    await expect(a.sync()).rejects.toMatchObject({ code: 'deleteGuard' });
    await a.sync({ kind: 'sync', skipDeleteGuard: true });

    expect(a.bookmarks.idsOf(a.bookmarks.barId)).toHaveLength(60);
    expect(content(await a.readLocal())).toBe(content(await b.readLocal()));
  });

  it('未达阈值时不触发：删 5 条不打扰用户', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: bigTree(100) });
    await a.sync();
    const b = createDevice(remote, { name: 'B' });
    await b.sync();
    for (const id of b.bookmarks.idsOf(b.bookmarks.barId).slice(0, 5)) {
      await b.bookmarks.remove(id);
    }
    await b.sync();

    await expect(a.sync()).resolves.toBeTruthy();
    expect(a.bookmarks.idsOf(a.bookmarks.barId)).toHaveLength(95);
  });
});

describe('提交协议：上传与下载（FR-2 / FR-3 / FR-12）', () => {
  it('上传用本地覆盖远端，忽略远端已有内容', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk(B1, 'A 的', 'https://a.test/')]) });
    await a.sync();

    const b = createDevice(remote, { name: 'B', local: tree([bk(B2, 'B 的', 'https://b.test/')]) });
    await b.sync({ kind: 'upload' });

    const c = createDevice(remote, { name: 'C' });
    await c.sync();
    expect(countRoots(await c.readLocal())).toEqual({ bookmarks: 1, folders: 0 });
    expect((await c.readLocal()).bar.children[0]!.title).toBe('B 的');
  });

  it('下载用远端覆盖本地', async () => {
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk(B1, '远端内容', 'https://a.test/')]) });
    await a.sync();

    const b = createDevice(remote, {
      name: 'B',
      local: tree([bk(B2, '本地将被覆盖', 'https://b.test/')]),
    });
    await b.sync({ kind: 'download' });

    const local = await b.readLocal();
    expect(local.bar.children.map((c) => c.title)).toEqual(['远端内容']);
  });

  it('上传与下载跳过删除保护（FR-12）', async () => {
    const remote = new FakeRemote();
    const many = tree(
      Array.from({ length: 100 }, (_, i) => bk(`b-${String(i).padStart(12, '0')}`, `x${i}`, `https://x${i}.test/`)),
    );
    const a = createDevice(remote, { name: 'A', local: many });
    await a.sync();

    // B 只有一条，下载会删掉它 —— 若不跳过保护，1/1 = 100% 会触发。
    const b = createDevice(remote, { name: 'B', local: tree([bk(B2, '唯一', 'https://b.test/')]) });
    await expect(b.sync({ kind: 'download' })).resolves.toBeTruthy();
    expect(b.phases).not.toContain('guard');
  });

  it('下载不写远端 —— 内容没变就不写历史（FR-14 优先于方案 4.2 的说法）', async () => {
    // 方案 4.2 写「下载仍走 PUT 以保持历史线性」，但下载的目标树就是远端现状，
    // 内容按定义不变。照它写会让每次点「下载」都往 history/ 里塞一份完全相同
    // 的快照，与 FR-14「内容无变化时不写历史」直接冲突。这里按 FR-14 执行。
    const remote = new FakeRemote();
    const a = createDevice(remote, { name: 'A', local: tree([bk(B1, 'A', 'https://a.test/')]) });
    await a.sync();
    const versionAfterA = a.baseline()!.version;

    const b = createDevice(remote, { name: 'B', local: tree([fd(F1, '将被删除')]) });
    remote.clearLog();
    const outcome = await b.sync({ kind: 'download' });

    expect(outcome.uploaded).toBe(false);
    expect(remote.countRequests('PUT')).toBe(0);
    // 基线仍要更新到远端当前版本，否则下次同步会把本地改动误判为远端删除。
    expect(b.baseline()!.version).toBe(versionAfterA);
    expect((await b.readLocal()).bar.children.map((c) => c.title)).toEqual(['A']);
  });
});
