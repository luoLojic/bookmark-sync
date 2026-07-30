import { describe, expect, it } from 'vitest';
import { applyGuidMapping, matchFirstSync } from '../../src/domain/firstsync.js';
import { mergeTrees } from '../../src/domain/merge.js';
import { countRoots, emptyRoots, indexRoots } from '../../src/domain/tree.js';
import { bk, fd, tree } from '../fixtures/trees.js';

// 本地与远端各自独立分配过 GUID，因此同一条书签在两侧 GUID 不同。
const L_B1 = 'b-1aaaaaaaaaaa';
const L_B2 = 'b-1bbbbbbbbbbb';
const L_F1 = 'f-1aaaaaaaaaaa';
const L_F2 = 'f-1bbbbbbbbbbb';
const R_B1 = 'b-2aaaaaaaaaaa';
const R_B2 = 'b-2bbbbbbbbbbb';
const R_F1 = 'f-2aaaaaaaaaaa';
const R_F2 = 'f-2bbbbbbbbbbb';

const MDN = 'https://developer.mozilla.org/';
const TS = 'https://www.typescriptlang.org/';

describe('matchFirstSync — 书签按父内 URL 匹配（需求 6.4）', () => {
  it('同一父文件夹内 URL 相同 → 视为同一条目', () => {
    const local = tree([bk(L_B1, '本地标题', MDN)]);
    const remote = tree([bk(R_B1, '远端标题', MDN)]);
    const m = matchFirstSync(local, remote);
    // 采纳远端 GUID：本设备的 GUID 是刚分配的，而远端 GUID 已被其他设备的
    // 基线引用，改写远端会让那些设备把条目当作「删除 + 新建」。
    expect(m.mapping.get(L_B1)).toBe(R_B1);
    expect(m.matchedBookmarks).toBe(1);
  });

  it('URL 相同但父文件夹不同 → 不匹配，两者都保留', () => {
    const local = tree([bk(L_B1, 'A', MDN)]);
    const remote = tree([fd(R_F1, '技术', [bk(R_B1, 'A', MDN)])]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });

  it('标题不同不影响匹配 —— URL 才是书签的身份', () => {
    const local = tree([bk(L_B1, '我改过的名字', MDN)]);
    const remote = tree([bk(R_B1, 'MDN Web Docs', MDN)]);
    expect(matchFirstSync(local, remote).mapping.get(L_B1)).toBe(R_B1);
  });

  it('URL 不同则不匹配', () => {
    const local = tree([bk(L_B1, 'A', MDN)]);
    const remote = tree([bk(R_B1, 'A', TS)]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });

  it('同一父下有多条相同 URL 时按出现顺序两两配对', () => {
    // 用户手动导入过同一批书签会造成重复。配对数取两侧较小值，多出的各自保留。
    const local = tree([bk(L_B1, 'A', MDN), bk(L_B2, 'A 副本', MDN)]);
    const remote = tree([bk(R_B1, 'A', MDN)]);
    const m = matchFirstSync(local, remote);
    expect(m.mapping.get(L_B1)).toBe(R_B1);
    expect(m.mapping.has(L_B2)).toBe(false);
  });

  it('两棵逻辑根互不匹配：书签栏与其他书签是不同命名空间', () => {
    const local = tree([bk(L_B1, 'A', MDN)]);
    const remote = tree([], [bk(R_B1, 'A', MDN)]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });
});

describe('matchFirstSync — 文件夹按完整路径匹配（需求 6.4）', () => {
  it('从逻辑根起的完整路径相同 → 视为同一文件夹', () => {
    const local = tree([fd(L_F1, '技术')]);
    const remote = tree([fd(R_F1, '技术')]);
    const m = matchFirstSync(local, remote);
    expect(m.mapping.get(L_F1)).toBe(R_F1);
    expect(m.matchedFolders).toBe(1);
  });

  it('嵌套路径逐层匹配', () => {
    const local = tree([fd(L_F1, '技术', [fd(L_F2, '前端')])]);
    const remote = tree([fd(R_F1, '技术', [fd(R_F2, '前端')])]);
    const m = matchFirstSync(local, remote);
    expect(m.mapping.get(L_F1)).toBe(R_F1);
    expect(m.mapping.get(L_F2)).toBe(R_F2);
    expect(m.matchedFolders).toBe(2);
  });

  it('同名但路径不同 → 不匹配', () => {
    // 本地 bar/前端，远端 bar/技术/前端。
    const local = tree([fd(L_F2, '前端')]);
    const remote = tree([fd(R_F1, '技术', [fd(R_F2, '前端')])]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });

  it('路径匹配后其中的书签才可能按 URL 匹配', () => {
    const local = tree([fd(L_F1, '技术', [bk(L_B1, 'A', MDN)])]);
    const remote = tree([fd(R_F1, '技术', [bk(R_B1, 'A2', MDN)])]);
    const m = matchFirstSync(local, remote);
    expect(m.mapping.get(L_F1)).toBe(R_F1);
    expect(m.mapping.get(L_B1)).toBe(R_B1);
  });

  it('标题需完全一致，不做去空白或大小写归一', () => {
    // 放宽会带来更难解释的错配，需求只说「完整路径相同」。
    const local = tree([fd(L_F1, ' 技术')]);
    const remote = tree([fd(R_F1, '技术')]);
    expect(matchFirstSync(local, remote).mapping.size).toBe(0);
  });
});

describe('applyGuidMapping', () => {
  it('按映射改写 GUID，结构与顺序不变', () => {
    const local = tree([fd(L_F1, '技术', [bk(L_B1, 'A', MDN)]), bk(L_B2, 'B', TS)]);
    const out = applyGuidMapping(local, new Map([[L_F1, R_F1], [L_B1, R_B1]]));
    const idx = indexRoots(out);
    expect([...idx.keys()]).toEqual([R_F1, R_B1, L_B2]);
    expect(idx.get(R_B1)?.parentGuid).toBe(R_F1);
    expect(countRoots(out)).toEqual(countRoots(local));
  });

  it('不修改输入树', () => {
    const local = tree([bk(L_B1, 'A', MDN)]);
    const snapshot = structuredClone(local);
    applyGuidMapping(local, new Map([[L_B1, R_B1]]));
    expect(local).toEqual(snapshot);
  });

  it('映射为空时原样返回', () => {
    const local = tree([bk(L_B1, 'A', MDN)]);
    expect(applyGuidMapping(local, new Map())).toEqual(local);
  });
});

/**
 * 与三方合并串起来看（需求 6.4 / FR-4 的「合并」选项）。
 *
 * 首次同步等价于把基线视为空树做三方合并，但先用放宽的规则建立 GUID 映射，
 * 否则同一条书签会因两侧 GUID 不同而被判为「两侧各自新增」，产生重复。
 */
describe('首次同步合并全流程', () => {
  /** FR-4 的「合并双方」：先匹配、再改写、最后以空树为基线做三方合并。 */
  function mergeFirstSync(local: ReturnType<typeof tree>, remote: ReturnType<typeof tree>) {
    const { mapping } = matchFirstSync(local, remote);
    return mergeTrees({ base: emptyRoots(), local: applyGuidMapping(local, mapping), remote });
  }

  it('匹配上的条目不重复，未匹配的双方各自保留', () => {
    const local = tree([fd(L_F1, '技术', [bk(L_B1, 'MDN', MDN)]), bk(L_B2, '本地独有', 'https://only-local.test/')]);
    const remote = tree([fd(R_F1, '技术', [bk(R_B1, 'MDN', MDN)]), bk(R_B2, '远端独有', 'https://only-remote.test/')]);

    const out = mergeFirstSync(local, remote);
    const idx = indexRoots(out);

    // 技术文件夹与 MDN 各只剩一份，两侧独有的各自保留。
    expect(countRoots(out)).toEqual({ bookmarks: 3, folders: 1 });
    expect(idx.has(R_F1)).toBe(true);
    expect(idx.has(L_F1)).toBe(false);
    expect(idx.get(R_B1)?.parentGuid).toBe(R_F1);
    expect(idx.has(L_B2)).toBe(true);
    expect(idx.has(R_B2)).toBe(true);
  });

  it('不做匹配就直接合并会产生重复 —— 这条说明匹配步骤为何必要', () => {
    const local = tree([bk(L_B1, 'MDN', MDN)]);
    const remote = tree([bk(R_B1, 'MDN', MDN)]);
    // 反例：跳过 matchFirstSync。
    const naive = mergeTrees({ base: emptyRoots(), local, remote });
    expect(countRoots(naive).bookmarks).toBe(2);
    // 正确路径：同一条书签只剩一份。
    expect(countRoots(mergeFirstSync(local, remote)).bookmarks).toBe(1);
  });

  it('两侧完全相同时合并后与远端等价（无重复、无丢失）', () => {
    const local = tree([fd(L_F1, '技术', [bk(L_B1, 'MDN', MDN), bk(L_B2, 'TS', TS)])]);
    const remote = tree([fd(R_F1, '技术', [bk(R_B1, 'MDN', MDN), bk(R_B2, 'TS', TS)])]);
    expect(mergeFirstSync(local, remote)).toEqual(remote);
  });

  it('本地为空时结果就是远端内容（新设备接入的常见情形）', () => {
    const remote = tree([fd(R_F1, '技术', [bk(R_B1, 'MDN', MDN)])]);
    expect(mergeFirstSync(tree(), remote)).toEqual(remote);
  });

  it('远端为空时结果保留本地全部内容', () => {
    const local = tree([fd(L_F1, '技术', [bk(L_B1, 'MDN', MDN)])]);
    const out = mergeFirstSync(local, tree());
    expect(countRoots(out)).toEqual({ bookmarks: 1, folders: 1 });
  });

  it('匹配后仍以本地字段为准（∅ x x → Keep(L)）', () => {
    // 标题在两侧不同：GUID 已统一，走判定矩阵第 3 行，本地优先。
    const local = tree([bk(L_B1, '我的叫法', MDN)]);
    const remote = tree([bk(R_B1, '远端叫法', MDN)]);
    const out = mergeFirstSync(local, remote);
    expect(indexRoots(out).get(R_B1)?.title).toBe('我的叫法');
  });
});
