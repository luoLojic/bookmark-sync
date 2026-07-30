import { describe, expect, it } from 'vitest';
import {
  countDeletions,
  deletedRecords,
  diff,
  diffIndexes,
  isEmptyDiff,
  summarize,
} from '../../src/domain/diff.js';
import {
  emptyRoots,
  indexRoots,
  makeBookmark,
  makeFolder,
  type Roots,
  type TreeNode,
} from '../../src/domain/tree.js';

const B1 = 'b-000000000001';
const B2 = 'b-000000000002';
const B3 = 'b-000000000003';
const F1 = 'f-000000000001';
const F2 = 'f-000000000002';

/** 便捷构造：只填 bar 根。 */
function bar(...children: TreeNode[]): Roots {
  const roots = emptyRoots();
  roots.bar.children = children;
  return roots;
}

function kinds(result: ReturnType<typeof diff>): string[] {
  return result.ops.map((op) => `${op.kind}:${op.guid}`).sort();
}

describe('diff — 操作分类（需求 6.1）', () => {
  it('reports nothing for identical trees', () => {
    const tree = bar(makeBookmark(B1, 'MDN', 'https://a.test/'), makeFolder(F1, '技术'));
    const result = diff(tree, tree);
    expect(result.ops).toEqual([]);
    expect(isEmptyDiff(result)).toBe(true);
  });

  it('reports CREATE for nodes only present in the target', () => {
    const result = diff(bar(), bar(makeBookmark(B1, 'MDN', 'https://a.test/')));
    expect(kinds(result)).toEqual([`create:${B1}`]);
    const op = result.ops[0]!;
    expect(op.kind).toBe('create');
    if (op.kind === 'create') {
      expect(op.after).toMatchObject({ guid: B1, type: 'bookmark', title: 'MDN', parentGuid: 'root-bar', index: 0 });
    }
  });

  it('reports DELETE for nodes only present in the source', () => {
    const result = diff(bar(makeBookmark(B1, 'MDN', 'https://a.test/')), bar());
    expect(kinds(result)).toEqual([`delete:${B1}`]);
    const op = result.ops[0]!;
    if (op.kind === 'delete') expect(op.before.title).toBe('MDN');
  });

  it('reports UPDATE when the title changes', () => {
    const result = diff(
      bar(makeBookmark(B1, 'MDN', 'https://a.test/')),
      bar(makeBookmark(B1, 'MDN Web Docs', 'https://a.test/')),
    );
    expect(kinds(result)).toEqual([`update:${B1}`]);
    const op = result.ops[0]!;
    if (op.kind === 'update') {
      expect(op.fields).toEqual(['title']);
      expect(op.before.title).toBe('MDN');
      expect(op.after.title).toBe('MDN Web Docs');
    }
  });

  it('reports UPDATE when the url changes', () => {
    const result = diff(
      bar(makeBookmark(B1, 'MDN', 'https://a.test/')),
      bar(makeBookmark(B1, 'MDN', 'https://b.test/')),
    );
    const op = result.ops[0]!;
    if (op.kind === 'update') expect(op.fields).toEqual(['url']);
  });

  it('lists both fields when title and url change together', () => {
    const result = diff(
      bar(makeBookmark(B1, 'MDN', 'https://a.test/')),
      bar(makeBookmark(B1, 'Docs', 'https://b.test/')),
    );
    const op = result.ops[0]!;
    if (op.kind === 'update') expect(op.fields).toEqual(['title', 'url']);
  });

  it('reports MOVE when the parent folder changes', () => {
    const before = bar(makeBookmark(B1, 'MDN', 'https://a.test/'), makeFolder(F1, '技术'));
    const after = bar(makeFolder(F1, '技术', [makeBookmark(B1, 'MDN', 'https://a.test/')]));
    const result = diff(before, after);
    expect(kinds(result)).toEqual([`move:${B1}`]);
    const op = result.ops.find((o) => o.kind === 'move')!;
    if (op.kind === 'move') {
      expect(op.before.parentGuid).toBe('root-bar');
      expect(op.after.parentGuid).toBe(F1);
      expect(op.after.index).toBe(0);
    }
  });

  it('reports MOVE across logical roots', () => {
    const before = bar(makeBookmark(B1, 'MDN', 'https://a.test/'));
    const after = emptyRoots();
    after.other.children = [makeBookmark(B1, 'MDN', 'https://a.test/')];
    const op = diff(before, after).ops[0]!;
    expect(op.kind).toBe('move');
    if (op.kind === 'move') expect(op.after.parentGuid).toBe('root-other');
  });
});

describe('diff — 顺序不是独立操作（需求 6.3）', () => {
  it('ignores sibling reordering within the same parent', () => {
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeBookmark(B2, 'B', 'https://b.test/'));
    const b = bar(makeBookmark(B2, 'B', 'https://b.test/'), makeBookmark(B1, 'A', 'https://a.test/'));
    // 兄弟重排由 order.ts 与 plan.ts 的 reorder 处理，不产生 diff 操作。
    expect(diff(a, b).ops).toEqual([]);
  });

  it('ignores index shifts caused by a sibling being removed', () => {
    const a = bar(
      makeBookmark(B1, 'A', 'https://a.test/'),
      makeBookmark(B2, 'B', 'https://b.test/'),
      makeBookmark(B3, 'C', 'https://c.test/'),
    );
    const b = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeBookmark(B3, 'C', 'https://c.test/'));
    // B3 的 index 从 2 变 1，但那是 B2 被删的副作用，不是一次移动。
    expect(kinds(diff(a, b))).toEqual([`delete:${B2}`]);
  });

  it('still reports a move when the parent changes even if the index is unchanged', () => {
    const a = bar(makeFolder(F1, '甲', [makeBookmark(B1, 'X', 'https://x.test/')]), makeFolder(F2, '乙'));
    const b = bar(makeFolder(F1, '甲'), makeFolder(F2, '乙', [makeBookmark(B1, 'X', 'https://x.test/')]));
    expect(kinds(diff(a, b))).toEqual([`move:${B1}`]);
  });
});

describe('diff — 组合与边界', () => {
  it('emits update and move as separate operations for one node', () => {
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeFolder(F1, '技术'));
    const b = bar(makeFolder(F1, '技术', [makeBookmark(B1, 'A2', 'https://a.test/')]));
    // 需求 6.1 把 UPDATE 与 MOVE 列为两类操作，分开输出便于 plan.ts 排序。
    expect(kinds(diff(a, b))).toEqual([`move:${B1}`, `update:${B1}`]);
  });

  it('treats a guid whose type changed as delete plus create', () => {
    // GUID 前缀编码类型，正常不会发生；防御性处理，避免把书签当文件夹更新。
    const a = bar(makeBookmark(B1, 'X', 'https://x.test/'));
    const b = bar(makeFolder(B1, 'X'));
    expect(kinds(diff(a, b))).toEqual([`create:${B1}`, `delete:${B1}`]);
  });

  it('reports one delete per node when a whole folder disappears', () => {
    const a = bar(makeFolder(F1, '技术', [makeBookmark(B1, 'A', 'https://a.test/'), makeFolder(F2, '前端', [makeBookmark(B2, 'B', 'https://b.test/')])]));
    const result = diff(a, bar());
    // 子树逐节点计入，是删除保护分子的来源（方案 4.1）。
    expect(kinds(result)).toEqual([`delete:${B1}`, `delete:${B2}`, `delete:${F1}`, `delete:${F2}`]);
    expect(countDeletions(result)).toBe(4);
  });

  it('never reports operations for the logical roots themselves', () => {
    // 逻辑根只作容器，不参与增删改（需求 6.5）。
    const a = emptyRoots({ bar: '书签栏', other: '其他书签' });
    const b = emptyRoots({ bar: 'Bookmarks bar', other: 'Other bookmarks' });
    expect(diff(a, b).ops).toEqual([]);
  });

  it('detects folder title changes', () => {
    const result = diff(bar(makeFolder(F1, '技术')), bar(makeFolder(F1, '技术资料')));
    const op = result.ops[0]!;
    expect(op.kind).toBe('update');
    if (op.kind === 'update') expect(op.fields).toEqual(['title']);
  });

  it('is antisymmetric: create in one direction is delete in the other', () => {
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'));
    const b = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeBookmark(B2, 'B', 'https://b.test/'));
    expect(kinds(diff(a, b))).toEqual([`create:${B2}`]);
    expect(kinds(diff(b, a))).toEqual([`delete:${B2}`]);
  });
});

describe('diffIndexes / summarize', () => {
  it('accepts prebuilt indexes so callers can avoid re-walking trees', () => {
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'));
    const b = bar(makeBookmark(B1, 'A2', 'https://a.test/'));
    expect(diffIndexes(indexRoots(a), indexRoots(b))).toEqual(diff(a, b));
  });

  it('counts operations by kind', () => {
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeBookmark(B2, 'B', 'https://b.test/'), makeFolder(F1, 'F'));
    const b = bar(makeFolder(F1, 'F', [makeBookmark(B1, 'A!', 'https://a.test/')]), makeBookmark(B3, 'C', 'https://c.test/'));
    const s = summarize(diff(a, b));
    expect(s).toEqual({ create: 1, delete: 1, update: 1, move: 1 });
  });

  it('treats an empty tree pair as no change', () => {
    expect(isEmptyDiff(diff(emptyRoots(), emptyRoots()))).toBe(true);
    expect(summarize(diff(emptyRoots(), emptyRoots()))).toEqual({ create: 0, delete: 0, update: 0, move: 0 });
  });

  it('exposes the deleted records for the confirmation dialog (FR-10)', () => {
    // 弹窗要列出「将要丢失的条目」，需要标题与 URL，不只是数量。
    const a = bar(makeBookmark(B1, 'A', 'https://a.test/'), makeFolder(F1, '技术'));
    const records = deletedRecords(diff(a, bar()));
    expect(records.map((r) => r.title).sort()).toEqual(['A', '技术']);
    expect(records.find((r) => r.guid === B1)?.url).toBe('https://a.test/');
    expect(deletedRecords(diff(a, a))).toEqual([]);
  });
});
