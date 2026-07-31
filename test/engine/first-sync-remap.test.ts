/**
 * test/engine/first-sync-remap.test.ts —— 首次同步认亲结果必须落到两个地方（H-4）。
 *
 * 需求 6.4 说「匹配上的条目建立 GUID 映射」。原实现只把匹配用于算目标树，映射
 * 既没写回映射表、也没用来改写参与 buildPlan 的本地树，于是每条认上亲的条目都是
 * 「目标独有 → create」+「当前独有 → remove」：
 *
 *   · 整棵本地书签树被删掉重建 —— dateAdded 归零、favicon 缓存失效、浏览器
 *     书签 ID 全部变化（其他扩展记住的排序、书签栏状态都跟着失效）；
 *   · 首次合并走 skipGuard，这批删除不受删除保护约束；
 *   · create 排在 remove 之前，中间态书签数翻倍，此时崩溃用户会看到重复；
 *   · 映射没落盘，下一轮读树又分配本设备自己的 GUID，于是**每次同步都重建一遍**。
 *
 * 断言方式刻意用「浏览器 ID 有没有变」和「create/remove 调用次数」，而不是只看
 * 最终计数 —— 删掉重建的最终计数是对的，正是它让这个缺陷躲过了原有测试。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { countRoots } from '../../src/domain/tree.js';
import { matchFirstSync } from '../../src/domain/firstsync.js';
import { decodeSnapshot } from '../../src/remote/codec.js';
import { bk, fd, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters } from './harness.js';

beforeEach(() => {
  resetCounters();
});

/** 远端快照的当前内容。 */
async function remoteRoots(remote: FakeRemote) {
  const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;
  return (await decodeSnapshot(remote.read(key)!)).roots;
}

/** 种子设备先把「共享 + 技术/嵌套」推到远端，之后的设备都算首次接入。 */
async function seededRemote() {
  const remote = new FakeRemote();
  const seed = createDevice(remote, {
    name: 'seed',
    local: tree([
      bk('b-0000000000c1', '共享', 'https://shared.test/'),
      fd('f-0000000000c1', '技术', [bk('b-0000000000c2', '嵌套', 'https://nested.test/')]),
    ]),
  });
  await seed.sync();
  return remote;
}

/** 与远端内容相同但 GUID 完全不同的本地树 —— 首次接入的真实样子。 */
function twinLocal() {
  return tree([
    bk('b-0000000000d1', '共享（本地叫法）', 'https://shared.test/'),
    fd('f-0000000000d1', '技术', [bk('b-0000000000d2', '嵌套', 'https://nested.test/')]),
    bk('b-0000000000d3', '本地独有', 'https://local.test/'),
  ]);
}

describe('选择「合并」：认上亲的条目不得删掉重建（H-4）', () => {
  it('本地已有的三条保持原来的浏览器 ID', async () => {
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });

    const before = fresh.bookmarks.idsOf(fresh.bookmarks.barId);
    expect(before).toHaveLength(3);

    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    const after = fresh.bookmarks.idsOf(fresh.bookmarks.barId);
    // 三个原有节点的 ID 必须还在。删掉重建会让它们全部消失。
    for (const id of before) expect(after).toContain(id);
  });

  it('一次 remove 都不发 —— 合并只该新增，不该删任何本地条目', async () => {
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });

    fresh.bookmarks.resetCalls();
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    expect(fresh.bookmarks.calls.remove).toBe(0);
    // 远端与本地内容完全重合（共享 / 技术 / 嵌套），本地只多一条，
    // 所以合并后不需要创建任何条目。
    expect(fresh.bookmarks.calls.create).toBe(0);
  });

  it('合并结果的计数是并集，不是两侧相加', async () => {
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    // 共享 + 本地独有 + 嵌套 = 3 书签，技术 = 1 文件夹。
    expect(countRoots(await fresh.readLocal())).toEqual({ bookmarks: 3, folders: 1 });
  });

  it('认亲结果写回映射表：本地节点此后用远端 GUID', async () => {
    const remote = await seededRemote();
    const seeded = await remoteRoots(remote);
    const remoteShared = seeded.bar.children.find((n) => 'url' in n && n.url === 'https://shared.test/');
    expect(remoteShared).toBeDefined();

    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    const sharedLocalId = fresh.bookmarks.idsOf(fresh.bookmarks.barId)[0]!;
    // 起点：映射里是本设备自己的 GUID。
    expect(fresh.mapping.guidOf(sharedLocalId)).toBe('b-0000000000d1');

    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    // 终点：同一个浏览器节点，映射已指向远端 GUID。
    expect(fresh.mapping.guidOf(sharedLocalId)).toBe(remoteShared!.guid);
  });

  it('★ 第二次同步不再有任何本地改动，也不写远端', async () => {
    // 映射没落盘时这条会失败：下一轮读树重新分配本设备 GUID，
    // 于是同一棵树被反复删掉重建。
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    fresh.bookmarks.resetCalls();
    const second = await fresh.sync();

    expect(second.uploaded).toBe(false);
    expect(fresh.bookmarks.calls.create).toBe(0);
    expect(fresh.bookmarks.calls.remove).toBe(0);
    expect(fresh.bookmarks.calls.move).toBe(0);
  });
});

describe('选择「用远端」：同样不该重建整棵本地树', () => {
  it('内容相同的条目保留原浏览器 ID，只删本地独有的那条', async () => {
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    const [sharedId, folderId, localOnlyId] = fresh.bookmarks.idsOf(fresh.bookmarks.barId);

    fresh.bookmarks.resetCalls();
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'useRemote' });

    const after = fresh.bookmarks.idsOf(fresh.bookmarks.barId);
    expect(after).toContain(sharedId);
    expect(after).toContain(folderId);
    // 「用远端」的语义就是丢掉本地独有的条目 —— 这一条删除是应该的。
    expect(after).not.toContain(localOnlyId);
    expect(fresh.bookmarks.calls.remove).toBe(1);
    expect(fresh.bookmarks.calls.create).toBe(0);
    expect(countRoots(await fresh.readLocal())).toEqual({ bookmarks: 2, folders: 1 });
  });
});

describe('选择「用本地」：不该把远端整棵树换成本设备的 GUID', () => {
  it('远端已有条目的 GUID 保持不变，其他设备不必重建书签树', async () => {
    const remote = await seededRemote();
    const beforeRoots = await remoteRoots(remote);
    const remoteGuids = beforeRoots.bar.children.map((n) => n.guid).sort();

    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'useLocal' });

    const afterRoots = await remoteRoots(remote);
    const afterGuids = afterRoots.bar.children.map((n) => n.guid);
    // 原有的两个顶层 GUID（共享、技术）必须还在新快照里。
    for (const guid of remoteGuids) expect(afterGuids).toContain(guid);
    // 内容取自本地：多出「本地独有」，标题也用本地的叫法。
    expect(countRoots(afterRoots)).toEqual({ bookmarks: 3, folders: 1 });
  });
});

describe('重置同步状态之后不得重复认亲（H-4 的第二个后果）', () => {
  it('两棵树共有的 GUID 不参与认亲 —— 它们已经按 GUID 对应上了', () => {
    // g-2 两侧都有，按定义是同一个实体。若让它再参与「同父内 URL 相同」的
    // 宽松匹配，g-1 就会把它抢走（唯一候选），于是两个本地节点得到同一个
    // GUID —— 一棵树里出现重复 GUID，比重建整棵树更糟。
    const local = tree([bk('g-1', '甲', 'https://same.test/'), bk('g-2', '乙', 'https://same.test/')]);
    const remote = tree([bk('g-2', '乙', 'https://same.test/')]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });

  it('已对应的文件夹不会被「路径正好相同」的另一个远端文件夹抢走', () => {
    // 这就是审计描述的错配：本地的「技术」在远端已改名为「技术笔记」（GUID 相同），
    // 而远端另有一个叫「技术」的文件夹。按路径认亲会把 f-keep 错配到 f-other。
    const local = tree([fd('f-keep', '技术')]);
    const remote = tree([fd('f-keep', '技术笔记'), fd('f-other', '技术')]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });

  it('基线清掉但映射保留时，再同步不产生重复条目', async () => {
    // 「重置同步状态」按 INV-3 只清基线，映射按 INV-2 保留，本地树携带的已经
    // 是正确的远端 GUID。若让这些条目再走一次宽松匹配，只要某个文件夹在两侧
    // 路径不同，就会把一个本已正确对应的条目错配到另一个远端条目上。
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });
    const settled = countRoots(await fresh.readLocal());

    // 模拟用户点「重置同步状态」：只清基线。
    fresh.clearBaseline();

    fresh.bookmarks.resetCalls();
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    expect(countRoots(await fresh.readLocal())).toEqual(settled);
    expect(fresh.bookmarks.calls.create).toBe(0);
    expect(fresh.bookmarks.calls.remove).toBe(0);
  });

  it('本地把某个文件夹改名后重置再同步，也不该错配', async () => {
    const remote = await seededRemote();
    const fresh = createDevice(remote, { name: 'fresh', local: twinLocal() });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    // 另一台设备把「技术」改名为「技术笔记」并提交。
    const other = createDevice(remote, { name: 'other' });
    await other.sync();
    const folderId = other.bookmarks.idsOf(other.bookmarks.barId).find((id) =>
      other.bookmarks.titlesOf(other.bookmarks.barId)[other.bookmarks.idsOf(other.bookmarks.barId).indexOf(id)] === '技术',
    )!;
    await other.bookmarks.update(folderId, { title: '技术笔记' });
    await other.sync();

    // fresh 重置基线后再同步：两侧同一个文件夹路径已经不同（技术 vs 技术笔记），
    // 但 GUID 相同，必须靠 GUID 认出来，不能靠路径重新配对。
    fresh.clearBaseline();
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    const roots = await fresh.readLocal();
    const titles = roots.bar.children.map((n) => n.title).sort();
    // 只该有一个技术文件夹，不该出现「技术」与「技术笔记」两份。
    expect(titles.filter((t) => t.startsWith('技术'))).toHaveLength(1);
    expect(countRoots(roots)).toEqual({ bookmarks: 3, folders: 1 });
  });
});
