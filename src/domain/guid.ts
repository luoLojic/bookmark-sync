/**
 * domain/guid.ts —— GUID 生成与格式（需求 2 术语表）。
 *
 * GUID 由本扩展分配，写入快照后终身不变。它是三方合并能做精确匹配的前提 ——
 * 因此本项目不需要 floccus 那套按标题/URL 的模糊匹配（需求 6.1）。
 *
 * 纯模块：随机源由调用方注入（方案 1.2 红线一）。
 */

import type { Guid, NodeType } from './tree.js';
import { isRootGuid } from './tree.js';

/** 48 位随机量，十六进制 12 位。900 条量级下碰撞概率可忽略。 */
const HEX_DIGITS = 12;

const PREFIX: Record<NodeType, string> = {
  bookmark: 'b',
  folder: 'f',
};

/** 两端锚定：用于校验整个字符串，而不是子串匹配。 */
export const GUID_RE = /^[bf]-[0-9a-f]{12}$/;

/** 注入式随机源，签名与 Math.random 一致，返回 [0, 1)。 */
export type RandomSource = () => number;

function randomHex(digits: number, random: RandomSource): string {
  let out = '';
  while (out.length < digits) {
    // 每轮取一字节，避免依赖浮点精度。
    const byte = Math.floor(random() * 0x100) & 0xff;
    out += byte.toString(16).padStart(2, '0');
  }
  return out.slice(0, digits);
}

/**
 * 生成一个新 GUID。
 *
 * random 是必填参数，没有默认值：domain 不得自带随机源（红线一）。
 * 调用方注入后，同一组随机序列可确定性重放，合并结果因此可测。
 */
export function newGuid(type: NodeType, random: RandomSource): Guid {
  return `${PREFIX[type]}-${randomHex(HEX_DIGITS, random)}`;
}

/** 绑定随机源，返回只需类型参数的工厂。engine 每轮同步创建一个。 */
export function makeGuidFactory(random: RandomSource): (type: NodeType) => Guid {
  return (type) => newGuid(type, random);
}

/** 逻辑根 GUID 是固定常量，同样合法（需求 6.5）。 */
export function isValidGuid(guid: string): boolean {
  return isRootGuid(guid) || GUID_RE.test(guid);
}

/** GUID 自带类型信息，可在无树上下文时判定节点类型。 */
export function guidType(guid: string): NodeType | null {
  if (isRootGuid(guid)) return 'folder';
  if (!GUID_RE.test(guid)) return null;
  return guid.startsWith('b-') ? 'bookmark' : 'folder';
}
