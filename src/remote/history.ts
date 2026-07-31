/**
 * remote/history.ts —— 历史快照的命名与索引维护（FR-13 至 FR-16 / 方案 3.2）。
 *
 * 命名：`history/v{6 位补零版本号}-{ISO 时间戳，冒号与点换成连字符}{后缀}`
 * 时间戳里的 `:` 与 `.` 在 Windows 与部分 WebDAV 服务器上是非法文件名字符，
 * 必须替换 —— 否则历史文件在某些服务器上根本写不进去。
 *
 * 索引：`history/index.json`。设置页读它来列出历史，不依赖目录列举（FR-15），
 * 这样历史文件积累到几千个也不影响任何操作的速度。
 */

import { REMOTE_FILES } from '../shared/config.js';
import type { HistoryEntry, HistoryIndex } from '../shared/types.js';

/** 版本号补零到 6 位，让文件名的字典序与版本号顺序一致。 */
export function formatVersion(version: number): string {
  return `v${String(Math.max(0, Math.floor(version))).padStart(6, '0')}`;
}

/** ISO 时间戳 → 文件名安全形式。 */
export function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

export function historyFileName(version: number, writtenAt: string, suffix: '.json' | '.json.gz'): string {
  return `${REMOTE_FILES.historyDir}${formatVersion(version)}-${safeTimestamp(writtenAt)}${suffix}`;
}

const NAME_RE = /^v(\d{6,})-(.+?)(\.json(?:\.gz)?)$/;

/**
 * 校验索引里的 file 字段（审计 BUG-13 / L-8）。
 *
 * 索引是**远端内容**，而 downloadHistory 会把它直接交给 store.get，
 * webdav.ts 的 joinUrl 不过滤 `..`。也就是说一份被篡改的 index.json 能让扩展
 * 带着 Basic 凭据去 GET 同一服务器上的任意路径，再把内容显示、下载给用户。
 *
 * 威胁模型确实有限（远端本来就是用户自己的，要么是共享账号、要么服务器已被
 * 入侵），但校验成本几乎为零：历史文件的名字形状本来就是我们自己定的。
 *
 * 只接受 `history/v{6 位以上数字}-{时间戳}.json` 或 `.json.gz`，
 * 且 history/ 之后不得再出现 `/` —— 顺带挡掉 `..` 与绝对路径。
 */
export function isHistoryFilePath(file: string): boolean {
  if (!file.startsWith(REMOTE_FILES.historyDir)) return false;
  const name = file.slice(REMOTE_FILES.historyDir.length);
  if (name === '' || name.includes('/') || name.includes('\\')) return false;
  return NAME_RE.test(name);
}

/**
 * 从文件名反解版本号与时间戳，供「刷新索引」重建（FR-15）。
 * 认不出的名字返回 null —— 目录里可能有用户手工放进去的文件。
 */
export function parseHistoryFileName(name: string): { version: number; writtenAt: string } | null {
  const bare = name.split('/').pop() ?? name;
  const m = NAME_RE.exec(bare);
  if (m === null) return null;

  const version = Number(m[1]);
  if (!Number.isFinite(version)) return null;

  // 把连字符还原成 ISO 形式：yyyy-mm-ddThh-mm-ss-sssZ → yyyy-mm-ddThh:mm:ss.sssZ
  const stamp = m[2]!;
  const restored = stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{1,3})Z$/,
    '$1:$2:$3.$4Z',
  );
  const writtenAt = Number.isNaN(Date.parse(restored)) ? '' : restored;
  return { version, writtenAt };
}

/**
 * 把一条新记录并入索引。
 *
 * 按版本号降序（新的在前），同版本号去重后以新记录为准 —— 步骤 8 失败后
 * 下次提交会重写索引，重复写入同一版本必须幂等（需求 5.3 关键点第 3 条）。
 */
export function appendToIndex(index: HistoryIndex, entry: HistoryEntry): HistoryIndex {
  const rest = index.entries.filter((e) => e.version !== entry.version);
  const entries = [entry, ...rest].sort((a, b) => b.version - a.version);
  return { formatVersion: 1, entries };
}

/**
 * 用目录列举重建索引（FR-15 的「刷新索引」按钮）。
 *
 * 只从文件名恢复版本号与时间戳。书签数与文件夹数需要下载每份快照才能知道，
 * 而那正是 FR-15 要避免的开销 —— 几千个历史文件会让重建变成几千次请求。
 * 因此重建出的条目计数为 0，设置页把 0 显示为「—」。
 */
export function rebuildIndexFromNames(names: readonly string[]): HistoryIndex {
  const entries: HistoryEntry[] = [];
  for (const name of names) {
    if (name === 'index.json') continue;
    const parsed = parseHistoryFileName(name);
    if (parsed === null) continue;
    entries.push({
      version: parsed.version,
      writtenAt: parsed.writtenAt,
      writtenBy: '',
      bookmarks: 0,
      folders: 0,
      file: `${REMOTE_FILES.historyDir}${name.split('/').pop()}`,
    });
  }
  entries.sort((a, b) => b.version - a.version);
  return { formatVersion: 1, entries };
}

/**
 * 把重建结果并入已有索引（审计 M-4）。
 *
 * 「刷新索引」只能从文件名恢复版本号与时间戳 —— 设备名与条目计数要下载每份快照
 * 才知道，而那正是 FR-15 要避免的开销。原实现直接用重建结果整体覆盖，于是一次
 * 刷新就把已有条目的 writtenBy 与计数全抹成空值和 0，而这些信息只有当时提交的
 * 那台设备知道，谁也补不回来。
 *
 * 所以：以文件名为准决定「有哪些版本」（这是刷新的目的：捡回索引里漏掉的、去掉
 * 已经不存在的），但每条的展示字段优先沿用已有索引里的那份。
 */
export function mergeRebuiltIndex(existing: HistoryIndex, rebuilt: HistoryIndex): HistoryIndex {
  const byVersion = new Map(existing.entries.map((e) => [e.version, e]));
  const entries = rebuilt.entries.map((fresh) => {
    const old = byVersion.get(fresh.version);
    if (old === undefined) return fresh;
    return {
      ...fresh,
      // 只在旧记录确实有值时才沿用，避免把空值又抄回来。
      writtenAt: old.writtenAt !== '' ? old.writtenAt : fresh.writtenAt,
      writtenBy: old.writtenBy !== '' ? old.writtenBy : fresh.writtenBy,
      bookmarks: old.bookmarks > 0 ? old.bookmarks : fresh.bookmarks,
      folders: old.folders > 0 ? old.folders : fresh.folders,
    };
  });
  entries.sort((a, b) => b.version - a.version);
  return { formatVersion: 1, entries };
}

/** 设置页展示用的估算占用（需求 13：让用户自行判断是否该清理）。 */export function estimateIndexBytes(index: HistoryIndex, bytesPerSnapshot: number): number {
  return index.entries.length * Math.max(0, Math.floor(bytesPerSnapshot));
}

export const EMPTY_INDEX: HistoryIndex = { formatVersion: 1, entries: [] };
