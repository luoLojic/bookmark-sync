/**
 * test/engine/remote-missing.test.ts —— 「有基线但远端快照读不到」的回归护栏。
 *
 * 这是审计发现的最高危路径（C-2 / BUG-01），也是崩溃矩阵原先唯一漏掉的组合：
 * 27 个崩溃用例全部假设远端文件存在。
 *
 * 缺陷成因：`readRemoteSnapshot` 找不到文件时返回 `snapshot: null`，而
 * `commit.ts` 曾把它折叠成 `emptyRoots()` 再送进三方合并。于是每一条
 * 「基线有、本地未改」的条目都落在 merge 的「仅远端删除」那一行被删掉 ——
 * 换远端地址、改基础路径、远端文件被误删、路径填错一个字符都会触发。
 *
 * 而删除保护拦不住它：全量删除的比例恒为 100%，但 guard 要求条数与比例
 * **同时**超标，所以条目总数 ≤ 阈值条数（默认 10）的用户会被直接清空。
 * 下面第一个用例就固定在 3 条书签这个「保护必然不触发」的规模上。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RemoteSnapshotMissing } from '../../src/shared/errors.js';
import { resetMemoryLock } from '../../src/engine/lock.js';
import { countRoots, type Roots } from '../../src/domain/tree.js';
import { bk, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters, type Device } from './harness.js';

beforeEach(() => {
  resetMemoryLock();
  resetCounters();
});

const REMOTE_FILE = '/dav/bookmark-sync/bookmarks.json.gz';

/** 小规模树：3 个条目，低于删除保护的条数阈值，保护不会介入。 */
const smallTree = (): Roots =>
  tree([bk('b-000000000001', 'MDN', 'https://mdn.test/'), bk('b-000000000002', 'TS', 'https://ts.test/')], [
    bk('b-000000000003', '稍后读', 'https://later.test/'),
  ]);

/** 把设备同步到与远端一致，得到一份真实基线。 */
async function establishBaseline(device: Device): Promise<void> {
  await device.sync();
  expect(device.baseline()).not.toBeUndefined();
}

describe('远端快照缺失（C-2 / BUG-01）', () => {
  it('有基线而远端文件消失时中止，绝不删除本地书签', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);

    const before = await device.readLocal();
    expect(countRoots(before)).toEqual({ bookmarks: 3, folders: 0 });

    // 远端文件消失：等价于换了地址、改了 basePath、或文件被删。
    expect(remote.unlink(REMOTE_FILE)).toBe(true);

    await expect(device.sync()).rejects.toBeInstanceOf(RemoteSnapshotMissing);

    // 本地必须一字未动 —— 这是整个用例的要点。
    expect(await device.readLocal()).toEqual(before);
  });

  it('中止时不写基线、不写远端、不产生历史快照', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);
    const baselineBefore = device.baseline();

    remote.unlink(REMOTE_FILE);
    const pathsBefore = remote.paths();
    remote.clearLog();

    await expect(device.sync()).rejects.toBeInstanceOf(RemoteSnapshotMissing);

    // INV-1 / INV-3：失败不动基线，也不留下任何写痕迹。
    expect(device.baseline()).toBe(baselineBefore);
    expect(remote.paths()).toEqual(pathsBefore);
    expect(remote.countRequests('PUT')).toBe(0);
  });

  it('条目数远超删除保护阈值时同样中止（不是靠保护拦下的）', async () => {
    // 这一条把「中止」与「保护触发」区分开：大树上旧实现会弹删除保护，
    // 用户点一次「确认删除并继续」就会真的清空本地。现在应当根本走不到那里。
    const many = Array.from({ length: 40 }, (_, i) =>
      bk(`b-${String(i + 1).padStart(12, '0')}`, `书签 ${i + 1}`, `https://n${i}.test/`),
    );
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: tree(many) });
    await establishBaseline(device);

    const before = await device.readLocal();
    remote.unlink(REMOTE_FILE);

    const error = await device.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteSnapshotMissing);
    expect(await device.readLocal()).toEqual(before);
  });

  it('用户显式点「上传」可以在此状态下重建远端', async () => {
    // 中止不能变成死锁：报错文案让用户去点上传，这条路必须真的走得通。
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);
    remote.unlink(REMOTE_FILE);

    const outcome = await device.sync({ kind: 'upload' });
    expect(outcome.uploaded).toBe(true);
    expect(remote.has(REMOTE_FILE)).toBe(true);
    expect(countRoots(await device.readLocal())).toEqual({ bookmarks: 3, folders: 0 });
  });

  it('「下载」在远端缺失时报错而不是清空本地', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);
    const before = await device.readLocal();
    remote.unlink(REMOTE_FILE);

    await expect(device.sync({ kind: 'download' })).rejects.toBeInstanceOf(RemoteSnapshotMissing);
    expect(await device.readLocal()).toEqual(before);
  });

  it('没有基线且远端为空时仍是正常的首次上传', async () => {
    // 边界的另一侧：这才是「远端没有文件」的合法含义，不能被上面的中止误伤。
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });

    const outcome = await device.sync();
    expect(outcome.uploaded).toBe(true);
    expect(remote.has(REMOTE_FILE)).toBe(true);
    expect(device.baseline()).not.toBeUndefined();
    expect(countRoots(await device.readLocal())).toEqual({ bookmarks: 3, folders: 0 });
  });

  it('中止后远端恢复，下一次同步照常收敛', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);

    const saved = remote.read(REMOTE_FILE)!;
    remote.unlink(REMOTE_FILE);
    await expect(device.sync()).rejects.toBeInstanceOf(RemoteSnapshotMissing);

    // 用户修正了地址（远端文件回来了）。
    remote.seed(REMOTE_FILE, saved);
    const outcome = await device.sync();
    expect(outcome.result.removed).toBe(0);
    expect(countRoots(await device.readLocal())).toEqual({ bookmarks: 3, folders: 0 });
  });

  it('本地新增未同步时中止，新增内容也不丢', async () => {
    const remote = new FakeRemote();
    const device = createDevice(remote, { local: smallTree() });
    await establishBaseline(device);

    // 基线之后，用户在本机又加了一个文件夹和一条书签（尚未同步）。
    const folderId = device.bookmarks.seed(device.bookmarks.barId, { title: '新文件夹' });
    device.bookmarks.seed(folderId, { title: '新条目', url: 'https://new.test/' });

    remote.unlink(REMOTE_FILE);

    await expect(device.sync()).rejects.toBeInstanceOf(RemoteSnapshotMissing);
    expect(countRoots(await device.readLocal())).toEqual({ bookmarks: 4, folders: 1 });
  });
});
