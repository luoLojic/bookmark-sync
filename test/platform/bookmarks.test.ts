import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPlan, buildPlan } from '../../src/domain/plan.js';
import { ROOT_GUID, countRoots, indexRoots, isFolder, type Roots } from '../../src/domain/tree.js';
import type { GuidMap } from '../../src/shared/types.js';
import {
  MappingTable,
  applyLocalPlan,
  readLocalTree,
  resolveRoots,
  type BookmarkNode,
} from '../../src/platform/bookmarks.js';
import { FakeBookmarks, plantRoots } from '../fakes/bookmarks.js';
import { bk, fd, rootsArb, tree } from '../fixtures/trees.js';

/** 确定性 GUID 工厂，便于断言。 */
function guidFactory(): (type: 'bookmark' | 'folder') => string {
  let n = 0;
  return (type) => `${type === 'folder' ? 'f' : 'b'}-${String(++n).padStart(12, '0')}`;
}

/** 记录每次持久化调用，用来验证映射的落盘时机（INV-2）。 */
function mappingWithLog(initial: GuidMap = {}): {
  table: MappingTable;
  writes: GuidMap[];
  stored: GuidMap;
} {
  const writes: GuidMap[] = [];
  const stored: GuidMap = { ...initial };
  const table = new MappingTable(initial, async (entries) => {
    writes.push({ ...entries });
    Object.assign(stored, entries);
  });
  return { table, writes, stored };
}

describe('resolveRoots — 逻辑根识别（需求 6.5 / 方案 5.2）', () => {
  it('按位置取前两个子项', () => {
    const fake = new FakeBookmarks({ withoutFolderType: true });
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '1', title: '书签栏', children: [] },
      { id: '2', title: '其他书签', children: [] },
      { id: '3', title: '移动书签', children: [] },
    ] }]);
    expect(resolution.ids).toEqual({ bar: '1', other: '2' });
    expect(fake.barId).toBe('2'); // 只是确认 fake 自身可用
  });

  it('folderType 存在时以它为准', () => {
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '9', title: '受管书签', folderType: 'managed', children: [] },
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
      { id: '2', title: '其他书签', folderType: 'other', children: [] },
    ] }]);
    expect(resolution.ids).toEqual({ bar: '1', other: '2' });
  });

  it('managed 文件夹排在最前时，纯位置推断会出错而 folderType 挡住了它', () => {
    // 这正是方案 5.2 要求做 folderType 校验的原因。
    const children: BookmarkNode[] = [
      { id: '9', title: '受管书签', folderType: 'managed', children: [] },
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
      { id: '2', title: '其他书签', folderType: 'other', children: [] },
    ];
    expect(resolveRoots([{ id: 'r', title: '', children }]).ids).toEqual({ bar: '1', other: '2' });
    // 去掉 folderType 后同样的排列就会把「受管书签」当成书签栏。
    const naked = children.map(({ folderType: _ignored, ...rest }) => rest);
    expect(resolveRoots([{ id: 'r', title: '', children: naked }]).ids).toEqual({ bar: '9', other: '1' });
  });

  it('位置推断与 folderType 冲突时记录告警', () => {
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '2', title: '其他书签', folderType: 'other', children: [] },
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
    ] }]);
    expect(resolution.ids).toEqual({ bar: '1', other: '2' });
    expect(resolution.warnings.length).toBeGreaterThan(0);
  });

  it('移动书签根被忽略（需求 6.5）', () => {
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
      { id: '2', title: '其他书签', folderType: 'other', children: [] },
      { id: '3', title: '移动书签', folderType: 'mobile', children: [] },
    ] }]);
    expect(Object.values(resolution.ids)).not.toContain('3');
  });

  it('顶层文件夹不足两个时抛错，而不是猜', () => {
    expect(() => resolveRoots([{ id: 'r', title: '', children: [{ id: '1', title: '书签栏', children: [] }] }])).toThrow(
      /无法识别逻辑根/,
    );
  });

  it('getTree 返回空时抛错', () => {
    expect(() => resolveRoots([])).toThrow(/no root/);
  });
});

describe('readLocalTree', () => {
  it('把浏览器树翻译为 GUID 标识的 Roots，保留结构与顺序', async () => {
    const fake = new FakeBookmarks();
    fake.seedTree(fake.barId, [
      ['MDN', 'https://developer.mozilla.org/'],
      ['技术', [['TS', 'https://www.typescriptlang.org/']]],
    ]);
    fake.seedTree(fake.otherId, [['稍后读', []]]);

    const { table } = mappingWithLog();
    const read = await readLocalTree(fake, table, guidFactory());

    expect(countRoots(read.roots)).toEqual({ bookmarks: 2, folders: 2 });
    expect(read.roots.bar.guid).toBe(ROOT_GUID.bar);
    expect(read.roots.bar.children.map((c) => c.title)).toEqual(['MDN', '技术']);
    const tech = read.roots.bar.children[1]!;
    expect(isFolder(tech) && tech.children.map((c) => c.title)).toEqual(['TS']);
    expect(read.rootIds).toEqual({ bar: fake.barId, other: fake.otherId });
  });

  it('为未映射的节点分配 GUID 并立即落盘（INV-2）', async () => {
    const fake = new FakeBookmarks();
    fake.seed(fake.barId, { title: 'A', url: 'https://a.test/' });
    const { table, writes, stored } = mappingWithLog();

    const read = await readLocalTree(fake, table, guidFactory());

    expect(read.assigned).toBe(1);
    // 一次批量写，而不是每个节点一次 —— 读树阶段没有外部依赖，批量是安全的。
    expect(writes).toHaveLength(1);
    const guid = indexRoots(read.roots).keys().next().value!;
    expect(Object.values(stored)).toContain(guid);
  });

  it('复用已有映射，不重新分配 GUID', async () => {
    const fake = new FakeBookmarks();
    const id = fake.seed(fake.barId, { title: 'A', url: 'https://a.test/' });
    const { table, writes } = mappingWithLog({ [id]: 'b-0000000000ff' });

    const read = await readLocalTree(fake, table, guidFactory());

    expect(read.assigned).toBe(0);
    expect(writes).toHaveLength(0);
    expect([...indexRoots(read.roots).keys()]).toEqual(['b-0000000000ff']);
  });

  it('两次读取得到相同的 GUID —— 否则条目会在远端表现为「删旧加新」', async () => {
    const fake = new FakeBookmarks();
    fake.seed(fake.barId, { title: 'A', url: 'https://a.test/' });
    const { table } = mappingWithLog();

    const first = await readLocalTree(fake, table, guidFactory());
    const second = await readLocalTree(fake, table, guidFactory());

    expect([...indexRoots(second.roots).keys()]).toEqual([...indexRoots(first.roots).keys()]);
  });

  it('跳过策略下发的不可修改条目', async () => {
    const fake = new FakeBookmarks();
    fake.seed(fake.barId, { title: '正常', url: 'https://a.test/' });
    fake.seed(fake.barId, { title: '受管', url: 'https://b.test/', unmodifiable: 'managed' });
    const { table } = mappingWithLog();

    const read = await readLocalTree(fake, table, guidFactory());
    expect(read.roots.bar.children.map((c) => c.title)).toEqual(['正常']);
  });

  it('逻辑根自身不进映射表（需求 6.5：只作容器）', async () => {
    const fake = new FakeBookmarks();
    const { table, stored } = mappingWithLog();
    await readLocalTree(fake, table, guidFactory());
    expect(Object.keys(stored)).not.toContain(fake.barId);
    expect(Object.values(stored)).not.toContain(ROOT_GUID.bar);
  });
});

/**
 * 应用器与 domain 参考实现的等价性。
 *
 * domain/plan.ts 的 applyPlan 是语义基准（严格前置条件、纯数组操作）；这里
 * 验证同一个操作序列作用在真实 API 形状上得到同一棵树。等价一旦成立，
 * plan.ts 的属性测试 apply(plan(a,b),a)=b 就同时覆盖了本地应用路径。
 */
describe('applyLocalPlan — 与 domain 参考实现等价', () => {
  /** 从 current 出发，把 target 应用到 fake 上，返回读回的树。 */
  async function applyAndRead(current: Roots, target: Roots) {
    const fake = new FakeBookmarks();
    const planted = plantRoots(fake, current);
    const { table } = mappingWithLog(planted);
    const rootIds = { bar: fake.barId, other: fake.otherId };

    const ops = buildPlan(current, target);
    const result = await applyLocalPlan(fake, ops, { mapping: table, rootIds });

    const readBack = await readLocalTree(fake, table, guidFactory());
    return { fake, ops, result, roots: readBack.roots, table };
  }

  it('新增：创建书签与文件夹，并立即写入映射', async () => {
    const target = tree([bk('b-000000000001', 'A', 'https://a.test/'), fd('f-000000000001', '甲')]);
    const { roots, result } = await applyAndRead(tree(), target);
    expect(roots).toEqual(target);
    expect(result.created).toBe(2);
  });

  it('删除：自底向上，过程中不删非空文件夹', async () => {
    const current = tree([fd('f-000000000001', '甲', [bk('b-000000000001', 'A', 'https://a.test/')])]);
    const { roots, result } = await applyAndRead(current, tree());
    expect(roots).toEqual(tree());
    expect(result.removed).toBe(2);
  });

  it('改名与改 URL', async () => {
    const current = tree([bk('b-000000000001', 'A', 'https://a.test/')]);
    const target = tree([bk('b-000000000001', 'A2', 'https://b.test/')]);
    const { roots, result } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
    expect(result.updated).toBe(1);
  });

  it('跨父移动', async () => {
    const current = tree([bk('b-000000000001', 'A', 'https://a.test/'), fd('f-000000000001', '甲')]);
    const target = tree([fd('f-000000000001', '甲', [bk('b-000000000001', 'A', 'https://a.test/')])]);
    const { roots, result } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
    expect(result.moved).toBe(1);
  });

  it('跨逻辑根移动', async () => {
    const current = tree([bk('b-000000000001', 'A', 'https://a.test/')]);
    const target = tree([], [bk('b-000000000001', 'A', 'https://a.test/')]);
    const { roots } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
  });

  it('兄弟重排：只用不带 index 的 move，结果仍为目标顺序', async () => {
    const current = tree([
      bk('b-000000000001', 'A', 'https://a.test/'),
      bk('b-000000000002', 'B', 'https://b.test/'),
      bk('b-000000000003', 'C', 'https://c.test/'),
    ]);
    const target = tree([
      bk('b-000000000003', 'C', 'https://c.test/'),
      bk('b-000000000001', 'A', 'https://a.test/'),
      bk('b-000000000002', 'B', 'https://b.test/'),
    ]);
    const { roots, result } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
    expect(result.reordered).toBe(1);
  });

  it('重排跳过已就位的前缀，只动需要动的部分', async () => {
    // [A,B,C] → [A,C,B]：A 已就位，只需处理后两个。
    const current = tree([
      bk('b-000000000001', 'A', 'https://a.test/'),
      bk('b-000000000002', 'B', 'https://b.test/'),
      bk('b-000000000003', 'C', 'https://c.test/'),
    ]);
    const target = tree([
      bk('b-000000000001', 'A', 'https://a.test/'),
      bk('b-000000000003', 'C', 'https://c.test/'),
      bk('b-000000000002', 'B', 'https://b.test/'),
    ]);
    const fake = new FakeBookmarks();
    const { table } = mappingWithLog(plantRoots(fake, current));
    fake.resetCalls();
    await applyLocalPlan(fake, buildPlan(current, target), {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
    });
    expect(fake.calls.move).toBe(2);
    expect(fake.titlesOf(fake.barId)).toEqual(['A', 'C', 'B']);
  });

  it('把条目移出即将被删除的文件夹', async () => {
    const current = tree([fd('f-000000000001', '待删', [bk('b-000000000001', 'A', 'https://a.test/')])]);
    const target = tree([bk('b-000000000001', 'A', 'https://a.test/')]);
    const { roots } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
  });

  it('把条目移入新建的文件夹', async () => {
    const current = tree([bk('b-000000000001', 'A', 'https://a.test/')]);
    const target = tree([fd('f-000000000001', '新建', [bk('b-000000000001', 'A', 'https://a.test/')])]);
    const { roots } = await applyAndRead(current, target);
    expect(roots).toEqual(target);
  });

  it('嵌套新建：父先于子', async () => {
    const target = tree([
      fd('f-000000000001', '甲', [fd('f-000000000002', '乙', [bk('b-000000000001', 'A', 'https://a.test/')])]),
    ]);
    const { roots } = await applyAndRead(tree(), target);
    expect(roots).toEqual(target);
  });
});

describe('applyLocalPlan — 属性：与 domain applyPlan 逐树等价', () => {
  it('对任意树对，浏览器侧应用结果等于目标树', async () => {
    // 这条把 plan.ts 的属性 apply(plan(a,b),a)=b 延伸到真实 API 形状上。
    // 两者一旦等价，本地应用路径的正确性就由 domain 的属性测试一并承担。
    await fc.assert(
      fc.asyncProperty(rootsArb, rootsArb, async (current, target) => {
        const fake = new FakeBookmarks();
        const { table } = mappingWithLog(plantRoots(fake, current));
        const rootIds = { bar: fake.barId, other: fake.otherId };

        await applyLocalPlan(fake, buildPlan(current, target), { mapping: table, rootIds });

        const readBack = await readLocalTree(fake, table, guidFactory());
        // 逻辑根标题由浏览器给出，不参与比较。
        expect(readBack.roots.bar.children).toEqual(target.bar.children);
        expect(readBack.roots.other.children).toEqual(target.other.children);
      }),
      { numRuns: 200 },
    );
  });

  it('属性：与 domain applyPlan 的结果逐字段一致', async () => {
    await fc.assert(
      fc.asyncProperty(rootsArb, rootsArb, async (current, target) => {
        const ops = buildPlan(current, target);
        const reference = applyPlan(current, ops);

        const fake = new FakeBookmarks();
        const { table } = mappingWithLog(plantRoots(fake, current));
        await applyLocalPlan(fake, ops, {
          mapping: table,
          rootIds: { bar: fake.barId, other: fake.otherId },
        });
        const actual = await readLocalTree(fake, table, guidFactory());

        expect(actual.roots.bar.children).toEqual(reference.bar.children);
        expect(actual.roots.other.children).toEqual(reference.other.children);
      }),
      { numRuns: 200 },
    );
  });
});

describe('applyLocalPlan — 严格性与映射时机', () => {
  it('创建后立即写映射，不等整批结束（需求 5.3 步骤 4 / INV-2）', async () => {
    const target = tree([
      bk('b-000000000001', 'A', 'https://a.test/'),
      bk('b-000000000002', 'B', 'https://b.test/'),
      bk('b-000000000003', 'C', 'https://c.test/'),
    ]);
    const fake = new FakeBookmarks();
    const { table, writes } = mappingWithLog();
    await applyLocalPlan(fake, buildPlan(tree(), target), {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
    });
    // 三次创建 → 三次独立写入。批量到最后一次写，崩溃时会丢掉已创建条目的映射，
    // 下次同步把它们当成本地新增而重复创建。
    expect(writes).toHaveLength(3);
    // 每次只写一条 —— 确认是「逐条」而不是攒到最后一次性写。
    expect(writes.map((w) => Object.keys(w).length)).toEqual([1, 1, 1]);
  });

  it('GUID 没有对应本地 ID 时抛错，而不是静默跳过', async () => {
    const fake = new FakeBookmarks();
    const { table } = mappingWithLog();
    await expect(
      applyLocalPlan(fake, [{ kind: 'remove', guid: 'b-00000000dead' }], {
        mapping: table,
        rootIds: { bar: fake.barId, other: fake.otherId },
      }),
    ).rejects.toThrow(/没有对应的本地 ID/);
  });

  it('reorder 的子项与实际不符时抛错（与 domain applyPlan 一致）', async () => {
    const current = tree([bk('b-000000000001', 'A', 'https://a.test/')]);
    const fake = new FakeBookmarks();
    const { table } = mappingWithLog(plantRoots(fake, current));
    await expect(
      applyLocalPlan(
        fake,
        [{ kind: 'reorder', parentGuid: ROOT_GUID.bar, childGuids: ['b-000000000001', 'b-000000000001'] }],
        { mapping: table, rootIds: { bar: fake.barId, other: fake.otherId } },
      ),
    ).rejects.toThrow(/实际子项不符/);
  });

  it('删除非空文件夹时由浏览器报错（不静默删整棵子树）', async () => {
    const current = tree([fd('f-000000000001', '甲', [bk('b-000000000001', 'A', 'https://a.test/')])]);
    const fake = new FakeBookmarks();
    const { table } = mappingWithLog(plantRoots(fake, current));
    await expect(
      applyLocalPlan(fake, [{ kind: 'remove', guid: 'f-000000000001' }], {
        mapping: table,
        rootIds: { bar: fake.barId, other: fake.otherId },
      }),
    ).rejects.toThrow(/non-empty/i);
  });

  it('逐条上报进度', async () => {
    const target = tree([bk('b-000000000001', 'A', 'https://a.test/'), bk('b-000000000002', 'B', 'https://b.test/')]);
    const fake = new FakeBookmarks();
    const { table } = mappingWithLog();
    const seen: string[] = [];
    const ops = buildPlan(tree(), target);
    await applyLocalPlan(fake, ops, {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });
    expect(seen).toEqual(ops.map((_, i) => `${i + 1}/${ops.length}`));
  });
});

describe('resolveRoots — 防御性分支', () => {
  it('部分子项带 folderType、目标根没带时，按位置采用并记录告警', () => {
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '1', title: '书签栏', children: [] },
      { id: '2', title: '其他书签', children: [] },
      { id: '3', title: '移动书签', folderType: 'mobile', children: [] },
    ] }]);
    expect(resolution.ids).toEqual({ bar: '1', other: '2' });
    expect(resolution.warnings.join()).toMatch(/缺少 folderType/);
  });

  it('两棵根解析到同一文件夹时抛错', () => {
    // 只有一个可同步的顶层文件夹却带着两种 folderType —— 数据异常，宁可报错。
    expect(() =>
      resolveRoots([{ id: 'r', title: '', children: [
        { id: '1', title: '唯一', folderType: 'bookmarks-bar', children: [] },
      ] }]),
    ).toThrow(/无法识别逻辑根/);
  });

  it('未知的 folderType 按「不同步」处理', () => {
    const resolution = resolveRoots([{ id: 'r', title: '', children: [
      { id: '9', title: '未来类型', folderType: 'something-new', children: [] },
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
      { id: '2', title: '其他书签', folderType: 'other', children: [] },
    ] }]);
    expect(resolution.ids).toEqual({ bar: '1', other: '2' });
  });
});

/**
 * 同父 move 的索引语义无关性。
 *
 * 真实 Chrome 在同父移动时，index 是按移除前还是移除后的数组解释，各版本
 * 不一致 —— 这是一类经典的差一错误。platform/bookmarks.ts 的 reorder 因此
 * 刻意不传 index，只反复「移到末尾」。这组用例把「与该语义无关」这个设计
 * 主张真正测出来：同一份重排计划在两种解释下都必须得到目标顺序。
 */
describe('reorder 不依赖同父 move 的索引语义', () => {
  const current = tree([
    bk('b-000000000001', 'A', 'https://a.test/'),
    bk('b-000000000002', 'B', 'https://b.test/'),
    bk('b-000000000003', 'C', 'https://c.test/'),
    bk('b-000000000004', 'D', 'https://d.test/'),
  ]);

  const permutations: string[][] = [
    ['D', 'C', 'B', 'A'],
    ['B', 'A', 'D', 'C'],
    ['A', 'C', 'D', 'B'],
    ['C', 'A', 'B', 'D'],
  ];

  for (const mode of ['afterRemoval', 'beforeRemoval'] as const) {
    for (const order of permutations) {
      it(`${mode} 解释下 ${order.join('')} 顺序正确`, async () => {
        const byTitle = new Map(current.bar.children.map((c) => [c.title, c]));
        const target = tree(order.map((t) => byTitle.get(t)!));

        const fake = new FakeBookmarks({ sameParentIndex: mode });
        const { table } = mappingWithLog(plantRoots(fake, current));
        await applyLocalPlan(fake, buildPlan(current, target), {
          mapping: table,
          rootIds: { bar: fake.barId, other: fake.otherId },
        });

        expect(fake.titlesOf(fake.barId)).toEqual(order);
      });
    }
  }

  it('两种解释下随机排列都得到目标顺序', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(['A', 'B', 'C', 'D'], { minLength: 4, maxLength: 4 }),
        fc.constantFrom('afterRemoval' as const, 'beforeRemoval' as const),
        async (order, mode) => {
          const byTitle = new Map(current.bar.children.map((c) => [c.title, c]));
          const target = tree(order.map((t) => byTitle.get(t)!));
          const fake = new FakeBookmarks({ sameParentIndex: mode });
          const { table } = mappingWithLog(plantRoots(fake, current));
          await applyLocalPlan(fake, buildPlan(current, target), {
            mapping: table,
            rootIds: { bar: fake.barId, other: fake.otherId },
          });
          expect(fake.titlesOf(fake.barId)).toEqual(order);
        },
      ),
      { numRuns: 60 },
    );
  });
});
