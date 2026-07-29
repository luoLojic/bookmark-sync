import { describe, expect, it } from 'vitest';
import {
  ROOT_GUID,
  cloneRoots,
  countRoots,
  emptyRoots,
  emptySnapshot,
  findNode,
  indexRoots,
  isBookmark,
  isFolder,
  isRootGuid,
  makeBookmark,
  makeFolder,
  makeSnapshot,
  rootKeyOf,
  subtreeGuids,
  totalEntries,
  walk,
} from '../../src/domain/tree.js';

function sample() {
  const roots = emptyRoots({ bar: '栏', other: '其他' });
  roots.bar.children = [
    makeBookmark('b-1', 'MDN', 'https://developer.mozilla.org/'),
    makeFolder('f-1', '技术', [makeBookmark('b-2', 'TS', 'https://typescriptlang.org/')]),
  ];
  roots.other.children = [makeFolder('f-2', '稍后')];
  return roots;
}

describe('tree model', () => {
  it('walks descendants in stable preorder and records paths', () => {
    const entries = [...walk(sample())];
    expect(entries.map((e) => e.node.guid)).toEqual(['b-1', 'f-1', 'b-2', 'f-2']);
    expect(entries[2]).toMatchObject({ parentGuid: 'f-1', index: 0, rootKey: 'bar', path: ['技术'] });
  });

  it('indexes node fields without indexing logical roots', () => {
    const index = indexRoots(sample());
    expect(index.size).toBe(4);
    expect(index.has(ROOT_GUID.bar)).toBe(false);
    expect(index.get('b-1')).toEqual({
      guid: 'b-1',
      type: 'bookmark',
      title: 'MDN',
      url: 'https://developer.mozilla.org/',
      parentGuid: ROOT_GUID.bar,
      index: 0,
    });
    expect(index.get('f-1')).toEqual({
      guid: 'f-1',
      type: 'folder',
      title: '技术',
      parentGuid: ROOT_GUID.bar,
      index: 1,
    });
  });

  it('clones deeply and finds both ordinary and root nodes', () => {
    const roots = sample();
    const clone = cloneRoots(roots);
    expect(clone).toEqual(roots);
    expect(clone).not.toBe(roots);
    expect(clone.bar.children[1]).not.toBe(roots.bar.children[1]);
    expect(findNode(roots, ROOT_GUID.other)).toBe(roots.other);
    expect(findNode(roots, 'b-2')?.title).toBe('TS');
    expect(findNode(roots, 'missing')).toBeNull();
  });

  it('counts nodes and complete subtrees', () => {
    const roots = sample();
    expect(countRoots(roots)).toEqual({ bookmarks: 2, folders: 2 });
    expect(totalEntries(roots)).toBe(4);
    const folder = findNode(roots, 'f-1');
    expect(folder).not.toBeNull();
    expect(subtreeGuids(folder!)).toEqual(['f-1', 'b-2']);
  });

  it('recognizes node and root discriminants', () => {
    const bookmark = makeBookmark('b-x', 'x', 'https://x.invalid/');
    const folder = makeFolder('f-x', 'x');
    expect(isBookmark(bookmark)).toBe(true);
    expect(isFolder(bookmark)).toBe(false);
    expect(isFolder(folder)).toBe(true);
    expect(isBookmark(folder)).toBe(false);
    expect(isRootGuid(ROOT_GUID.bar)).toBe(true);
    expect(isRootGuid('f-x')).toBe(false);
    expect(rootKeyOf(ROOT_GUID.bar)).toBe('bar');
    expect(rootKeyOf(ROOT_GUID.other)).toBe('other');
    expect(rootKeyOf('f-x')).toBeNull();
  });

  it('constructs empty and explicit snapshots without ambient time or randomness', () => {
    const empty = emptySnapshot();
    expect(empty).toMatchObject({ formatVersion: 1, version: 0, writerNonce: '', writtenBy: '' });
    const roots = sample();
    const snapshot = makeSnapshot(roots, {
      version: 7,
      writerNonce: 'nonce',
      writtenAt: '2026-07-29T00:00:00.000Z',
      writtenBy: 'Chrome-abcd',
      contentHash: 'sha256:test',
    });
    expect(snapshot.roots).toBe(roots);
    expect(snapshot.version).toBe(7);
  });
});
