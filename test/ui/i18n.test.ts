import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const messages = JSON.parse(readFileSync(path.join(root, '_locales/zh_CN/messages.json'), 'utf8')) as Record<string, unknown>;

describe('i18n contract', () => {
  it('defines every static key referenced by UI markup', () => {
    const files = ['src/ui/popup/popup.html', 'src/ui/options/options.html'];
    const keys = new Set<string>();
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]!);
      for (const match of source.matchAll(/data-i18n-attr="[^:",]+:([^",]+)"/g)) keys.add(match[1]!);
    }
    expect([...keys].filter((key) => !(key in messages))).toEqual([]);
  });

  it('defines every literal key referenced by UI scripts', () => {
    // 只扫描字面量 key。模板字面量拼出的 key 家族由下一个用例覆盖。
    const files = ['src/ui/popup/popup.ts', 'src/ui/options/options.ts'];
    const keys = new Set<string>();
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/\bt\(\s*'([A-Za-z]\w*)'/g)) keys.add(match[1]!);
      // confirmDialog(titleKey, bodyKey) 的两个实参同样是语言包 key。
      for (const match of source.matchAll(/confirmDialog\(\s*'(\w+)'\s*,\s*'(\w+)'/g)) {
        keys.add(match[1]!);
        keys.add(match[2]!);
      }
    }
    expect(keys.size).toBeGreaterThan(0);
    expect([...keys].filter((key) => !(key in messages)).sort()).toEqual([]);
  });

  it('defines every messageKey carried by error classes', () => {
    const source = readFileSync(path.join(root, 'src/shared/errors.ts'), 'utf8');
    const keys = [...source.matchAll(/messageKey:\s*'(\w+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !(key in messages)).sort()).toEqual([]);
  });

  it('defines dynamic phase and confirmation key families', () => {
    const expected = [
      ...['idle', 'read', 'merge', 'guard', 'applyLocal', 'putHistory', 'putBookmarks', 'verify', 'putIndex', 'writeBaseline', 'done'].map(
        (phase) => `phase_${phase}`,
      ),
      ...['upload', 'download', 'deleteGuard', 'firstSync'].map((kind) => `confirmTitle_${kind}`),
      ...['merge', 'useLocal', 'useRemote'].map((choice) => `firstSync_${choice}`),
    ];
    expect(expected.filter((key) => !(key in messages))).toEqual([]);
  });
});
