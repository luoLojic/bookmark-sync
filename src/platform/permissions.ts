/**
 * platform/permissions.ts —— 动态 host 权限（NFR-13：权限最小化）。
 *
 * manifest 里只申请 bookmarks / storage / alarms，远端地址对应的 host 权限
 * 在用户填好地址后动态申请，不用 `*://*&#47;*`。
 *
 * 申请必须由用户手势触发（chrome.permissions.request 的硬性要求），因此
 * 只能在设置页里调用 —— service worker 里调会直接失败。
 */

import { MisconfiguredError } from '../shared/errors.js';

/** URL → 权限模式。只取 scheme + host，路径一律用 /*。 */
export function originPatternOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MisconfiguredError(`地址无法解析：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MisconfiguredError('地址必须以 http:// 或 https:// 开头');
  }
  // 端口不写进模式：Chrome 的 match pattern 不支持按端口区分。
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export interface PermissionsApi {
  contains(perms: { origins: string[] }): Promise<boolean>;
  request(perms: { origins: string[] }): Promise<boolean>;
  remove(perms: { origins: string[] }): Promise<boolean>;
  getAll(): Promise<{ origins?: string[] }>;
}

export const chromePermissions: PermissionsApi = {
  contains: (p) => chrome.permissions.contains(p),
  request: (p) => chrome.permissions.request(p),
  remove: (p) => chrome.permissions.remove(p),
  getAll: () => chrome.permissions.getAll() as Promise<{ origins?: string[] }>,
};

export async function hasOrigin(url: string, api: PermissionsApi): Promise<boolean> {
  return api.contains({ origins: [originPatternOf(url)] });
}

/**
 * 确保拥有该地址的访问权限。已有则直接返回 true，不弹窗打扰用户。
 * 返回 false 表示用户拒绝了授权。
 */
export async function ensureOrigin(url: string, api: PermissionsApi): Promise<boolean> {
  const origins = [originPatternOf(url)];
  if (await api.contains({ origins })) return true;
  return api.request({ origins });
}

/**
 * 回收不再需要的 host 权限（用户改了远端地址之后）。
 *
 * 尽力而为：撤销失败不影响功能，只是多留了一个权限。
 * 不撤销当前正在使用的那个。
 */
export async function pruneOrigins(keepUrl: string | null, api: PermissionsApi): Promise<string[]> {
  const keep = keepUrl === null ? null : safePattern(keepUrl);
  const all = await api.getAll();
  const removed: string[] = [];
  for (const origin of all.origins ?? []) {
    if (origin === keep) continue;
    try {
      if (await api.remove({ origins: [origin] })) removed.push(origin);
    } catch {
      // 忽略：权限回收失败不影响同步。
    }
  }
  return removed;
}

function safePattern(url: string): string | null {
  try {
    return originPatternOf(url);
  } catch {
    return null;
  }
}
