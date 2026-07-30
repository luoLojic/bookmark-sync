/**
 * test/fixtures/trees.ts —— 树构造与随机生成，供 domain 各模块的测试共用。
 */

import fc from 'fast-check';
import { emptyRoots, makeBookmark, makeFolder, type Roots, type TreeNode } from '../../src/domain/tree.js';

/** 只填两棵逻辑根的便捷构造。 */
export function tree(bar: TreeNode[] = [], other: TreeNode[] = []): Roots {
  const roots = emptyRoots();
  roots.bar.children = bar;
  roots.other.children = other;
  return roots;
}

export const bk = (guid: string, title: string, url = 'https://x.test/'): TreeNode =>
  makeBookmark(guid, title, url);

export const fd = (guid: string, title: string, children: TreeNode[] = []): TreeNode =>
  makeFolder(guid, title, children);

/** 树形状：'b' 为书签，数组为文件夹及其子项。 */
export type Shape = 'b' | Shape[];

export const shapeArb: fc.Memo<Shape> = fc.memo((depth) =>
  depth <= 1
    ? fc.constant<Shape>('b')
    : fc.oneof(fc.constant<Shape>('b'), fc.array(shapeArb(depth - 1), { maxLength: 3 })),
);

export const forestArb = fc.array(shapeArb(3), { maxLength: 4 });

/**
 * 形状 → 真实树。GUID 按遍历序确定性编号，便于 fast-check 收缩到最小反例。
 * counter 由调用方传入，使两棵根共享同一编号空间。
 */
export function buildForest(shapes: readonly Shape[], counter: { n: number }): TreeNode[] {
  return shapes.map((shape) => {
    const id = String(++counter.n).padStart(12, '0');
    return shape === 'b'
      ? makeBookmark(`b-${id}`, `T${id}`, `https://t${id}.test/`)
      : makeFolder(`f-${id}`, `F${id}`, buildForest(shape, counter));
  });
}

/** 随机双根树。两棵根共享 GUID 编号空间，因此不同样本间 GUID 会重叠 —— 这是有意的，合并测试需要重叠。 */
export const rootsArb = fc.tuple(forestArb, forestArb).map(([barShapes, otherShapes]) => {
  const counter = { n: 0 };
  return tree(buildForest(barShapes, counter), buildForest(otherShapes, counter));
});
