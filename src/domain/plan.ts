/**
 * domain/plan.ts —— 目标树 → 本地操作序列（方案 3.3）。
 *
 * 输出序列必须满足的排序约束：
 *   create  自顶向下拓扑序（父先于子）
 *   move    在全部 create 之后、全部 remove 之前
 *   remove  自底向上（子先于父，因此永不删非空文件夹）
 *   reorder 最后
 *
 * 这些约束不是风格问题：浏览器书签 API 无事务，中途失败时已执行的部分必须
 * 自身自洽（INV-4）。顺序错了会出现「父不存在」或「删非空文件夹」。
 *
 * 本文件同时提供 applyPlan —— 一个严格的纯参考实现：前置条件不满足即抛错。
 * 它有两个用途：属性测试第 3、4 条的判定依据，以及 M2 的 platform/bookmarks.ts
 * 必须对齐的语义基准。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import {
  ROOT_GUID,
  ROOT_KEYS,
  cloneRoots,
  indexRoots,
  isBookmark,
  isFolder,
  isRootGuid,
  makeBookmark,
  makeFolder,
  walk,
  type Folder,
  type Guid,
  type NodeIndex,
  type NodeType,
  type Roots,
  type TreeNode,
} from './tree.js';

export type LocalOp =
  /**
   * 方案 3.3 用 `node: Bookmark | Omit<Folder,'children'>` 承载内容。这里改为
   * 平铺 type / title / url：两者同构，但平铺不必构造一个没有 children 的
   * 假 Folder，在 exactOptionalPropertyTypes 下也更好写。
   */
  | { kind: 'create'; guid: Guid; parentGuid: Guid; index: number; type: NodeType; title: string; url?: string }
  | { kind: 'update'; guid: Guid; title?: string; url?: string }
  | { kind: 'move'; guid: Guid; parentGuid: Guid; index: number }
  | { kind: 'remove'; guid: Guid }
  | { kind: 'reorder'; parentGuid: Guid; childGuids: Guid[] };

export type LocalOpKind = LocalOp['kind'];

/** 节点在树中的深度，逻辑根的直接子项为 0。用于拓扑排序。 */
function depthIn(idx: NodeIndex, guid: Guid): number {
  let depth = 0;
  let cur = idx.get(guid);
  const seen = new Set<Guid>();
  while (cur !== undefined && !isRootGuid(cur.parentGuid) && !seen.has(cur.guid)) {
    seen.add(cur.guid);
    depth++;
    cur = idx.get(cur.parentGuid);
  }
  return depth;
}

/** 每个父下的子项 GUID 顺序（indexRoots 已按 index 序遍历）。 */
function childOrders(idx: NodeIndex): Map<Guid, Guid[]> {
  const m = new Map<Guid, Guid[]>();
  for (const [guid, rec] of idx) {
    const list = m.get(rec.parentGuid);
    if (list === undefined) m.set(rec.parentGuid, [guid]);
    else list.push(guid);
  }
  return m;
}

function sameSequence(a: readonly Guid[], b: readonly Guid[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

/** 生成把 current 变成 target 所需的操作序列。 */
export function buildPlan(current: Roots, target: Roots): LocalOp[] {
  const cIdx = indexRoots(current);
  const tIdx = indexRoots(target);

  const creates: LocalOp[] = [];
  const updates: LocalOp[] = [];
  const moves: LocalOp[] = [];
  const removes: LocalOp[] = [];

  // create：目标独有。按目标树深度升序，保证父先于子。
  const newGuids = [...tIdx.keys()].filter((g) => !cIdx.has(g));
  newGuids.sort((a, b) => depthIn(tIdx, a) - depthIn(tIdx, b));
  for (const guid of newGuids) {
    const rec = tIdx.get(guid)!;
    const op: LocalOp =
      rec.type === 'folder'
        ? { kind: 'create', guid, parentGuid: rec.parentGuid, index: rec.index, type: 'folder', title: rec.title }
        : {
            kind: 'create',
            guid,
            parentGuid: rec.parentGuid,
            index: rec.index,
            type: 'bookmark',
            title: rec.title,
            url: rec.url ?? '',
          };
    creates.push(op);
  }

  // update / move：两侧都有。
  const moveTargets: Guid[] = [];
  for (const [guid, before] of cIdx) {
    const after = tIdx.get(guid);
    if (after === undefined) continue;

    const patch: { kind: 'update'; guid: Guid; title?: string; url?: string } = { kind: 'update', guid };
    let dirty = false;
    if (before.title !== after.title) {
      patch.title = after.title;
      dirty = true;
    }
    if (before.url !== after.url && after.url !== undefined) {
      patch.url = after.url;
      dirty = true;
    }
    if (dirty) updates.push(patch);

    if (before.parentGuid !== after.parentGuid) moveTargets.push(guid);
  }

  /**
   * move 按目标树深度升序执行。
   *
   * 不排序会在「父子互换」时崩掉：current 是 A 装着 B、target 是 B 装着 A 时，
   * 若先执行「把 A 移进 B」，那一刻 B 还在 A 里面，等于把文件夹移入自身子树 ——
   * 浏览器会拒绝，applyPlan 也会抛错。
   *
   * 升序为什么够：处理深度 d 的节点时，它的目标父深度是 d-1，已经处理完并落在
   * 最终位置，且其整条祖先链也已定型；而目标树里该父是本节点的祖先，故本节点
   * 不可能出现在这条链上，也就不会构成「移入自身子树」。
   */
  moveTargets.sort((a, b) => depthIn(tIdx, a) - depthIn(tIdx, b));
  for (const guid of moveTargets) {
    const after = tIdx.get(guid)!;
    moves.push({ kind: 'move', guid, parentGuid: after.parentGuid, index: after.index });
  }

  // remove：当前独有。按当前树深度降序，保证子先于父。
  const goneGuids = [...cIdx.keys()].filter((g) => !tIdx.has(g));
  goneGuids.sort((a, b) => depthIn(cIdx, b) - depthIn(cIdx, a));
  for (const guid of goneGuids) removes.push({ kind: 'remove', guid });

  const structural = [...creates, ...updates, ...moves, ...removes];

  // reorder：先模拟结构性操作，再逐父比对顺序。只对真正不一致的父发操作 ——
  // 直接照抄目标顺序会产出大量无意义的 reorder，弱网下白费一轮 API 调用。
  const simulated = indexRoots(applyPlan(current, structural));
  const wantOrders = childOrders(tIdx);
  const haveOrders = childOrders(simulated);

  const reorders: LocalOp[] = [];
  const parents: Guid[] = [ROOT_GUID.bar, ROOT_GUID.other];
  for (const [guid, rec] of tIdx) if (rec.type === 'folder') parents.push(guid);
  for (const parent of parents) {
    const want = wantOrders.get(parent) ?? [];
    const have = haveOrders.get(parent) ?? [];
    if (!sameSequence(want, have)) reorders.push({ kind: 'reorder', parentGuid: parent, childGuids: [...want] });
  }

  return [...structural, ...reorders];
}

export type PlanSummary = Record<LocalOpKind, number>;

export function summarizePlan(ops: readonly LocalOp[]): PlanSummary {
  const out: PlanSummary = { create: 0, update: 0, move: 0, remove: 0, reorder: 0 };
  for (const op of ops) out[op.kind]++;
  return out;
}

/** 计划中将从本地删除的条目数，用于删除保护（方案 4.1）。 */
export function countRemovals(ops: readonly LocalOp[]): number {
  let n = 0;
  for (const op of ops) if (op.kind === 'remove') n++;
  return n;
}

// ── applyPlan：严格的纯参考实现 ────────────────────────────────────────

/**
 * 位置校验。
 *
 * 越界不算错误，按追加处理：buildPlan 的 create 用的是目标树里的位置，但执行
 * 到该条时同一父下更靠前的兄弟可能还没建出来（create 按深度排序，不按兄弟序）。
 * Array.splice 对超出长度的下标本就追加到末尾，这里不再重复钳制。
 *
 * 负数下标则是真正的非法输入 —— splice 会把它当作「从末尾倒数」，静默插到
 * 错误位置。严格实现应当拒绝。M2 的真实 applier 面对 chrome.bookmarks 时
 * 还需显式把越界值钳到长度以内，那是浏览器 API 的额外要求。
 */
function assertIndex(index: number, op: LocalOpKind, guid: Guid): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`${op}: invalid index ${index} for ${guid}`);
  }
}

interface MutableState {
  folders: Map<Guid, Folder>;
  nodes: Map<Guid, TreeNode>;
  parentOf: Map<Guid, Guid>;
}

function detach(guid: Guid, state: MutableState): void {
  const parentGuid = state.parentOf.get(guid);
  if (parentGuid === undefined) throw new Error(`detach: unknown guid ${guid}`);
  const parent = state.folders.get(parentGuid);
  if (parent === undefined) throw new Error(`detach: parent ${parentGuid} does not exist`);
  const at = parent.children.findIndex((c) => c.guid === guid);
  if (at >= 0) parent.children.splice(at, 1);
}

/** candidate 是否位于 guid 的子树内。用于拒绝把文件夹移入自身。 */
function isWithinSubtree(candidate: Guid, guid: Guid, parentOf: Map<Guid, Guid>): boolean {
  let cur: Guid | undefined = candidate;
  const seen = new Set<Guid>();
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === guid) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * 按序应用操作，返回新树。输入树不被修改。
 *
 * 前置条件不满足即抛错（父不存在、删非空文件夹、未知 GUID、reorder 子项不符、
 * 把文件夹移入自身子树）。这正是属性测试第 4 条的判定方式，也是 M2 的
 * platform/bookmarks.ts 必须满足的语义。
 */
export function applyPlan(roots: Roots, ops: readonly LocalOp[]): Roots {
  const out = cloneRoots(roots);
  const state: MutableState = { folders: new Map(), nodes: new Map(), parentOf: new Map() };
  for (const key of ROOT_KEYS) state.folders.set(ROOT_GUID[key], out[key]);
  for (const { node, parentGuid } of walk(out)) {
    state.nodes.set(node.guid, node);
    state.parentOf.set(node.guid, parentGuid);
    if (isFolder(node)) state.folders.set(node.guid, node);
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'create': {
        const parent = state.folders.get(op.parentGuid);
        if (parent === undefined) throw new Error(`create: parent ${op.parentGuid} does not exist`);
        if (state.nodes.has(op.guid)) throw new Error(`create: duplicate guid ${op.guid}`);
        assertIndex(op.index, 'create', op.guid);
        const node: TreeNode =
          op.type === 'folder' ? makeFolder(op.guid, op.title) : makeBookmark(op.guid, op.title, op.url ?? '');
        parent.children.splice(op.index, 0, node);
        state.nodes.set(op.guid, node);
        state.parentOf.set(op.guid, op.parentGuid);
        if (isFolder(node)) state.folders.set(op.guid, node);
        break;
      }

      case 'update': {
        const node = state.nodes.get(op.guid);
        if (node === undefined) throw new Error(`update: unknown guid ${op.guid}`);
        if (op.title !== undefined) node.title = op.title;
        if (op.url !== undefined) {
          if (!isBookmark(node)) throw new Error(`update: ${op.guid} is not a bookmark`);
          node.url = op.url;
        }
        break;
      }

      case 'move': {
        const node = state.nodes.get(op.guid);
        if (node === undefined) throw new Error(`move: unknown guid ${op.guid}`);
        const dest = state.folders.get(op.parentGuid);
        if (dest === undefined) throw new Error(`move: parent ${op.parentGuid} does not exist`);
        if (isFolder(node) && isWithinSubtree(op.parentGuid, op.guid, state.parentOf)) {
          throw new Error(`move: cannot move ${op.guid} into its own subtree`);
        }
        assertIndex(op.index, 'move', op.guid);
        detach(op.guid, state);
        dest.children.splice(op.index, 0, node);
        state.parentOf.set(op.guid, op.parentGuid);
        break;
      }

      case 'remove': {
        const node = state.nodes.get(op.guid);
        if (node === undefined) throw new Error(`remove: unknown guid ${op.guid}`);
        if (isFolder(node) && node.children.length > 0) {
          throw new Error(`remove: folder ${op.guid} is not empty`);
        }
        detach(op.guid, state);
        state.nodes.delete(op.guid);
        state.parentOf.delete(op.guid);
        state.folders.delete(op.guid);
        break;
      }

      case 'reorder': {
        const parent = state.folders.get(op.parentGuid);
        if (parent === undefined) throw new Error(`reorder: parent ${op.parentGuid} does not exist`);
        const byGuid = new Map(parent.children.map((c) => [c.guid, c]));
        if (byGuid.size !== op.childGuids.length || op.childGuids.some((g) => !byGuid.has(g))) {
          throw new Error(`reorder: childGuids do not match the current children of ${op.parentGuid}`);
        }
        parent.children = op.childGuids.map((g) => byGuid.get(g)!);
        break;
      }
    }
  }

  return out;
}
