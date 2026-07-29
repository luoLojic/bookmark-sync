/**
 * domain/diff.ts —— 三方 diff 的单一实现（方案 2.3）。
 *
 * 同一份代码被用在两处，这是本方案相对 floccus 省下大量代码的原因之一：
 *   - 阶段 B 之前：diff(base, local) 与 diff(base, remote) 观察两侧改动；
 *   - 阶段 D：diff(local, T) 得到要应用到浏览器的操作，diff(remote, T) 得到
 *     远端将消失的条目（仅用于删除保护统计）。
 *
 * 因为两侧条目都由 GUID 标识，匹配是精确的，不需要按标题或 URL 猜测（需求 6.1）。
 *
 * 顺序变化不作为独立操作（需求 6.3）：兄弟重排、以及因兄弟被删导致的 index
 * 平移都不产生操作。真正的顺序调整由 order.ts 生成目标树、plan.ts 产出
 * reorder 操作来完成。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import { indexRoots, type Guid, type NodeIndex, type NodeRecord, type Roots } from './tree.js';

/** UPDATE 可能涉及的字段（需求 6.1：标题或 URL 变化）。 */
export type UpdatableField = 'title' | 'url';

export type DiffOp =
  | { kind: 'create'; guid: Guid; after: NodeRecord }
  | { kind: 'delete'; guid: Guid; before: NodeRecord }
  | { kind: 'update'; guid: Guid; fields: UpdatableField[]; before: NodeRecord; after: NodeRecord }
  | { kind: 'move'; guid: Guid; before: NodeRecord; after: NodeRecord };

export type DiffOpKind = DiffOp['kind'];

export interface DiffResult {
  ops: DiffOp[];
}

/** 逐字段比较，返回发生变化的字段名。url 只对书签有意义。 */
function changedFields(before: NodeRecord, after: NodeRecord): UpdatableField[] {
  const fields: UpdatableField[] = [];
  if (before.title !== after.title) fields.push('title');
  if (before.url !== after.url) fields.push('url');
  return fields;
}

/**
 * 比较两棵树，输出 source → target 所需的操作集合。
 *
 * 操作之间不含顺序约束 —— 依赖排序是 plan.ts 的职责（方案 3.3）。
 */
export function diff(source: Roots, target: Roots): DiffResult {
  return diffIndexes(indexRoots(source), indexRoots(target));
}

/** 已有索引时的入口，避免重复展平同一棵树。 */
export function diffIndexes(source: NodeIndex, target: NodeIndex): DiffResult {
  const ops: DiffOp[] = [];

  for (const [guid, before] of source) {
    const after = target.get(guid);
    if (after === undefined) {
      ops.push({ kind: 'delete', guid, before });
      continue;
    }

    // GUID 前缀已编码类型，类型变化正常不会发生。防御性地按「删除 + 新建」
    // 处理，避免把书签当文件夹去改标题，或反之。
    if (before.type !== after.type) {
      ops.push({ kind: 'delete', guid, before });
      ops.push({ kind: 'create', guid, after });
      continue;
    }

    // 父变化即 MOVE。index 变化不单独成操作（需求 6.3）。
    if (before.parentGuid !== after.parentGuid) {
      ops.push({ kind: 'move', guid, before, after });
    }

    const fields = changedFields(before, after);
    if (fields.length > 0) {
      ops.push({ kind: 'update', guid, fields, before, after });
    }
  }

  for (const [guid, after] of target) {
    if (!source.has(guid)) {
      ops.push({ kind: 'create', guid, after });
    }
  }

  return { ops };
}

export function isEmptyDiff(result: DiffResult): boolean {
  return result.ops.length === 0;
}

/**
 * 删除条目数。文件夹的子孙各自计入 —— 因为 diff 对子树中每个节点都产出一条
 * delete，这正是删除保护要的分子（方案 4.1）。
 */
export function countDeletions(result: DiffResult): number {
  let n = 0;
  for (const op of result.ops) if (op.kind === 'delete') n++;
  return n;
}

export type DiffSummary = Record<DiffOpKind, number>;

export function summarize(result: DiffResult): DiffSummary {
  const out: DiffSummary = { create: 0, delete: 0, update: 0, move: 0 };
  for (const op of result.ops) out[op.kind]++;
  return out;
}

/** 被删除节点的记录，供确认弹窗列出条目（FR-10 至多 20 条）。 */
export function deletedRecords(result: DiffResult): NodeRecord[] {
  const out: NodeRecord[] = [];
  for (const op of result.ops) if (op.kind === 'delete') out.push(op.before);
  return out;
}
