/**
 * domain/tree.ts —— 快照树模型与索引。
 *
 * 纯模块：无 I/O、无 chrome API、无时间与随机源（技术规划方案 1.2 红线一）。
 * 数据格式严格遵循需求文档 5.2。
 */

export type Guid = string;

/** 逻辑根（需求 2 术语表 / 6.5）：跨设备对应的顶层文件夹，只有两个。 */
export type RootKey = 'bar' | 'other';

export const ROOT_KEYS: readonly RootKey[] = ['bar', 'other'];

/** 逻辑根的 GUID 是固定常量，不随设备变化。 */
export const ROOT_GUID: Record<RootKey, Guid> = {
  bar: 'root-bar',
  other: 'root-other',
};

/** 逻辑根记录在索引中的父 GUID 哨兵值。逻辑根本身不参与增删改。 */
export const NO_PARENT: Guid = '';

export type NodeType = 'bookmark' | 'folder';

export interface Bookmark {
  guid: Guid;
  type: 'bookmark';
  title: string;
  url: string;
}

export interface Folder {
  guid: Guid;
  type: 'folder';
  title: string;
  children: TreeNode[];
}

export type TreeNode = Bookmark | Folder;

/** 两棵逻辑根构成的森林。 */
export type Roots = Record<RootKey, Folder>;

export interface Snapshot {
  formatVersion: 1;
  version: number;
  writerNonce: string;
  writtenAt: string;
  writtenBy: string;
  contentHash: string;
  roots: Roots;
}

export const FORMAT_VERSION = 1 as const;

/** 展平后的节点记录，是 merge 判定矩阵（方案 2.4）的输入单元。 */
export interface NodeRecord {
  guid: Guid;
  type: NodeType;
  title: string;
  /** 仅书签有值。exactOptionalPropertyTypes 下不写入 undefined。 */
  url?: string;
  parentGuid: Guid;
  index: number;
}

export type NodeIndex = Map<Guid, NodeRecord>;

// ── 判定与构造 ────────────────────────────────────────────────────────

export function isFolder(node: TreeNode): node is Folder {
  return node.type === 'folder';
}

export function isBookmark(node: TreeNode): node is Bookmark {
  return node.type === 'bookmark';
}

export function isRootGuid(guid: Guid): boolean {
  return guid === ROOT_GUID.bar || guid === ROOT_GUID.other;
}

export function rootKeyOf(guid: Guid): RootKey | null {
  if (guid === ROOT_GUID.bar) return 'bar';
  if (guid === ROOT_GUID.other) return 'other';
  return null;
}

export function makeFolder(guid: Guid, title: string, children: TreeNode[] = []): Folder {
  return { guid, type: 'folder', title, children };
}

export function makeBookmark(guid: Guid, title: string, url: string): Bookmark {
  return { guid, type: 'bookmark', title, url };
}

/** 默认标题取自需求 5.2 的示例，仅在无任何已知标题时使用。 */
export const DEFAULT_ROOT_TITLE: Record<RootKey, string> = {
  bar: '书签栏',
  other: '其他书签',
};

export function emptyRoots(titles?: Partial<Record<RootKey, string>>): Roots {
  return {
    bar: makeFolder(ROOT_GUID.bar, titles?.bar ?? DEFAULT_ROOT_TITLE.bar),
    other: makeFolder(ROOT_GUID.other, titles?.other ?? DEFAULT_ROOT_TITLE.other),
  };
}

export function cloneRoots(roots: Roots): Roots {
  return { bar: cloneNode(roots.bar) as Folder, other: cloneNode(roots.other) as Folder };
}

export function cloneNode(node: TreeNode): TreeNode {
  if (isFolder(node)) {
    return { guid: node.guid, type: 'folder', title: node.title, children: node.children.map(cloneNode) };
  }
  return { guid: node.guid, type: 'bookmark', title: node.title, url: node.url };
}

// ── 遍历 ─────────────────────────────────────────────────────────────

export interface WalkEntry {
  node: TreeNode;
  parentGuid: Guid;
  index: number;
  rootKey: RootKey;
  /** 从逻辑根（不含）到本节点（不含）的标题路径，用于首次同步的文件夹匹配（需求 6.4）。 */
  path: readonly string[];
}

/**
 * 深度优先前序遍历两棵逻辑根的全部后代。逻辑根自身不产出条目。
 */
export function* walk(roots: Roots): Generator<WalkEntry> {
  for (const key of ROOT_KEYS) {
    yield* walkFolder(roots[key], key, []);
  }
}

function* walkFolder(folder: Folder, rootKey: RootKey, path: readonly string[]): Generator<WalkEntry> {
  for (let i = 0; i < folder.children.length; i++) {
    const child = folder.children[i];
    if (!child) continue;
    yield { node: child, parentGuid: folder.guid, index: i, rootKey, path };
    if (isFolder(child)) {
      yield* walkFolder(child, rootKey, [...path, child.title]);
    }
  }
}

/** 展平为 GUID → 记录的索引（方案 2.2 阶段 A）。逻辑根不入索引。 */
export function indexRoots(roots: Roots): NodeIndex {
  const map: NodeIndex = new Map();
  for (const { node, parentGuid, index } of walk(roots)) {
    map.set(node.guid, toRecord(node, parentGuid, index));
  }
  return map;
}

export function toRecord(node: TreeNode, parentGuid: Guid, index: number): NodeRecord {
  return isFolder(node)
    ? { guid: node.guid, type: 'folder', title: node.title, parentGuid, index }
    : { guid: node.guid, type: 'bookmark', title: node.title, url: node.url, parentGuid, index };
}

export function findNode(roots: Roots, guid: Guid): TreeNode | null {
  const rootKey = rootKeyOf(guid);
  if (rootKey) return roots[rootKey];
  for (const { node } of walk(roots)) {
    if (node.guid === guid) return node;
  }
  return null;
}

/** 某节点的全部后代 GUID（含自身），用于删除计数（方案 4.1：文件夹按子树全部计入）。 */
export function subtreeGuids(node: TreeNode): Guid[] {
  const acc: Guid[] = [];
  const push = (n: TreeNode): void => {
    acc.push(n.guid);
    if (isFolder(n)) n.children.forEach(push);
  };
  push(node);
  return acc;
}

export interface Counts {
  bookmarks: number;
  folders: number;
}

export function countRoots(roots: Roots): Counts {
  let bookmarks = 0;
  let folders = 0;
  for (const { node } of walk(roots)) {
    if (isFolder(node)) folders++;
    else bookmarks++;
  }
  return { bookmarks, folders };
}

/** 条目总数，用于删除保护的分母（方案 4.1）。 */
export function totalEntries(roots: Roots): number {
  const c = countRoots(roots);
  return c.bookmarks + c.folders;
}

// ── 快照封装 ──────────────────────────────────────────────────────────

export interface SnapshotMeta {
  version: number;
  writerNonce: string;
  writtenAt: string;
  writtenBy: string;
  contentHash: string;
}

export function makeSnapshot(roots: Roots, meta: SnapshotMeta): Snapshot {
  return {
    formatVersion: FORMAT_VERSION,
    version: meta.version,
    writerNonce: meta.writerNonce,
    writtenAt: meta.writtenAt,
    writtenBy: meta.writtenBy,
    contentHash: meta.contentHash,
    roots,
  };
}

/** 空基线：首次同步时作为三方合并的公共祖先（需求 6.4）。 */
export function emptySnapshot(): Snapshot {
  return makeSnapshot(emptyRoots(), {
    version: 0,
    writerNonce: '',
    writtenAt: '1970-01-01T00:00:00.000Z',
    writtenBy: '',
    contentHash: '',
  });
}
