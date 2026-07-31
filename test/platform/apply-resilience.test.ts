/**
 * test/platform/apply-resilience.test.ts —— 确定性失败不该让同步永久卡死
 * （H-8 / M-12）。
 *
 * INV-4 说「本次失败，下次从头完整执行即收敛」，这有个隐含前提：失败是**瞬时的**。
 * 而书签 API 的失败全是确定性的 —— 远端快照里有一条浏览器拒绝的 URL，下一轮算出
 * 的计划一模一样，会在同一条操作上再次失败，同步从此永久停在这里。受管环境里被
 * 过滤掉的策略条目同理：它会让「删除非空文件夹」和「reorder 子项数对不上」永久失败。
 *
 * 分界线是「谁的错」：计划或映射的问题（PlanError）必须抛出去，让缺陷暴露；
 * 浏览器拒绝单条调用则记录并跳过。
 */

import { describe, expect, it } from 'vitest';
import { MappingTable, applyLocalPlan, readLocalTree } from '../../src/platform/bookmarks.js';
import { makeGuidFactory } from '../../src/domain/guid.js';
import type { LocalOp } from '../../src/domain/plan.js';
import type { GuidMap } from '../../src/shared/types.js';
import { bk, fd, tree } from '../fixtures/trees.js';
import { FakeBookmarks, plantRoots } from '../fakes/bookmarks.js';

function ctxFor(fake: FakeBookmarks, stored: GuidMap = {}) {
  const persisted: GuidMap = { ...stored };
  const table = new MappingTable(stored, async (entries) => {
    Object.assign(persisted, entries);
  });
  return {
    ctx: { mapping: table, rootIds: { bar: fake.barId, other: fake.otherId } },
    persisted,
    table,
  };
}

/** 确定性随机源，让 GUID 可复现。 */
function guidFactory() {
  let n = 0;
  return makeGuidFactory(() => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n / 2147483648;
  });
}

describe('浏览器拒绝的 URL：跳过这一条，其余照常应用（H-8）', () => {
  const bad: LocalOp = {
    kind: 'create',
    guid: 'b-0000000000ff',
    parentGuid: 'root-bar',
    index: 0,
    type: 'bookmark',
    title: '坏书签',
    url: 'not a url',
  };
  const good: LocalOp = {
    kind: 'create',
    guid: 'b-000000000001',
    parentGuid: 'root-bar',
    index: 1,
    type: 'bookmark',
    title: '好书签',
    url: 'https://good.test/',
  };

  it('整轮不抛错，好的那条建出来了', async () => {
    const fake = new FakeBookmarks();
    const { ctx } = ctxFor(fake);
    const result = await applyLocalPlan(fake, [bad, good], ctx);

    expect(result.created).toBe(1);
    expect(fake.titlesOf(fake.barId)).toEqual(['好书签']);
  });

  it('跳过的那条带上标题与 URL —— 否则用户只看到「Invalid URL」', async () => {
    const fake = new FakeBookmarks();
    const { ctx } = ctxFor(fake);
    const result = await applyLocalPlan(fake, [bad], ctx);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      kind: 'create',
      guid: 'b-0000000000ff',
      title: '坏书签',
      url: 'not a url',
    });
    expect(result.skipped[0]!.reason).toMatch(/Invalid URL/i);
  });

  it('跳过的条目不写映射 —— 它并不存在', async () => {
    const fake = new FakeBookmarks();
    const { ctx, persisted } = ctxFor(fake);
    await applyLocalPlan(fake, [bad], ctx);
    expect(Object.values(persisted)).not.toContain('b-0000000000ff');
  });

  it('文件夹的 create 失败仍然抛出 —— 它没有 URL，失败只能是计划问题', async () => {
    const fake = new FakeBookmarks();
    const { ctx } = ctxFor(fake);
    await expect(
      applyLocalPlan(
        fake,
        [{ kind: 'create', guid: 'f-000000000001', parentGuid: 'f-0000000000ee', index: 0, type: 'folder', title: '孤儿' }],
        ctx,
      ),
    ).rejects.toThrow(/没有对应的本地 ID/);
  });

  it('计划或映射的问题一律抛出，且报错指明是哪一条', async () => {
    const fake = new FakeBookmarks();
    const { ctx } = ctxFor(fake);
    await expect(
      applyLocalPlan(fake, [{ kind: 'update', guid: 'b-0000000000ee', title: '改名' }], ctx),
    ).rejects.toThrow(/没有对应的本地 ID/);
  });

  it('update 失败会带上操作与条目信息', async () => {
    const current = tree([fd('f-000000000001', '甲')]);
    const fake = new FakeBookmarks();
    const { ctx } = ctxFor(fake, plantRoots(fake, current));
    // 给文件夹设 URL：真实 API 也拒绝。update 不可跳过，但报错要指得出是哪一条。
    await expect(
      applyLocalPlan(fake, [{ kind: 'update', guid: 'f-000000000001', url: 'https://x.test/' }], ctx),
    ).rejects.toThrow(/update f-000000000001/);
  });
});

describe('受管条目挡在中间：reorder 与 remove 都不该整轮失败（M-12）', () => {
  /** 铺一棵含策略下发条目的树。unmodifiable 的节点会被 convert 过滤掉。 */
  function withManagedChild() {
    const fake = new FakeBookmarks();
    const stored = plantRoots(
      fake,
      tree([bk('b-000000000001', 'A', 'https://a.test/'), bk('b-000000000002', 'B', 'https://b.test/')]),
    );
    // 策略下发的条目夹在中间，本地树里看不见它。
    fake.seed(fake.barId, { title: '公司规定', url: 'https://corp.test/', unmodifiable: 'managed' });
    return { fake, stored };
  }

  it('读树时受管条目被过滤掉（前提确认）', async () => {
    const { fake, stored } = withManagedChild();
    const table = new MappingTable(stored, async () => undefined);
    const read = await readLocalTree(fake, table, guidFactory());
    expect(read.roots.bar.children.map((n) => n.title)).toEqual(['A', 'B']);
    // 浏览器里确实有三个。
    expect(fake.idsOf(fake.barId)).toHaveLength(3);
  });

  it('★ reorder 只排我们认识的那些，不再因为长度对不上抛错', async () => {
    const { fake, stored } = withManagedChild();
    const { ctx } = ctxFor(fake, stored);
    const result = await applyLocalPlan(
      fake,
      [{ kind: 'reorder', parentGuid: 'root-bar', childGuids: ['b-000000000002', 'b-000000000001'] }],
      ctx,
    );

    expect(result.reordered).toBe(1);
    expect(result.skipped).toEqual([]);
    // B 在 A 之前；受管条目还在，位置随它去。
    const titles = fake.titlesOf(fake.barId);
    expect(titles.indexOf('B')).toBeLessThan(titles.indexOf('A'));
    expect(titles).toContain('公司规定');
  });

  it('reorder 里出现不属于该父的 GUID 仍然抛错（这是计划问题）', async () => {
    const { fake, stored } = withManagedChild();
    const { ctx } = ctxFor(fake, stored);
    await expect(
      applyLocalPlan(
        fake,
        [{ kind: 'reorder', parentGuid: 'root-other', childGuids: ['b-000000000001'] }],
        ctx,
      ),
    ).rejects.toThrow(/实际子项不符/);
  });

  it('★ 删不掉含受管子项的文件夹时跳过，不让整轮失败', async () => {
    const fake = new FakeBookmarks();
    const stored = plantRoots(fake, tree([fd('f-000000000001', '甲')]));
    const folderId = Object.keys(stored).find((id) => stored[id] === 'f-000000000001')!;
    fake.seed(folderId, { title: '公司规定', url: 'https://corp.test/', unmodifiable: 'managed' });

    const { ctx } = ctxFor(fake, stored);
    const result = await applyLocalPlan(fake, [{ kind: 'remove', guid: 'f-000000000001' }], ctx);

    expect(result.removed).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ kind: 'remove', guid: 'f-000000000001' });
    expect(fake.titlesOf(fake.barId)).toEqual(['甲']);
  });
});

/**
 * 只读读树不落盘映射（审计 L-6）。
 *
 * getStatus 每次打开 popup 都会读一遍本地树来数条目，而 readLocalTree 会给未映射的
 * 节点分配 GUID 并落盘 —— 首次打开就是全量约 27KB，未配置远端时也照写。INV-2 允许
 * 提前写映射，所以不是正确性问题，但一个只读请求带写副作用值得收敛。
 */
describe('readLocalTree 的 persist 开关', () => {
  it('默认落盘 —— 同步路径依赖这一点', async () => {
    const fake = new FakeBookmarks();
    fake.seed(fake.barId, { title: 'A', url: 'https://a.test/' });
    const persisted: GuidMap = {};
    const table = new MappingTable({}, async (entries) => {
      Object.assign(persisted, entries);
    });
    const read = await readLocalTree(fake, table, guidFactory());
    expect(read.assigned).toBe(1);
    expect(Object.keys(persisted)).toHaveLength(1);
  });

  it('persist: false 时不写 storage，但树照样有 GUID', async () => {
    const fake = new FakeBookmarks();
    fake.seed(fake.barId, { title: 'A', url: 'https://a.test/' });
    const persisted: GuidMap = {};
    const table = new MappingTable({}, async (entries) => {
      Object.assign(persisted, entries);
    });
    const read = await readLocalTree(fake, table, guidFactory(), { persist: false });
    expect(read.assigned).toBe(1);
    expect(read.roots.bar.children[0]!.guid).toMatch(/^b-[0-9a-f]{12}$/);
    expect(persisted).toEqual({});
  });
});
