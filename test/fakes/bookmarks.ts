/**
 * test/fakes/bookmarks.ts —— 内存版 chrome.bookmarks（方案 1.3 test/fakes）。
 *
 * 刻意复刻真实 API 的约束，而不是做一个宽容的替身 —— 替身越宽容，测试就越
 * 容易放过只在真实浏览器里才暴露的错误：
 *   · create/move 的 index 越界抛错（Chrome 报 "Index out of bounds"）；
 *   · move 不传 index 时追加到末尾；
 *   · remove 非空文件夹抛错（Chrome 要求用 removeTree）；
 *   · 不得把文件夹移入自身子树；
 *   · 每次返回节点的副本，调用方改不动内部状态。
 *
 * 同父 move 的 index 语义在真实 Chrome 上各版本不一致，是一类经典差一错误。
 * 这里按「先移除、再按 index 插入」实现，同时 platform/bookmarks.ts 的
 * reorder 完全不依赖该语义（只用不带 index 的「移到末尾」），因此这个选择
 * 不会把线上行为绑到某一种解释上。
 */

import type { BookmarkNode, BookmarksApi } from '../../src/platform/bookmarks.js';
import type { GuidMap } from '../../src/shared/types.js';
import { isFolder, type Roots, type TreeNode } from '../../src/domain/tree.js';

interface Entry {
  id: string;
  parentId: string | null;
  title: string;
  url?: string;
  folderType?: string;
  unmodifiable?: string;
  children: string[];
}

export interface FakeBookmarksOptions {
  /** 逻辑根之外额外插入的顶层文件夹，用于测试 managed / mobile 场景。 */
  extraRoots?: { title: string; folderType?: string; at?: number }[];
  /** 不给逻辑根设置 folderType，模拟 Chromium 138 之前的浏览器。 */
  withoutFolderType?: boolean;
  /**
   * 同父 move 时 index 的解释方式。真实 Chrome 各版本不一致，这正是
   * platform/bookmarks.ts 的 reorder 刻意不传 index 的原因。
   *   'afterRemoval'  —— 先摘掉节点，index 是新数组里的位置（默认）
   *   'beforeRemoval' —— index 是原数组里的位置，摘除发生在插入之后
   * 两种都提供，用来验证 reorder 的实现真的与该语义无关。
   */
  sameParentIndex?: 'afterRemoval' | 'beforeRemoval';
}

export class FakeBookmarks implements BookmarksApi {
  private readonly entries = new Map<string, Entry>();
  private nextId = 1;
  /** 调用计数，用于断言「不做多余往返」这类性能要求。 */
  readonly calls = { getTree: 0, getChildren: 0, create: 0, update: 0, move: 0, remove: 0 };

  readonly rootId: string;
  readonly barId: string;
  readonly otherId: string;
  private readonly sameParentIndex: 'afterRemoval' | 'beforeRemoval';

  constructor(options: FakeBookmarksOptions = {}) {
    this.sameParentIndex = options.sameParentIndex ?? 'afterRemoval';
    this.rootId = this.insert(null, { title: '' });
    const ft = options.withoutFolderType === true;
    this.barId = this.insert(this.rootId, {
      title: '书签栏',
      ...(ft ? {} : { folderType: 'bookmarks-bar' }),
    });
    this.otherId = this.insert(this.rootId, {
      title: '其他书签',
      ...(ft ? {} : { folderType: 'other' }),
    });
    for (const extra of options.extraRoots ?? []) {
      const id = this.insert(this.rootId, {
        title: extra.title,
        ...(extra.folderType === undefined ? {} : { folderType: extra.folderType }),
      });
      const root = this.entries.get(this.rootId)!;
      // 允许插到前面，用来验证纯位置推断会被 managed 文件夹带偏。
      root.children.splice(root.children.indexOf(id), 1);
      root.children.splice(extra.at ?? root.children.length, 0, id);
    }
  }

  // ── 测试辅助 ───────────────────────────────────────────────────────

  /** 直接建节点，绕过 API 计数。返回新 ID。 */
  seed(parentId: string, node: { title: string; url?: string; unmodifiable?: string }): string {
    return this.insert(parentId, node);
  }

  /** 便捷地铺一棵子树：[标题, url?] 或 [标题, 子项数组]。 */
  seedTree(parentId: string, spec: readonly (readonly [string, string | readonly unknown[]])[]): void {
    for (const [title, rest] of spec) {
      if (typeof rest === 'string') this.insert(parentId, { title, url: rest });
      else {
        const id = this.insert(parentId, { title });
        this.seedTree(id, rest as readonly (readonly [string, string | readonly unknown[]])[]);
      }
    }
  }

  /** 某个文件夹的子项标题序列，断言顺序时用。 */
  titlesOf(parentId: string): string[] {
    return this.entries.get(parentId)!.children.map((id) => this.entries.get(id)!.title);
  }

  idsOf(parentId: string): string[] {
    return [...this.entries.get(parentId)!.children];
  }

  get size(): number {
    // 不含 root 与两棵逻辑根。
    return this.entries.size - 3;
  }

  resetCalls(): void {
    for (const key of Object.keys(this.calls) as (keyof typeof this.calls)[]) this.calls[key] = 0;
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private insert(
    parentId: string | null,
    node: { title: string; url?: string; folderType?: string; unmodifiable?: string },
    index?: number,
  ): string {
    const id = String(this.nextId++);
    const entry: Entry = { id, parentId, title: node.title, children: [] };
    if (node.url !== undefined) entry.url = node.url;
    if (node.folderType !== undefined) entry.folderType = node.folderType;
    if (node.unmodifiable !== undefined) entry.unmodifiable = node.unmodifiable;
    this.entries.set(id, entry);
    if (parentId !== null) {
      const parent = this.entries.get(parentId);
      if (parent === undefined) throw new Error(`Can't find parent bookmark for ${parentId}`);
      if (parent.url !== undefined) throw new Error('Parent is not a folder');
      parent.children.splice(index ?? parent.children.length, 0, id);
    }
    return id;
  }

  private toNode(entry: Entry, deep: boolean): BookmarkNode {
    const parent = entry.parentId === null ? undefined : this.entries.get(entry.parentId);
    const node: BookmarkNode = { id: entry.id, title: entry.title };
    if (entry.parentId !== null) node.parentId = entry.parentId;
    if (parent !== undefined) node.index = parent.children.indexOf(entry.id);
    if (entry.url !== undefined) node.url = entry.url;
    if (entry.folderType !== undefined) node.folderType = entry.folderType;
    if (entry.unmodifiable !== undefined) node.unmodifiable = entry.unmodifiable;
    if (entry.url === undefined) {
      node.children = deep ? entry.children.map((id) => this.toNode(this.entries.get(id)!, true)) : [];
    }
    return node;
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`Can't find bookmark for id: ${id}`);
    return entry;
  }

  private descendantOf(candidate: string, ancestor: string): boolean {
    let cur: string | null = candidate;
    while (cur !== null) {
      if (cur === ancestor) return true;
      cur = this.entries.get(cur)?.parentId ?? null;
    }
    return false;
  }

  // ── BookmarksApi ───────────────────────────────────────────────────

  async getTree(): Promise<BookmarkNode[]> {
    this.calls.getTree++;
    return [this.toNode(this.require(this.rootId), true)];
  }

  async getChildren(id: string): Promise<BookmarkNode[]> {
    this.calls.getChildren++;
    const entry = this.require(id);
    if (entry.url !== undefined) throw new Error('Bookmark is not a folder');
    return entry.children.map((child) => this.toNode(this.require(child), false));
  }

  async create(arg: { parentId: string; index?: number; title: string; url?: string }): Promise<BookmarkNode> {
    this.calls.create++;
    const parent = this.require(arg.parentId);
    if (parent.url !== undefined) throw new Error('Parent is not a folder');
    if (arg.index !== undefined && (arg.index < 0 || arg.index > parent.children.length)) {
      throw new Error('Index out of bounds.');
    }
    const spec: { title: string; url?: string } = { title: arg.title };
    if (arg.url !== undefined) spec.url = arg.url;
    const id = this.insert(arg.parentId, spec, arg.index);
    return this.toNode(this.require(id), false);
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode> {
    this.calls.update++;
    const entry = this.require(id);
    if (entry.unmodifiable !== undefined) throw new Error("Can't modify the root bookmark folders.");
    if (changes.title !== undefined) entry.title = changes.title;
    if (changes.url !== undefined) {
      if (entry.url === undefined) throw new Error("Can't set URL of a folder.");
      entry.url = changes.url;
    }
    return this.toNode(entry, false);
  }

  async move(id: string, dest: { parentId?: string; index?: number }): Promise<BookmarkNode> {
    this.calls.move++;
    const entry = this.require(id);
    if (entry.parentId === null) throw new Error("Can't move the root folder.");
    const destId = dest.parentId ?? entry.parentId;
    const destEntry = this.require(destId);
    if (destEntry.url !== undefined) throw new Error('Parent is not a folder');
    if (this.descendantOf(destId, id)) throw new Error("Can't move a folder into itself or its descendant.");

    const from = this.require(entry.parentId);
    const oldIndex = from.children.indexOf(id);
    const sameParent = destId === entry.parentId;

    if (dest.index !== undefined && (dest.index < 0 || dest.index > destEntry.children.length)) {
      throw new Error('Index out of bounds.');
    }

    // 同父移动时两种解释的差别：'beforeRemoval' 下，目标位置在原节点之后的话，
    // 摘除会把它前移一格。跨父移动没有歧义。
    let target = dest.index ?? Number.POSITIVE_INFINITY;
    if (sameParent && dest.index !== undefined && this.sameParentIndex === 'beforeRemoval' && oldIndex < dest.index) {
      target = dest.index - 1;
    }

    from.children.splice(oldIndex, 1);
    destEntry.children.splice(Math.min(target, destEntry.children.length), 0, id);
    entry.parentId = destId;
    return this.toNode(entry, false);
  }

  async remove(id: string): Promise<void> {
    this.calls.remove++;
    const entry = this.require(id);
    if (entry.parentId === null) throw new Error("Can't remove the root folder.");
    if (entry.unmodifiable !== undefined) throw new Error("Can't modify the root bookmark folders.");
    if (entry.url === undefined && entry.children.length > 0) {
      throw new Error("Can't remove non-empty folder (use recursive to force).");
    }
    const parent = this.require(entry.parentId);
    parent.children.splice(parent.children.indexOf(id), 1);
    this.entries.delete(id);
  }
}

/**
 * 按一棵 domain 树在 fake 里铺出对应的浏览器节点，并返回 localId → GUID 映射。
 *
 * 有了它，测试可以从一个「已知 GUID 的既有本地树」出发，这是验证
 * platform 应用器与 domain 参考实现等价的前提。
 */
export function plantRoots(fake: FakeBookmarks, roots: Roots): GuidMap {
  const mapping: GuidMap = {};

  const plant = (parentId: string, nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (isFolder(node)) {
        const id = fake.seed(parentId, { title: node.title });
        mapping[id] = node.guid;
        plant(id, node.children);
      } else {
        const id = fake.seed(parentId, { title: node.title, url: node.url });
        mapping[id] = node.guid;
      }
    }
  };

  plant(fake.barId, roots.bar.children);
  plant(fake.otherId, roots.other.children);
  return mapping;
}
