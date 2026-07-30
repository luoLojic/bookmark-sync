/**
 * test/perf/bookmarks.test.ts —— M2 的性能门禁（方案 8 M2 验收）。
 *
 * 验收要求：对 900 书签 / 120 文件夹的树完成一次全量应用 < 5s。
 *
 * 这里量的是扩展自身的开销（计划生成 + 操作翻译 + 调用次数），fake 的 API
 * 调用本身是内存操作。真实浏览器的 chrome.bookmarks 与 storage.local 往返
 * 延迟量不到，因此本文件同时把调用次数打印出来 —— 换算真实耗时要用它，
 * 并在 M7 的真机验证里核对。
 */

import { describe, expect, it } from 'vitest';
import { buildPlan, summarizePlan } from '../../src/domain/plan.js';
import { countRoots, makeBookmark, makeFolder, type Roots, type TreeNode } from '../../src/domain/tree.js';
import { MappingTable, applyLocalPlan, readLocalTree } from '../../src/platform/bookmarks.js';
import type { GuidMap } from '../../src/shared/types.js';
import { FakeBookmarks, plantRoots } from '../fakes/bookmarks.js';
import { tree } from '../fixtures/trees.js';

/**
 * 按需求第 3 节的设计指标造树：900 书签 / 120 文件夹。
 * 形状取自真实导出的观察 —— 两层目录、每个叶目录十几条书签。
 */
function designTargetTree(): Roots {
  let bookmarkNo = 0;
  let folderNo = 0;

  const nextBookmark = (): TreeNode => {
    const n = ++bookmarkNo;
    return makeBookmark(`b-${String(n).padStart(12, '0')}`, `书签 ${n}`, `https://example${n}.test/path/${n}`);
  };
  const nextFolder = (title: string, children: TreeNode[]): TreeNode =>
    makeFolder(`f-${String(++folderNo).padStart(12, '0')}`, title, children);

  const bar: TreeNode[] = [];
  // 20 个一级目录 × 5 个二级目录 = 120 个文件夹；每个二级目录 8 条书签 = 800 条。
  for (let i = 0; i < 20; i++) {
    const subs: TreeNode[] = [];
    for (let j = 0; j < 5; j++) {
      const leaves: TreeNode[] = [];
      for (let k = 0; k < 8; k++) leaves.push(nextBookmark());
      subs.push(nextFolder(`子目录 ${i}-${j}`, leaves));
    }
    bar.push(nextFolder(`目录 ${i}`, subs));
  }
  // 余下 100 条散放在书签栏根下，凑够 900。
  const other: TreeNode[] = [];
  for (let i = 0; i < 50; i++) bar.push(nextBookmark());
  for (let i = 0; i < 50; i++) other.push(nextBookmark());

  return tree(bar, other);
}

/** 计数式映射存储，模拟 storage.local 的写入次数（不模拟其延迟）。 */
function countingMapping(initial: GuidMap = {}): { table: MappingTable; writes: () => number } {
  let writes = 0;
  const table = new MappingTable(initial, async () => {
    writes++;
  });
  return { table, writes: () => writes };
}

describe('性能基准：900 书签 / 120 文件夹（需求第 3 节设计指标）', () => {
  const target = designTargetTree();

  it('造出的树符合设计指标', () => {
    expect(countRoots(target)).toEqual({ bookmarks: 900, folders: 120 });
  });

  it('全量应用（空树 → 900/120）在预算内完成', async () => {
    const fake = new FakeBookmarks();
    const { table, writes } = countingMapping();

    const planStart = performance.now();
    const ops = buildPlan(tree(), target);
    const planMs = performance.now() - planStart;

    const applyStart = performance.now();
    const result = await applyLocalPlan(fake, ops, {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
    });
    const applyMs = performance.now() - applyStart;

    const summary = summarizePlan(ops);
    console.log(
      [
        '全量应用 900/120：',
        `  计划生成 ${planMs.toFixed(0)}ms，操作 ${ops.length} 条 ${JSON.stringify(summary)}`,
        `  应用 ${applyMs.toFixed(0)}ms`,
        `  API 调用 ${JSON.stringify(fake.calls)}`,
        `  映射写入 ${writes()} 次`,
      ].join('\n'),
    );

    expect(result.created).toBe(1020);
    // 门禁：扩展自身开销 < 5s（方案 8 M2 验收）。
    expect(planMs + applyMs).toBeLessThan(5000);
    // 映射逐条写入：1020 个条目 1020 次（INV-2 要求创建即持久化）。
    expect(writes()).toBe(1020);
  });

  it('读回 900/120 的树也在预算内', async () => {
    const fake = new FakeBookmarks();
    const planted = plantRoots(fake, target);
    const { table } = countingMapping(planted);

    const start = performance.now();
    const read = await readLocalTree(fake, table, () => {
      throw new Error('不应有未映射的节点');
    });
    const ms = performance.now() - start;

    console.log(`读回 900/120：${ms.toFixed(0)}ms`);
    expect(countRoots(read.roots)).toEqual({ bookmarks: 900, folders: 120 });
    expect(ms).toBeLessThan(2000);
  });

  it('无改动时计划为空，应用不产生任何 API 调用', async () => {
    // 定时同步在无改动时的常态路径（FR-14）。
    const fake = new FakeBookmarks();
    const { table } = countingMapping(plantRoots(fake, target));
    fake.resetCalls();

    const ops = buildPlan(target, target);
    expect(ops).toEqual([]);
    await applyLocalPlan(fake, ops, {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
    });
    expect(fake.calls).toMatchObject({ create: 0, update: 0, move: 0, remove: 0, getChildren: 0 });
  });

  it('典型增量改动（新增 10 条 + 改名 5 条）的调用次数与改动量成比例', async () => {
    const fake = new FakeBookmarks();
    const { table } = countingMapping(plantRoots(fake, target));

    const changed = structuredClone(target) as Roots;
    for (let i = 0; i < 10; i++) {
      changed.bar.children.push(
        makeBookmark(`b-${String(9000 + i).padStart(12, '0')}`, `新增 ${i}`, `https://new${i}.test/`),
      );
    }
    for (let i = 0; i < 5; i++) changed.other.children[i]!.title = `改名 ${i}`;

    fake.resetCalls();
    const ops = buildPlan(target, changed);
    const start = performance.now();
    await applyLocalPlan(fake, ops, {
      mapping: table,
      rootIds: { bar: fake.barId, other: fake.otherId },
    });
    const ms = performance.now() - start;

    console.log(`增量改动 15 处：${ms.toFixed(0)}ms，API 调用 ${JSON.stringify(fake.calls)}`);
    expect(fake.calls.create).toBe(10);
    expect(fake.calls.update).toBe(5);
    // 关键：调用次数不随书签总量增长。
    expect(fake.calls.create + fake.calls.update + fake.calls.move + fake.calls.remove).toBe(15);
    expect(ms).toBeLessThan(1000);
  });
});
