/**
 * test/ui/class-contract.test.ts —— 脚本里用到的 class 必须在样式表里存在（L-1）。
 *
 * popup.ts 三处都设 `className = 'error'`，而 popup.css 里定义的是 `.err`
 * （options.css 定义的才是 `.error`）。后果：错误文字不变红、不 word-break，
 * 长错误信息把 320px 的弹窗撑破。两个页面各用一套约定，写错是必然的。
 *
 * markup-contract.test.ts 已经把「只在浏览器里才暴露的失败」变成静态断言，但它
 * 只校验 id、label、资源引用与 manifest，class 是个缺口 —— 这类错误不会抛异常、
 * 不会被任何单元测试碰到，只会让界面悄悄失效。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const uiDir = path.join(root, 'src', 'ui');

interface Page {
  name: string;
  scripts: string[];
  css: string;
  html: string;
}

function readPage(name: string): Page {
  const dir = path.join(uiDir, name);
  const files = readdirSync(dir);
  return {
    name,
    scripts: files.filter((f) => f.endsWith('.ts')).map((f) => readFileSync(path.join(dir, f), 'utf8')),
    css: files
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n'),
    html: files
      .filter((f) => f.endsWith('.html'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n'),
  };
}

const pages = readdirSync(uiDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => readPage(e.name));

/** 去掉 CSS 注释：注释里要能自由讨论旧类名。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 样式表里定义过的类名。 */
function definedClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripCssComments(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]!);
  return out;
}

/** 脚本里 className = '…' 与 classList.add('…') 用到的类名。 */
function usedClasses(scripts: string[]): Set<string> {
  const out = new Set<string>();
  for (const src of scripts) {
    for (const m of src.matchAll(/className\s*=\s*'([^']*)'/g)) {
      for (const cls of m[1]!.split(/\s+/)) if (cls !== '') out.add(cls);
    }
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([^']+)'/g)) out.add(m[1]!);
    // 三元里的 className = a ? 'x' : 'y' 会被上面的正则漏掉一支，这里补上。
    for (const m of src.matchAll(/className\s*=\s*[^;]*?\?\s*'([^']*)'\s*:\s*'([^']*)'/g)) {
      for (const cls of [...m[1]!.split(/\s+/), ...m[2]!.split(/\s+/)]) if (cls !== '') out.add(cls);
    }
  }
  return out;
}

describe('先确认扫到了东西', () => {
  it('两个界面都被扫到，且各自有脚本与样式', () => {
    expect(pages.map((p) => p.name).sort()).toEqual(['options', 'popup']);
    for (const page of pages) {
      expect(page.scripts.length, page.name).toBeGreaterThan(0);
      expect(page.css.length, page.name).toBeGreaterThan(100);
    }
  });
});

describe('脚本设置的每个 class 都在同页样式表里有定义', () => {
  for (const page of pages) {
    it(`${page.name}`, () => {
      const defined = definedClasses(page.css);
      const used = usedClasses(page.scripts);
      // 至少要扫到几个，否则正则失效会让断言空转。
      expect(used.size, `${page.name} 没扫到任何 className`).toBeGreaterThan(2);
      for (const cls of used) {
        expect(defined.has(cls), `${page.name}: 脚本用了 .${cls}，样式表里没有`).toBe(true);
      }
    });
  }
});

describe('HTML 里写的 class 也要有定义', () => {
  for (const page of pages) {
    it(`${page.name}`, () => {
      const defined = definedClasses(page.css);
      const used = new Set<string>();
      for (const m of page.html.matchAll(/class="([^"]+)"/g)) {
        for (const cls of m[1]!.split(/\s+/)) if (cls !== '') used.add(cls);
      }
      expect(used.size, `${page.name} 没扫到任何 class 属性`).toBeGreaterThan(2);
      for (const cls of used) {
        expect(defined.has(cls), `${page.name}: HTML 用了 .${cls}，样式表里没有`).toBe(true);
      }
    });
  }
});

describe('两个界面对同一语义用同一个类名', () => {
  it('错误态一律是 .error，不再有 .err', () => {
    for (const page of pages) {
      expect(definedClasses(page.css).has('error'), `${page.name} 缺少 .error`).toBe(true);
      expect(stripCssComments(page.css), `${page.name} 还留着 .err`).not.toMatch(
        /(^|[^\w-])\.err(?![\w-])/,
      );
    }
  });
});
