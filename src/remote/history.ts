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

/** 设置页展示用的估算占用（需求 13：让用户自行判断是否该清理）。 */
export function estimateIndexBytes(index: HistoryIndex, bytesPerSnapshot: number): number {
  return index.entries.length * Math.max(0, Math.floor(bytesPerSnapshot));
}

export const EMPTY_INDEX: HistoryIndex = { formatVersion: 1, entries: [] };
