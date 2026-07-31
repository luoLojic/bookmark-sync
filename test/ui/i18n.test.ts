import { readFileSync, readdirSync } from 'node:fs';
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
    const keys = [
      ...[...source.matchAll(/messageKey:\s*'(\w+)'/g)].map((m) => m[1]!),
      // 类字段形式：override readonly messageKey = 'errX';
      ...[...source.matchAll(/messageKey\s*=\s*'(\w+)'/g)].map((m) => m[1]!),
    ];
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

describe('i18n 语言包无冗余', () => {
  /** 扫描全部 src 文件里出现的 key（含 data-i18n-attr 与错误类字段）。 */
  function referencedKeys(): Set<string> {
    const keys = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|html)$/.test(entry.name)) continue;
        const source = readFileSync(full, 'utf8');
        for (const m of source.matchAll(/\bt\(\s*'([A-Za-z]\w*)'/g)) keys.add(m[1]!);
        for (const m of source.matchAll(/data-i18n="([A-Za-z]\w*)"/g)) keys.add(m[1]!);
        for (const m of source.matchAll(/data-i18n-attr="[^:",]+:([^",]+)"/g)) keys.add(m[1]!);
        for (const m of source.matchAll(/confirmDialog\(\s*'(\w+)'\s*,\s*'(\w+)'/g)) {
          keys.add(m[1]!);
          keys.add(m[2]!);
        }
        for (const m of source.matchAll(/messageKey:\s*'(\w+)'/g)) keys.add(m[1]!);
        for (const m of source.matchAll(/messageKey\s*=\s*'(\w+)'/g)) keys.add(m[1]!);
        // 错误文案有时不经 messageKey 字段，而是按错误码在表里挑一条（例如定时
        // 同步被拦下时换成带行动指引的那一句）。err 前缀的裸字面量也算引用 ——
        // 这条规则不会放过真正的死文案：没人提到的 key 依然扫不到。
        for (const m of source.matchAll(/'(err[A-Za-z]\w*)'/g)) keys.add(m[1]!);
      }
    };
    walk(path.join(root, 'src'));
    return keys;
  }

  it('语言包里没有无人引用的 key', () => {
    // 死文案会在翻译时被照样翻一遍，也会让人误以为某个界面存在。
    // 模板化的 key 家族与 manifest 直接读的 key 例外。
    const prefixes = ['phase_', 'confirmTitle_', 'firstSync_', 'side_'];
    const manifestKeys = ['extName', 'extShortName', 'extDescription'];
    const used = referencedKeys();
    const orphans = Object.keys(messages).filter(
      (key) =>
        !used.has(key) && !prefixes.some((p) => key.startsWith(p)) && !manifestKeys.includes(key),
    );
    expect(orphans).toEqual([]);
  });
});
