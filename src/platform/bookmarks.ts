/**
 * platform/bookmarks.ts —— chrome.bookmarks 适配（方案 5.2 / 需求 6.5）。
 *
 * 三件事：
 *   1. 读树：浏览器树 → GUID 标识的 Roots，顺带为未映射的节点分配 GUID；
 *   2. 逻辑根识别：按位置取前两个，并用 Chromium 138+ 的 folderType 校验；
 *   3. 应用计划：把 domain/plan.ts 的 LocalOp 序列翻译成浏览器 API 调用。
 *
 * 语义基准是 domain/plan.ts 的 applyPlan：同一个操作序列，两者必须产出同样的
 * 树。差别只在 applyPlan 用纯数组操作，而这里要面对一个没有事务、索引语义还
 * 有歧义的真实 API。
 *
 * 索引歧义的处理（重要）：chrome.bookmarks.move 在**同父**移动时，index 是
 * 按移除前还是移除后的数组解释，各版本行为不一致，是一类经典的差一错误来源。
 * 本实现绕开了这个问题 ——
 *   · create 的 index 无歧义（不涉及移除），照传；
 *   · plan.ts 只在父变化时产出 move，因此 move 一定跨父，index 也无歧义；
 *   · 同父的兄弟重排一律由 reorder 操作承担，其实现只把节点往左拉或移到末尾，
 *     从不把节点越过它当前位置往右插 —— 两种解释的差别恰好只出现在往右插的
 *     情形，因此结果与解释无关。test/platform/bookmarks.test.ts 用两种语义的
 *     假实现各跑一遍重排，把这个主张真正测出来。
 */

import { ROOT_GUID, ROOT_KEYS, makeBookmark, makeFolder } from '../domain/tree.js';
import type { Guid, RootKey, Roots, TreeNode } from '../domain/tree.js';
import type { LocalOp } from '../domain/plan.js';
import type { GuidMap } from '../shared/types.js';

/** 只声明本项目用到的字段。folderType 是 Chromium 138+ 才有，@types/chrome 尚未收录。 */
export interface BookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: BookmarkNode[];
  /** 'bookmarks-bar' | 'other' | 'mobile' | 'managed'（Chromium 138+）。 */
  folderType?: string;
  /** 'managed' 表示由策略下发，不可修改。 */
  unmodifiable?: string;
}

/** chrome.bookmarks 中本项目实际使用的子集。FakeBookmarks 实现同一接口。 */
export interface BookmarksApi {
  getTree(): Promise<BookmarkNode[]>;
  getChildren(id: string): Promise<BookmarkNode[]>;
  create(arg: { parentId: string; index?: number; title: string; url?: string }): Promise<BookmarkNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode>;
  move(id: string, dest: { parentId?: string; index?: number }): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
}

/** 真实浏览器实现。 */
export const chromeBookmarks: BookmarksApi = {
  getTree: () => chrome.bookmarks.getTree() as Promise<BookmarkNode[]>,
  getChildren: (id) => chrome.bookmarks.getChildren(id) as Promise<BookmarkNode[]>,
  create: (arg) => chrome.bookmarks.create(arg) as Promise<BookmarkNode>,
  update: (id, changes) => chrome.bookmarks.update(id, changes) as Promise<BookmarkNode>,
  move: (id, dest) => chrome.bookmarks.move(id, dest) as Promise<BookmarkNode>,
  remove: (id) => chrome.bookmarks.remove(id),
};

// ── 映射表（INV-2） ───────────────────────────────────────────────────

/**
 * localId ↔ GUID 双向映射。
 *
 * 正向存储在 chrome.storage.local（方案 3.1 的 `map` 键），反向索引在内存中
 * 构建。写入立即持久化 —— INV-2 允许且要求这样做：条目一旦创建成功，「它叫这个
 * GUID」就永久为真，提前写入不会让任何判断出错，而不写会导致中途崩溃后重复创建。
 */
export class MappingTable {
  private readonly forward: Map<string, Guid>;
  private readonly reverse: Map<Guid, string>;

  constructor(
    entries: GuidMap,
    private readonly persist: (entries: GuidMap) => Promise<void>,
  ) {
    this.forward = new Map(Object.entries(entries));
    this.reverse = new Map();
    for (const [localId, guid] of this.forward) this.reverse.set(guid, localId);
  }

  guidOf(localId: string): Guid | undefined {
    return this.forward.get(localId);
  }

  localIdOf(guid: Guid): string | undefined {
    return this.reverse.get(guid);
  }

  /** 立即落盘。需求 5.3 步骤 4：每创建一个条目立即持久化其 GUID 映射。 */
  async set(localId: string, guid: Guid): Promise<void> {
    this.remember(localId, guid);
    await this.persist({ [localId]: guid });
  }

  /** 只更新内存，由调用方随后批量落盘。用于读树时的批量分配。 */
  remember(localId: string, guid: Guid): void {
    const stale = this.forward.get(localId);
    if (stale !== undefined) this.reverse.delete(stale);
    this.forward.set(localId, guid);
    this.reverse.set(guid, localId);
  }

  async flush(entries: GuidMap): Promise<void> {
    if (Object.keys(entries).length > 0) await this.persist(entries);
  }

}

// ── 逻辑根识别（需求 6.5 / 方案 5.2） ────────────────────────────────

/** folderType 到逻辑根的对应。'mobile' 与 'managed' 都不同步。 */
const FOLDER_TYPE_TO_ROOT: Record<string, RootKey | null> = {
  'bookmarks-bar': 'bar',
  other: 'other',
  mobile: null,
  managed: null,
};

export interface RootResolution {
  ids: Record<RootKey, string>;
  nodes: Record<RootKey, BookmarkNode>;
  /** 位置推断与 folderType 不一致时的说明，交由调用方记日志。 */
  warnings: string[];
}

/**
 * 从 getTree() 的结果中找出两棵逻辑根。
 *
 * 需求 6.5 说「取 children 的第一个和第二个」，方案 5.2 补充说要用 folderType
 * 校验、不一致时以 folderType 为准。这个补充不是多余的谨慎：企业策略下发的
 * managed 书签文件夹会出现在 children 里，纯位置推断会把它当成逻辑根。
 */
export function resolveRoots(tree: readonly BookmarkNode[]): RootResolution {
  const root = tree[0];
  if (root === undefined) throw new Error('bookmarks: getTree() returned no root');
  const children = root.children ?? [];

  const warnings: string[] = [];
  const byType = new Map<RootKey, BookmarkNode>();
  let sawAnyFolderType = false;

  for (const child of children) {
    if (child.folderType === undefined) continue;
    sawAnyFolderType = true;
    const key = FOLDER_TYPE_TO_ROOT[child.folderType];
    // 未知的 folderType 按「不同步」处理，比误当作逻辑根安全。
    if (key !== null && key !== undefined && !byType.has(key)) byType.set(key, child);
  }

  // 位置推断：跳过明确不同步的类型，再取前两个。
  const positional = children.filter((c) => {
    if (c.folderType === undefined) return true;
    return FOLDER_TYPE_TO_ROOT[c.folderType] !== null;
  });

  const pick = (key: RootKey, at: number): BookmarkNode => {
    const typed = byType.get(key);
    const guessed = positional[at];
    if (typed !== undefined) {
      if (guessed !== undefined && guessed.id !== typed.id) {
        warnings.push(
          `逻辑根 ${key} 的位置推断（id=${guessed.id}）与 folderType（id=${typed.id}）不一致，以 folderType 为准`,
        );
      }
      return typed;
    }
    if (guessed === undefined) {
      throw new Error(`bookmarks: 无法识别逻辑根 ${key}，浏览器只报告了 ${positional.length} 个可同步的顶层文件夹`);
    }
    if (sawAnyFolderType) {
      // 有的子项带 folderType 而这一个没有 —— 值得记一笔，但仍按位置采用。
      warnings.push(`逻辑根 ${key} 缺少 folderType，按位置推断为 id=${guessed.id}`);
    }
    return guessed;
  };

  const bar = pick('bar', 0);
  const other = pick('other', 1);
  if (bar.id === other.id) {
    throw new Error('bookmarks: 两棵逻辑根解析到同一个文件夹');
  }

  return {
    ids: { bar: bar.id, other: other.id },
    nodes: { bar, other },
    warnings,
  };
}

// ── 读树 ─────────────────────────────────────────────────────────────

export interface ReadLocalResult {
  roots: Roots;
  rootIds: Record<RootKey, string>;
  /** 本次新分配的映射条目数，供日志与性能实测。 */
  assigned: number;
  warnings: string[];
}

/**
 * 读取本地书签树，翻译为 GUID 标识的 Roots。
 *
 * 未映射的节点在这里分配 GUID 并**立即批量落盘**。这一步不能省：若只在内存里
 * 分配、等提交成功再写，中途失败后下次读树会给同一个书签分配新 GUID，于是它
 * 在远端表现为「旧的被删、新的被加」—— 远端多一份重复，本地还少一条。INV-2
 * 明确允许提前写映射，正是为此。
 */
export async function readLocalTree(
  api: BookmarksApi,
  mapping: MappingTable,
  newGuid: (type: 'bookmark' | 'folder') => Guid,
): Promise<ReadLocalResult> {
  const resolution = resolveRoots(await api.getTree());
  const pending: GuidMap = {};
  let assigned = 0;

  const guidFor = (node: BookmarkNode): Guid => {
    const existing = mapping.guidOf(node.id);
    if (existing !== undefined) return existing;
    const guid = newGuid(node.url === undefined ? 'folder' : 'bookmark');
    mapping.remember(node.id, guid);
    pending[node.id] = guid;
    assigned++;
    return guid;
  };

  const convert = (node: BookmarkNode): TreeNode | null => {
    // 策略下发的条目不可修改，同步它只会在应用阶段报错。
    if (node.unmodifiable !== undefined) return null;
    if (node.url === undefined) {
      const children: TreeNode[] = [];
      for (const child of node.children ?? []) {
        const converted = convert(child);
        if (converted !== null) children.push(converted);
      }
      return makeFolder(guidFor(node), node.title, children);
    }
    return makeBookmark(guidFor(node), node.title, node.url);
  };

  const roots = {} as Roots;
  for (const key of ROOT_KEYS) {
    const source = resolution.nodes[key];
    const children: TreeNode[] = [];
    for (const child of source.children ?? []) {
      const converted = convert(child);
      if (converted !== null) children.push(converted);
    }
    // 逻辑根自身用固定 GUID，不进映射表（需求 6.5：只作容器）。
    roots[key] = makeFolder(ROOT_GUID[key], source.title, children);
  }

  await mapping.flush(pending);

  return { roots, rootIds: resolution.ids, assigned, warnings: resolution.warnings };
}

// ── 应用计划 ─────────────────────────────────────────────────────────

export interface ApplyContext {
  mapping: MappingTable;
  rootIds: Record<RootKey, string>;
  /** 每条操作执行后回调，用于进度上报。 */
  onProgress?: (done: number, total: number) => void;
}

export interface ApplyResult {
  created: number;
  updated: number;
  moved: number;
  removed: number;
  reordered: number;
}

function rootKeyOfGuid(guid: Guid): RootKey | null {
  if (guid === ROOT_GUID.bar) return 'bar';
  if (guid === ROOT_GUID.other) return 'other';
  return null;
}

/** GUID → 浏览器 ID。逻辑根走 rootIds，其余走映射表。 */
function localIdFor(guid: Guid, ctx: ApplyContext): string {
  const rootKey = rootKeyOfGuid(guid);
  if (rootKey !== null) return ctx.rootIds[rootKey];
  const localId = ctx.mapping.localIdOf(guid);
  if (localId === undefined) throw new Error(`bookmarks: GUID ${guid} 没有对应的本地 ID`);
  return localId;
}

/**
 * 各父文件夹的子项数缓存。
 *
 * create 与 move 都需要把 index 钳到合法范围（越界会被浏览器拒绝），而
 * 900 条书签逐条调 getChildren 就是 900 次多余往返。缓存把它降到「每个被
 * 触碰的父一次」。move 与 remove 会改变来源父的子项数，而来源父的 ID 需要
 * 额外查询才能知道，因此这两种操作直接整体失效 —— 它们的数量远少于 create，
 * 且都排在 create 之后（方案 3.3 的排序约束），代价可以忽略。
 */
class ChildCounts {
  private readonly cache = new Map<string, number>();

  constructor(private readonly api: BookmarksApi) {}

  async lengthOf(parentId: string): Promise<number> {
    const hit = this.cache.get(parentId);
    if (hit !== undefined) return hit;
    const n = (await this.api.getChildren(parentId)).length;
    this.cache.set(parentId, n);
    return n;
  }

  bump(parentId: string, delta: number): void {
    const hit = this.cache.get(parentId);
    if (hit !== undefined) this.cache.set(parentId, hit + delta);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

const clamp = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value);

/**
 * 按序执行操作序列。
 *
 * 与 domain 的 applyPlan 语义一致，因此顺序约束由 plan.ts 保证：create 自顶
 * 向下、move 夹在中间、remove 自底向上、reorder 最后。这里不再重排，任何中途
 * 失败都直接抛出 —— INV-4 的立场是「本次失败，下次从头重来」，不做补偿。
 */
export async function applyLocalPlan(
  api: BookmarksApi,
  ops: readonly LocalOp[],
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, moved: 0, removed: 0, reordered: 0 };
  const counts = new ChildCounts(api);

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op.kind) {
      case 'create': {
        const parentId = localIdFor(op.parentGuid, ctx);
        // index 在 create 上无歧义（不涉及移除），但仍要钳到合法范围 ——
        // plan.ts 用的是目标树里的位置，执行到这条时同一父下更靠前的兄弟
        // 可能还没建出来，越界会被浏览器拒绝。最终顺序由收尾的 reorder 校正。
        const index = clamp(op.index, await counts.lengthOf(parentId));
        const arg =
          op.type === 'folder'
            ? { parentId, index, title: op.title }
            : { parentId, index, title: op.title, url: op.url ?? '' };
        const node = await api.create(arg);
        counts.bump(parentId, 1);
        // 立即持久化映射（需求 5.3 步骤 4 / INV-2）。
        await ctx.mapping.set(node.id, op.guid);
        result.created++;
        break;
      }

      case 'update': {
        const changes: { title?: string; url?: string } = {};
        if (op.title !== undefined) changes.title = op.title;
        if (op.url !== undefined) changes.url = op.url;
        await api.update(localIdFor(op.guid, ctx), changes);
        result.updated++;
        break;
      }

      case 'move': {
        // plan.ts 只在父变化时产出 move，因此这里一定跨父，index 无歧义。
        const parentId = localIdFor(op.parentGuid, ctx);
        const index = clamp(op.index, await counts.lengthOf(parentId));
        await api.move(localIdFor(op.guid, ctx), { parentId, index });
        // 来源父的子项数也变了，但它的 ID 需要额外查询才知道 —— 整体失效更省。
        counts.invalidateAll();
        result.moved++;
        break;
      }

      case 'remove': {
        // 用 remove 而非 removeTree：plan.ts 保证子先于父，若此时文件夹非空
        // 说明计划有误，让浏览器直接报错比静默删掉整棵子树安全。
        await api.remove(localIdFor(op.guid, ctx));
        counts.invalidateAll();
        result.removed++;
        break;
      }

      case 'reorder': {
        await reorderChildren(api, localIdFor(op.parentGuid, ctx), op.childGuids, ctx);
        counts.invalidateAll();
        result.reordered++;
        break;
      }
    }
    ctx.onProgress?.(i + 1, ops.length);
  }

  return result;
}

/**
 * 把某个文件夹的子项排成给定顺序。
 *
 * 按目标顺序依次把节点移到末尾（move 不传 index）。看着笨，但它天然避开了
 * 同父 move 的索引歧义：每一步要么把节点往左拉、要么把它送到末尾，从不越过
 * 当前位置往右插，而两种索引解释的差别恰好只在往右插时出现。
 * 已经就位的前缀会被跳过，因此最常见的「末尾追加一条」只需极少几次调用。
 */
async function reorderChildren(
  api: BookmarksApi,
  parentId: string,
  childGuids: readonly Guid[],
  ctx: ApplyContext,
): Promise<void> {
  const current = (await api.getChildren(parentId)).map((c) => c.id);
  const want = childGuids.map((guid) => localIdFor(guid, ctx));

  // 与 domain 的 applyPlan 一样严格：childGuids 必须正好是当前子项的一个排列。
  // 不符说明计划有误，静默「顺手移动」会把错误藏起来。
  if (want.length !== current.length || new Set(want).size !== want.length || want.some((id) => !current.includes(id))) {
    throw new Error(`bookmarks: reorder 的子项与 ${parentId} 的实际子项不符`);
  }

  // 跳过已经就位的前缀。
  let start = 0;
  while (start < want.length && current[start] === want[start]) start++;

  for (let i = start; i < want.length; i++) {
    await api.move(want[i]!, { parentId });
  }
}
