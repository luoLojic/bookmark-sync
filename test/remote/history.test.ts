import { describe, expect, it } from 'vitest';
import {
  EMPTY_INDEX,
  appendToIndex,
  estimateIndexBytes,
  formatVersion,
  historyFileName,
  isHistoryFilePath,
  mergeRebuiltIndex,
  parseHistoryFileName,
  rebuildIndexFromNames,
  safeTimestamp,
} from '../../src/remote/history.js';
import type { HistoryEntry } from '../../src/shared/types.js';

const entry = (version: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  version,
  writtenAt: `2026-07-30T10:00:0${version % 10}.000Z`,
  writtenBy: '台式机',
  bookmarks: 100 + version,
  folders: 10,
  file: historyFileName(version, `2026-07-30T10:00:0${version % 10}.000Z`, '.json.gz'),
  ...over,
});

describe('命名（方案 3.2）', () => {
  it('版本号补零到 6 位，使文件名字典序与版本号一致', () => {
    expect(formatVersion(1)).toBe('v000001');
    expect(formatVersion(123)).toBe('v000123');
    expect(formatVersion(1234567)).toBe('v1234567');
    // 字典序必须与数值序一致，否则目录列举出的顺序会乱。
    expect([formatVersion(9), formatVersion(10)].sort()).toEqual(['v000009', 'v000010']);
  });

  it('时间戳里的冒号与点被替换 —— 它们在 Windows 与部分服务器上非法', () => {
    expect(safeTimestamp('2026-07-28T10:30:00.334Z')).toBe('2026-07-28T10-30-00-334Z');
  });

  it('完整文件名符合需求 5.1 的示例形式', () => {
    expect(historyFileName(124, '2026-07-28T11:05:12.334Z', '.json.gz')).toBe(
      'history/v000124-2026-07-28T11-05-12-334Z.json.gz',
    );
  });

  it('压缩关闭时用 .json 后缀', () => {
    expect(historyFileName(1, '2026-07-28T11:05:12.334Z', '.json')).toMatch(/\.json$/);
  });
});

describe('parseHistoryFileName', () => {
  it('往返还原版本号与时间戳', () => {
    const iso = '2026-07-28T11:05:12.334Z';
    const name = historyFileName(124, iso, '.json.gz');
    expect(parseHistoryFileName(name)).toEqual({ version: 124, writtenAt: iso });
  });

  it('接受不带目录前缀的名字（目录列举返回的就是裸名）', () => {
    expect(parseHistoryFileName('v000007-2026-07-28T11-05-12-334Z.json')).toMatchObject({ version: 7 });
  });

  it('无法解析的名字返回 null —— 目录里可能有用户手工放的文件', () => {
    for (const bad of ['index.json', 'notes.txt', 'v1-x.json', 'vabcdef-x.json', '随手记.json.gz']) {
      expect(parseHistoryFileName(bad), bad).toBeNull();
    }
  });

  it('时间戳部分不合法时仍取出版本号，时间留空', () => {
    // 宁可少显示一个时间，也不要因为一个坏名字让整个历史列表消失。
    expect(parseHistoryFileName('v000009-乱写的时间.json')).toEqual({ version: 9, writtenAt: '' });
  });
});

describe('appendToIndex（FR-13 / FR-15）', () => {
  it('新记录排在最前', () => {
    const index = appendToIndex(appendToIndex(EMPTY_INDEX, entry(1)), entry(2));
    expect(index.entries.map((e) => e.version)).toEqual([2, 1]);
  });

  it('按版本号降序排列，与写入顺序无关', () => {
    let index = EMPTY_INDEX;
    for (const v of [3, 1, 2]) index = appendToIndex(index, entry(v));
    expect(index.entries.map((e) => e.version)).toEqual([3, 2, 1]);
  });

  it('同版本号重复写入是幂等的，且以新记录为准', () => {
    // 需求 5.3 关键点：步骤 8 失败后，下次成功提交会重写索引。
    const first = appendToIndex(EMPTY_INDEX, entry(5, { writtenBy: '旧' }));
    const second = appendToIndex(first, entry(5, { writtenBy: '新' }));
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.writtenBy).toBe('新');
  });

  it('不修改传入的索引', () => {
    const before = appendToIndex(EMPTY_INDEX, entry(1));
    const snapshot = structuredClone(before);
    appendToIndex(before, entry(2));
    expect(before).toEqual(snapshot);
  });
});

describe('rebuildIndexFromNames（FR-15 的「刷新索引」）', () => {
  it('从文件名重建，按版本号降序', () => {
    const index = rebuildIndexFromNames([
      'v000002-2026-07-28T11-00-00-000Z.json.gz',
      'v000001-2026-07-28T10-00-00-000Z.json.gz',
      'v000003-2026-07-28T12-00-00-000Z.json.gz',
    ]);
    expect(index.entries.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(index.entries[0]!.file).toBe('history/v000003-2026-07-28T12-00-00-000Z.json.gz');
  });

  it('跳过 index.json 与无法解析的文件', () => {
    const index = rebuildIndexFromNames(['index.json', '随手记.txt', 'v000001-2026-07-28T10-00-00-000Z.json']);
    expect(index.entries).toHaveLength(1);
  });

  it('计数留 0：从文件名无法得知书签数，下载每份快照正是 FR-15 要避免的开销', () => {
    const index = rebuildIndexFromNames(['v000001-2026-07-28T10-00-00-000Z.json.gz']);
    expect(index.entries[0]).toMatchObject({ bookmarks: 0, folders: 0, writtenBy: '' });
  });

  it('空目录得到空索引', () => {
    expect(rebuildIndexFromNames([])).toEqual(EMPTY_INDEX);
  });
});

describe('estimateIndexBytes（需求 13：让用户自行判断）', () => {
  it('按条数乘单份估算大小', () => {
    let index = EMPTY_INDEX;
    for (const v of [1, 2, 3]) index = appendToIndex(index, entry(v));
    expect(estimateIndexBytes(index, 8000)).toBe(24_000);
  });

  it('空索引为 0，负数单份大小按 0 处理', () => {
    expect(estimateIndexBytes(EMPTY_INDEX, 8000)).toBe(0);
    expect(estimateIndexBytes(appendToIndex(EMPTY_INDEX, entry(1)), -5)).toBe(0);
  });
});

/**
 * 历史路径校验（审计 BUG-13 / L-8）。
 *
 * 索引是远端内容，它的 file 字段会被直接交给 store.get，而 webdav 的 joinUrl
 * 不过滤 `..`。一份被篡改的 index.json 因此能让扩展带着 Basic 凭据去 GET 同一
 * 服务器上的任意路径，并把内容显示、下载给用户。
 */
describe('isHistoryFilePath', () => {
  it('接受本扩展自己写出来的名字', () => {
    for (const suffix of ['.json', '.json.gz'] as const) {
      const file = historyFileName(7, '2026-07-30T10:00:00.000Z', suffix);
      expect(isHistoryFilePath(file), file).toBe(true);
    }
    // 版本号超过 6 位同样合法（\d{6,}）。
    expect(isHistoryFilePath('history/v1234567-2026-07-30T10-00-00-000Z.json')).toBe(true);
  });

  it('★ 拒绝穿越、绝对路径与子目录', () => {
    for (const bad of [
      '../../../etc/passwd',
      'history/../bookmarks.json',
      'history/../../secret.json',
      '/history/v000001-x.json',
      'history/sub/v000001-2026-07-30T10-00-00-000Z.json',
      'history\v000001-2026-07-30T10-00-00-000Z.json',
      'history/v000001-2026-07-30T10-00-00-000Z.json/../../x',
    ]) {
      expect(isHistoryFilePath(bad), bad).toBe(false);
    }
  });

  it('拒绝目录之外、后缀不对与形状不对的名字', () => {
    for (const bad of [
      'bookmarks.json',
      'history/',
      'history/index.json',
      'history/v001-2026.json',
      'history/v000001-2026-07-30T10-00-00-000Z.txt',
      'history/notaversion.json',
      '',
    ]) {
      expect(isHistoryFilePath(bad), bad).toBe(false);
    }
  });

  it('刷新索引重建出来的每一条都通得过校验', () => {
    const rebuilt = rebuildIndexFromNames([
      'v000001-2026-07-30T10-00-00-000Z.json.gz',
      'v000002-2026-07-30T11-00-00-000Z.json',
      'index.json',
      '随手放进去的文件.txt',
    ]);
    expect(rebuilt.entries).toHaveLength(2);
    for (const e of rebuilt.entries) expect(isHistoryFilePath(e.file), e.file).toBe(true);
  });
});

/**
 * 「刷新索引」不能整体覆盖（审计 M-4）。
 *
 * 文件名里只有版本号与时间戳，设备名与条目计数要下载每份快照才知道 —— 那正是
 * FR-15 要避免的开销。直接用重建结果覆盖，就把这些信息抹成空值和 0，而它们只有
 * 当时提交的那台设备知道，谁也补不回来。
 */
describe('mergeRebuiltIndex', () => {
  const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
    version: 1,
    writtenAt: '2026-07-30T10:00:00.000Z',
    writtenBy: 'Chrome-ab',
    bookmarks: 358,
    folders: 47,
    file: 'history/v000001-2026-07-30T10-00-00-000Z.json.gz',
    ...over,
  });

  it('已有版本沿用已有的设备名与计数', () => {
    const existing = { formatVersion: 1 as const, entries: [entry({})] };
    const rebuilt = {
      formatVersion: 1 as const,
      entries: [entry({ writtenBy: '', bookmarks: 0, folders: 0 })],
    };
    const merged = mergeRebuiltIndex(existing, rebuilt);
    expect(merged.entries[0]).toMatchObject({ writtenBy: 'Chrome-ab', bookmarks: 358, folders: 47 });
  });

  it('索引里漏掉的版本被捡回来（这才是刷新的目的）', () => {
    const existing = { formatVersion: 1 as const, entries: [entry({})] };
    const rebuilt = {
      formatVersion: 1 as const,
      entries: [
        entry({ version: 2, writtenBy: '', bookmarks: 0, folders: 0, file: 'history/v000002-x.json' }),
        entry({ writtenBy: '', bookmarks: 0, folders: 0 }),
      ],
    };
    const merged = mergeRebuiltIndex(existing, rebuilt);
    expect(merged.entries.map((e) => e.version)).toEqual([2, 1]);
  });

  it('远端已不存在的版本被去掉 —— 以文件名为准决定有哪些版本', () => {
    const existing = {
      formatVersion: 1 as const,
      entries: [entry({}), entry({ version: 9, file: 'history/v000009-x.json' })],
    };
    const rebuilt = { formatVersion: 1 as const, entries: [entry({ writtenBy: '' })] };
    expect(mergeRebuiltIndex(existing, rebuilt).entries.map((e) => e.version)).toEqual([1]);
  });

  it('旧记录本身是空值时不把空值抄回来', () => {
    const existing = {
      formatVersion: 1 as const,
      entries: [entry({ writtenAt: '', writtenBy: '', bookmarks: 0, folders: 0 })],
    };
    const rebuilt = { formatVersion: 1 as const, entries: [entry({ writtenBy: '', bookmarks: 0, folders: 0 })] };
    const merged = mergeRebuiltIndex(existing, rebuilt);
    expect(merged.entries[0]!.writtenAt).toBe('2026-07-30T10:00:00.000Z');
  });
});
