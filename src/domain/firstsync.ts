/**
 * domain/firstsync.ts —— 无基线时的宽松匹配（需求 6.4 / FR-4「合并双方」）。
 *
 * 新设备接入时本地与远端各自都有内容，但本设备没有基线。若直接以空树为基线
 * 做三方合并，同一条书签会因两侧 GUID 不同而被判为「两侧各自新增」，结果是
 * 每条书签出现两份。因此先按放宽的规则认亲，统一 GUID，再走正常的三方合并。
 *
 * 匹配规则（需求 6.4，不放宽也不收紧）：
 *   书签    同一父文件夹内 URL 相同即视为同一条目
 *   文件夹  从逻辑根起的完整路径相同即视为同一文件夹
 *
 * 方向是「本地 GUID 改写为远端 GUID」。本设备的 GUID 是这次刚分配的，而远端
 * GUID 已被其他设备的基线引用 —— 改写远端会让那些设备把条目视为「删除 + 新建」，
 * 白白重建一遍书签树。
 *
 * 纯模块：无 I/O、无时间与随机源（方案 1.2 红线一）。
 */

import {
  ROOT_KEYS,
  isFolder,
  makeBookmark,
  makeFolder,
  walk,
  type Guid,
  type RootKey,
  type Roots,
  type TreeNode,
} from './tree.js';

export interface FirstSyncMatch {
  /** 本地 GUID → 远端 GUID，仅含匹配上的条目。 */
  mapping: Map<Guid, Guid>;
  matchedBookmarks: number;
  matchedFolders: number;
}

/**
 * 匹配键。用 JSON 序列化而不是拼接分隔符 —— 书签标题可以包含任何字符，
 * 用 `/` 之类的分隔符会让「a/b」与嵌套的 a → b 撞成同一个键。
 */
function folderKey(rootKey: RootKey, path: readonly string[]): string {
  return JSON.stringify([rootKey, ...path]);
}

function bookmarkKey(rootKey: RootKey, parentPath: readonly string[], url: string): string {
  return JSON.stringify([rootKey, parentPath, url]);
}

/** 按键收集 GUID，保留出现顺序，供重复项两两配对。 */
function collect(roots: Roots): { folders: Map<string, Guid[]>; bookmarks: Map<string, Guid[]> } {
  const folders = new Map<string, Guid[]>();
  const bookmarks = new Map<string, Guid[]>();

  const push = (m: Map<string, Guid[]>, key: string, guid: Guid): void => {
    const list = m.get(key);
    if (list === undefined) m.set(key, [guid]);
    else list.push(guid);
  };

  for (const { node, rootKey, path } of walk(roots)) {
    if (isFolder(node)) {
      // 文件夹自身的路径 = 父路径 + 自己的标题。
      push(folders, folderKey(rootKey, [...path, node.title]), node.guid);
    } else {
      // 书签的身份 = 所在父文件夹的路径 + URL。
      push(bookmarks, bookmarkKey(rootKey, path, node.url), node.guid);
    }
  }

  return { folders, bookmarks };
}

/** 同一键下的多个条目按出现顺序两两配对；多出的一侧不参与匹配。 */
function pairUp(
  localSide: Map<string, Guid[]>,
  remoteSide: Map<string, Guid[]>,
  mapping: Map<Guid, Guid>,
): number {
  let matched = 0;
  for (const [key, localGuids] of localSide) {
    const remoteGuids = remoteSide.get(key);
    if (remoteGuids === undefined) continue;
    const n = Math.min(localGuids.length, remoteGuids.length);
    for (let i = 0; i < n; i++) {
      mapping.set(localGuids[i]!, remoteGuids[i]!);
      matched++;
    }
  }
  return matched;
}

/**
 * 按需求 6.4 的宽松规则匹配两棵树。
 *
 * 注意匹配是「同层无状态」的：文件夹按完整路径匹配，书签按父路径 + URL 匹配，
 * 两者都不依赖对方的匹配结果。因为路径本身就编码了父链，所以「先匹配父、再
 * 匹配子」的效果自然成立，不需要按层迭代。
 */
export function matchFirstSync(local: Roots, remote: Roots): FirstSyncMatch {
  const l = collect(local);
  const r = collect(remote);
  const mapping = new Map<Guid, Guid>();
  const matchedFolders = pairUp(l.folders, r.folders, mapping);
  const matchedBookmarks = pairUp(l.bookmarks, r.bookmarks, mapping);
  return { mapping, matchedBookmarks, matchedFolders };
}

/** 按映射改写树中的 GUID。结构、标题、URL 与顺序都不变。输入树不被修改。 */
export function applyGuidMapping(roots: Roots, mapping: Map<Guid, Guid>): Roots {
  const rewrite = (node: TreeNode): TreeNode => {
    const guid = mapping.get(node.guid) ?? node.guid;
    return isFolder(node)
      ? makeFolder(guid, node.title, node.children.map(rewrite))
      : makeBookmark(guid, node.title, node.url);
  };

  const out = {} as Roots;
  for (const key of ROOT_KEYS) {
    const root = roots[key];
    // 逻辑根 GUID 是固定常量，不参与改写。
    out[key] = makeFolder(root.guid, root.title, root.children.map(rewrite));
  }
  return out;
}
