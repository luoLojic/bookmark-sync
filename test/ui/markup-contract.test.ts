import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

/**
 * 静态契约护栏：本文件覆盖的全部是「只在真实浏览器里才会暴露、536 例逻辑测试
 * 结构上看不到」的失败类型 —— 与确认覆盖层那个缺陷同源。
 *
 * 其中 $() 契约的后果最重：popup.ts / options.ts 用
 *   const $ = (id) => { const el = document.getElementById(id); if (!el) throw ... }
 * 在模块顶层构造 el 表，一个 id 写错即在加载时抛错，整个页面空白且无任何提示。
 */

interface Page {
  readonly name: string;
  readonly html: string;
  readonly css: string;
  readonly script: string;
}

const pages: readonly Page[] = [
  {
    name: 'popup',
    html: 'src/ui/popup/popup.html',
    css: 'src/ui/popup/popup.css',
    script: 'src/ui/popup/popup.ts',
  },
  {
    name: 'options',
    html: 'src/ui/options/options.html',
    css: 'src/ui/options/options.css',
    script: 'src/ui/options/options.ts',
  },
];

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
}

/** 脚本里 $('x') 与 getElementById('x') 引用到的 id。 */
function referencedIds(script: string): Set<string> {
  const out = new Set<string>();
  for (const m of script.matchAll(/\$<[^>]*>\(\s*'([^']+)'\s*\)/g)) out.add(m[1]!);
  for (const m of script.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) out.add(m[1]!);
  for (const m of script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) out.add(m[1]!);
  return out;
}

describe('页面脚本与标记的 id 契约', () => {
  for (const page of pages) {
    it(`${page.name} 脚本引用的每个 id 都存在于 HTML`, () => {
      const present = ids(read(page.html));
      const wanted = referencedIds(read(page.script));
      // 用例本身不能空转：脚本必须确实按 id 取过元素。
      expect(wanted.size).toBeGreaterThan(0);
      expect([...wanted].filter((id) => !present.has(id)).sort()).toEqual([]);
    });

    it(`${page.name} 的 id 没有重复`, () => {
      const html = read(page.html);
      const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
      const dup = all.filter((id, i) => all.indexOf(id) !== i);
      // getElementById 只返回第一个，重复 id 会让脚本操作到错的元素。
      expect([...new Set(dup)].sort()).toEqual([]);
    });
  }
});

describe('HTML 内部引用完整', () => {
  for (const page of pages) {
    it(`${page.name} 的 label[for] 与 aria 引用都指向真实 id`, () => {
      const html = read(page.html);
      const present = ids(html);
      const dangling: string[] = [];
      for (const m of html.matchAll(/\bfor="([^"]+)"/g)) {
        if (!present.has(m[1]!)) dangling.push(`for=${m[1]!}`);
      }
      for (const m of html.matchAll(/\baria-(?:labelledby|describedby|controls)="([^"]+)"/g)) {
        for (const token of m[1]!.split(/\s+/).filter(Boolean)) {
          if (!present.has(token)) dangling.push(`aria=${token}`);
        }
      }
      expect(dangling.sort()).toEqual([]);
    });

    it(`${page.name} 引用的 css / js 会被打包进 dist`, () => {
      const html = read(page.html);
      const assets = [
        ...[...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]!),
        ...[...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!),
      ];
      expect(assets.length).toBeGreaterThan(0);
      // 构建脚本把 html/css 平铺到 dist 根，js 由 esbuild 以入口名产出。
      const build = read('scripts/build.mjs');
      for (const asset of assets) {
        expect(asset).not.toMatch(/^(?:https?:)?\/\//);
        expect(asset).not.toContain('/');
        if (asset.endsWith('.css')) {
          expect(build, `${asset} 未出现在 build.mjs 的静态拷贝表`).toContain(`'${asset}'`);
        } else {
          const entry = asset.replace(/\.js$/, '');
          expect(build, `缺少入口 ${entry}`).toMatch(new RegExp(`\\b${entry}:\\s*'\\./src/`));
        }
      }
    });
  }
});

describe('manifest 与打包产物一致', () => {
  const manifest = JSON.parse(read('src/manifest.json')) as Record<string, unknown>;

  it('manifest 引用的文件都能在构建产物里找到来源', () => {
    // 图标由 gen-icons.mjs 生成，html/css 由静态拷贝，js 由 esbuild 入口。
    const build = read('scripts/build.mjs');
    const refs = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        if (/\.(js|html|css|png)$/.test(v)) refs.add(v);
        return;
      }
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(manifest);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      if (ref.endsWith('.png')) {
        expect(ref).toMatch(/^icons\/icon(16|32|48|128)\.png$/);
      } else if (ref.endsWith('.js')) {
        expect(build).toMatch(new RegExp(`\\b${ref.replace(/\.js$/, '')}:\\s*'\\./src/`));
      } else {
        expect(build).toContain(`'${ref}'`);
      }
    }
  });

  it('default_locale 指向真实存在的语言包', () => {
    const locale = manifest['default_locale'] as string;
    expect(readdirSync(path.join(root, '_locales'))).toContain(locale);
    const messages = JSON.parse(
      read(`_locales/${locale}/messages.json`),
    ) as Record<string, { message?: string }>;
    // manifest 里的 __MSG_x__ 必须在语言包中定义，否则扩展加载即失败。
    for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
      expect(messages, `manifest 引用了未定义的 ${m[1]!}`).toHaveProperty(m[1]!);
    }
  });

  it('声明的权限与代码实际使用的一致', () => {
    const declared = new Set(manifest['permissions'] as string[]);
    // 少声明会在运行时抛错；多声明会在商店审核时被问，也放大授权面。
    expect([...declared].sort()).toEqual(['alarms', 'bookmarks', 'storage']);
    const src = (() => {
      let all = '';
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.ts')) all += readFileSync(full, 'utf8');
        }
      };
      walk(path.join(root, 'src'));
      return all;
    })();
    for (const api of declared) {
      expect(src, `声明了 ${api} 权限但代码从未使用`).toMatch(new RegExp(`chrome\\.${api}\\b`));
    }
  });
});
