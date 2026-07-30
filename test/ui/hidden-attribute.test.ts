import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

/**
 * 回归护栏：hidden 属性只靠 UA 样式表的 display: none 生效，作者样式里任何
 * 显式 display 声明都会盖过它。options.css 曾因 .overlay { display: flex }
 * 缺少兜底，导致确认覆盖层在打开设置页时就显示、且脚本设 hidden 也关不掉。
 * 只要页面脚本用 el.hidden 控制显隐，样式表就必须有全局兜底。
 */

interface Page {
  readonly name: string;
  readonly html: string;
  readonly css: string;
}

const pages: readonly Page[] = [
  { name: 'popup', html: 'src/ui/popup/popup.html', css: 'src/ui/popup/popup.css' },
  { name: 'options', html: 'src/ui/options/options.html', css: 'src/ui/options/options.css' },
];

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

/** 去掉注释，避免注释里的示例代码被当成生效规则。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('hidden 属性不被 display 规则压过', () => {
  for (const page of pages) {
    it(`${page.name} 样式表有全局 [hidden] 兜底`, () => {
      const css = stripComments(read(page.css));
      // 选择器必须是裸 [hidden]（而非 .overlay[hidden] 这类窄规则），
      // 才能覆盖后续新增的任意 display 规则。
      const guard = /(^|[,{}\s])\[hidden\]\s*\{[^}]*\}/.exec(css);
      expect(guard, `${page.css} 缺少 [hidden] 兜底规则`).not.toBeNull();
      const body = guard![0];
      expect(body).toMatch(/display\s*:\s*none\s*!important/);
    });

    it(`${page.name} 每个带 hidden 的元素都在兜底覆盖范围内`, () => {
      const html = read(page.html);
      // 至少要有元素用到 hidden，否则本用例是空转的。
      const marked = [...html.matchAll(/<(\w+)[^>]*\shidden(?=[\s>])[^>]*>/g)];
      expect(marked.length).toBeGreaterThan(0);
      const css = stripComments(read(page.css));
      // 兜底带 !important 且选择器无限定，特异性再高的 display 规则也压不过。
      expect(css).toMatch(/(^|[,{}\s])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
    });
  }

  it('覆盖 src/ui 下的全部样式表', () => {
    // 新增页面时若忘了加进 pages，这里会失败，兜底检查不会悄悄漏掉新页面。
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.css')) found.push(path.relative(root, full).replaceAll('\\', '/'));
      }
    };
    walk(path.join(root, 'src/ui'));
    expect(found.sort()).toEqual(pages.map((p) => p.css).sort());
  });
});
