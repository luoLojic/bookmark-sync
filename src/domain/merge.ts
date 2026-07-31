/**
 * domain/merge.ts —— 三方合并的目标树生成（方案第 2 节，全项目技术核心）。
 *
 * 不消解两份 diff，而是逐节点判定最终形态，再重建目标树：
 *   阶段 A  三棵树各展平为 Map<GUID, NodeRecord>
 *   阶段 B  对 union(keys) 中每个 GUID 用 (inBase, inLocal, inRemote) 的三元
 *           存在性 + 字段比较，输出 Keep | Drop
 *   阶段 C  按 parentGuid 关系装配为目标树，children 顺序由 order.ts 生成
 *
 * 收益（方案 2.3）：冲突表的每一行对应一个分支，不存在 n² 的交叉判定；幂等与
 * 收敛成为恒等式的推论而不是需要单独实现的性质。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import { mergeOrder } from './order.js';
import {
  ROOT_GUID,
  ROOT_KEYS,
  indexRoots,
  isRootGuid,
  makeBookmark,
  makeFolder,
  type Guid,
  type NodeIndex,
  type NodeRecord,
  type NodeType,
  type RootKey,
  type Roots,
  type TreeNode,
} from './tree.js';

export interface MergeInput {
  /** 基线：上次同步成功时的快照。首次同步传空树（需求 6.4）。 */
  base: Roots;
  local: Roots;
  remote: Roots;
}

/** 阶段 B 的判定结果：保留下来的节点形态。 */
interface Kept {
  type: NodeType;
  title: string;
  url?: string;
  parentGuid: Guid;
}

/** 参与合并判定的字段。index 不在其中 —— 顺序由 order.ts 单独处理（需求 6.3）。 */
function sameContent(a: NodeRecord, b: NodeRecord): boolean {
  return a.title === b.title && a.url === b.url && a.parentGuid === b.parentGuid;
}

function pick(rec: NodeRecord): Kept {
  const out: Kept = { type: rec.type, title: rec.title, parentGuid: rec.parentGuid };
  if (rec.url !== undefined) out.url = rec.url;
  return out;
}

/**
 * 单字段三方判定。方案 2.4 的第 9、10、11 行折叠为这一个函数：
 *   两侧相同 → 采纳；只有一侧改 → 采纳该侧；双改 → 本地优先（需求 6.2）。
 */
function threeWay<T>(base: T, local: T, remote: T): T {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  return local;
}

/**
 * 字段级独立判定（方案 2.4 末段）。
 * title、url、parentGuid 各自走一遍 threeWay，因此「A 改标题、B 移位置」
 * 两个改动都能保留，而不是整节点二选一。
 */
function fieldwise(base: NodeRecord, local: NodeRecord, remote: NodeRecord): Kept {
  const out: Kept = {
    // 类型由 GUID 前缀编码，理论上三侧一致；取本地与「本地优先」一致。
    type: local.type,
    title: threeWay(base.title, local.title, remote.title),
    parentGuid: threeWay(base.parentGuid, local.parentGuid, remote.parentGuid),
  };
  const url = threeWay(base.url, local.url, remote.url);
  if (url !== undefined) out.url = url;
  return out;
}

/**
 * 阶段 B 判定矩阵（方案 2.4 的 11 行）。
 *
 * 存在性分支只有 7 个：文档第 5/7 行是 `b·∅·r` 的两种结果（远端等于基线则
 * 视为「仅本地删」，否则是「删除 vs 修改」），第 6/8 行同理镜像，
 * 第 9/10/11 行统一由 fieldwise 处理。
 */
function decide(base?: NodeRecord, local?: NodeRecord, remote?: NodeRecord): Kept | null {
  if (base === undefined) {
    // ∅ x ∅ 与 ∅ x x → Keep(L)：本地新增；两侧同 GUID 新增只可能来自首次同步匹配。
    if (local !== undefined) return pick(local);
    // ∅ ∅ x → Keep(R)：远端新增。
    return remote === undefined ? null : pick(remote);
  }

  // b ∅ ∅ → Drop：两侧都删。
  if (local === undefined && remote === undefined) return null;

  // b ∅ b → Drop（仅本地删）；b ∅ r≠b → Keep(R)（删除 vs 修改，保留修改后状态）。
  if (local === undefined) {
    return sameContent(remote!, base) ? null : pick(remote!);
  }

  // b b ∅ → Drop（仅远端删）；b l≠b ∅ → Keep(L)（镜像情形）。
  if (remote === undefined) {
    return sameContent(local, base) ? null : pick(local);
  }

  // b l r → 逐字段判定。
  return fieldwise(base, local, remote);
}

/** 按 base → local → remote 的顺序枚举全部 GUID，保证判定顺序确定。 */
function unionGuids(bIdx: NodeIndex, lIdx: NodeIndex, rIdx: NodeIndex): Guid[] {
  const out: Guid[] = [];
  const seen = new Set<Guid>();
  for (const idx of [bIdx, lIdx, rIdx]) {
    for (const guid of idx.keys()) {
      if (!seen.has(guid)) {
        seen.add(guid);
        out.push(guid);
      }
    }
  }
  return out;
}

/** 每个父节点下的子项顺序，取自某一侧的索引（indexRoots 已按 index 序遍历）。 */
function childOrders(idx: NodeIndex): Map<Guid, Guid[]> {
  const m = new Map<Guid, Guid[]>();
  for (const [guid, rec] of idx) {
    const list = m.get(rec.parentGuid);
    if (list === undefined) m.set(rec.parentGuid, [guid]);
    else list.push(guid);
  }
  return m;
}

/** 沿某一侧的父链向上找出节点所属的逻辑根。用于兜底挂载时选对 bar / other。 */
function rootKeyIn(idx: NodeIndex, guid: Guid): RootKey | null {
  let cur = idx.get(guid);
  const seen = new Set<Guid>();
  while (cur !== undefined && !seen.has(cur.guid)) {
    seen.add(cur.guid);
    if (cur.parentGuid === ROOT_GUID.bar) return 'bar';
    if (cur.parentGuid === ROOT_GUID.other) return 'other';
    cur = idx.get(cur.parentGuid);
  }
  return null;
}

export function mergeTrees(input: MergeInput): Roots {
  const bIdx = indexRoots(input.base);
  const lIdx = indexRoots(input.local);
  const rIdx = indexRoots(input.remote);

  // ── 阶段 B：逐节点判定 ─────────────────────────────────────────────
  const kept = new Map<Guid, Kept>();
  for (const guid of unionGuids(bIdx, lIdx, rIdx)) {
    const decision = decide(bIdx.get(guid), lIdx.get(guid), rIdx.get(guid));
    if (decision !== null) kept.set(guid, decision);
  }

  /** 已删节点的最后已知形态。优先本地，其次远端，最后基线。 */
  const lastKnown = (guid: Guid): NodeRecord | undefined =>
    lIdx.get(guid) ?? rIdx.get(guid) ?? bIdx.get(guid);

  // ── 祖先复活（方案 2.4 / 需求 6.2 最后一条） ────────────────────────
  // 一侧删除文件夹、另一侧在其中新增或移入条目时，文件夹本身必须保留，
  // 否则这些存活的子项无处挂载。文件夹内其余条目仍按各自判定删除。
  for (const guid of [...kept.keys()]) {
    let parent = kept.get(guid)!.parentGuid;
    const walked = new Set<Guid>([guid]);
    while (!isRootGuid(parent) && !walked.has(parent)) {
      walked.add(parent);
      if (!kept.has(parent)) {
        const rec = lastKnown(parent);
        // 悬空引用或父是书签：留给下面的父解析阶段兜底到逻辑根。
        if (rec === undefined || rec.type !== 'folder') break;
        kept.set(parent, pick(rec));
      }
      parent = kept.get(parent)!.parentGuid;
    }
  }

  // ── 父解析与循环打破 ──────────────────────────────────────────────
  //
  // 字段级 parentGuid 判定可能产生循环：本地把 A 移入 B、远端把 B 移入 A 时，
  // 「本地优先」会同时得到 A.parent=B 与 B.parent=A。若不处理，两棵子树都装配不上
  // 逻辑根，表现为书签整片消失。
  //
  // ★ 只把「病灶」提到逻辑根，不能把所有到不了根的节点都提上去（审计 L-7）。
  //
  // 原实现对每个节点独立判断「父能否到达根」，而成环节点的判定结果 false 会被写进
  // 备忘录；于是挂在 A 下面的正常子节点 C 也被判成不可用，跟着被提到书签栏第一层。
  // 结果是条目不丢但层级散架 —— 用户看到几十个书签突然全跑到书签栏根下，而且这个
  // 结果会上传，其它设备跟着散。触发条件是「本地把 A 移入 B、远端把 B 移入 A」这种
  // 真实的并发编辑。
  //
  // 病灶只有两类：父不存在 / 父不是文件夹（断链），以及自己就在环上。把这两类提到
  // 逻辑根之后，它们的后代自然就能到达根了 —— 因为父子关系没动，只是链的顶端接上了。
  const rootForNode = (guid: Guid): Guid => {
    const key = rootKeyIn(lIdx, guid) ?? rootKeyIn(rIdx, guid) ?? rootKeyIn(bIdx, guid) ?? 'bar';
    return ROOT_GUID[key];
  };

  const finalParent = new Map<Guid, Guid>();
  for (const [guid, node] of kept) finalParent.set(guid, node.parentGuid);

  /** 顺着当前 finalParent 往上走一步；到根或断链时返回 undefined。 */
  const stepUp = (guid: Guid): Guid | undefined => {
    const parent = finalParent.get(guid)!;
    if (isRootGuid(parent)) return undefined;
    return kept.get(parent)?.type === 'folder' ? parent : undefined;
  };

  // 环检测。每个节点只有一个父，所以这是一张函数图：从任一点出发不断上行，
  // 要么走到根、要么断链、要么撞回本次路径里的某个节点 —— 后者就是一个环。
  const onCycle = new Set<Guid>();
  const settled = new Set<Guid>();
  for (const start of kept.keys()) {
    if (settled.has(start)) continue;
    const path: Guid[] = [];
    const seenAt = new Map<Guid, number>();
    let cur: Guid | undefined = start;
    while (cur !== undefined && !settled.has(cur)) {
      const at = seenAt.get(cur);
      if (at !== undefined) {
        for (let i = at; i < path.length; i++) onCycle.add(path[i]!);
        break;
      }
      seenAt.set(cur, path.length);
      path.push(cur);
      cur = stepUp(cur);
    }
    for (const g of path) settled.add(g);
  }

  for (const guid of kept.keys()) {
    const parent = finalParent.get(guid)!;
    const linked = isRootGuid(parent) || kept.get(parent)?.type === 'folder';
    // 断链或自己在环上 —— 提到逻辑根，条目不丢、层级也只在这一处断开。
    if (!linked || onCycle.has(guid)) finalParent.set(guid, rootForNode(guid));
  }

  // 兜底再核一遍。理论上此刻每个节点都能到根（病灶都接到根上了），留这一遍是因为
  // 装配阶段依赖这个前提：一旦不成立，子树会静默消失，那比层级散架严重得多。
  const reachesRoot = new Map<Guid, boolean>();
  const reaches = (guid: Guid, stack: Set<Guid>): boolean => {
    const memo = reachesRoot.get(guid);
    if (memo !== undefined) return memo;
    if (stack.has(guid)) return false; // 成环，不写入备忘录
    stack.add(guid);
    const parent = finalParent.get(guid)!;
    const ok = isRootGuid(parent)
      ? true
      : kept.get(parent)?.type === 'folder'
        ? reaches(parent, stack)
        : false;
    stack.delete(guid);
    reachesRoot.set(guid, ok);
    return ok;
  };
  for (const guid of kept.keys()) {
    if (!reaches(guid, new Set())) finalParent.set(guid, rootForNode(guid));
  }

  // ── 阶段 C：装配 ──────────────────────────────────────────────────
  const byParent = new Map<Guid, Guid[]>();
  for (const [guid, parent] of finalParent) {
    const list = byParent.get(parent);
    if (list === undefined) byParent.set(parent, [guid]);
    else list.push(guid);
  }

  const baseOrder = childOrders(bIdx);
  const localOrder = childOrders(lIdx);
  const remoteOrder = childOrders(rIdx);

  const buildChildren = (parent: Guid): TreeNode[] => {
    const survivors = byParent.get(parent) ?? [];
    if (survivors.length === 0) return [];
    const ordered = mergeOrder({
      survivors,
      base: baseOrder.get(parent) ?? [],
      local: localOrder.get(parent) ?? [],
      remote: remoteOrder.get(parent) ?? [],
    });
    return ordered.map((guid) => {
      const node = kept.get(guid)!;
      return node.type === 'folder'
        ? makeFolder(guid, node.title, buildChildren(guid))
        : makeBookmark(guid, node.title, node.url ?? '');
    });
  };

  // 逻辑根的标题是设备本地界面标签，不参与同步，取本地的（与 hash.ts 一致）。
  const out = {} as Roots;
  for (const key of ROOT_KEYS) {
    out[key] = makeFolder(ROOT_GUID[key], input.local[key].title, buildChildren(ROOT_GUID[key]));
  }
  return out;
}
