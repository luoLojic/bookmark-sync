/**
 * test/shared/invariants.test.ts —— 把三条架构红线与两条状态不变量落成静态检查。
 *
 * 这些约束原本只写在注释里（「★ 唯一合法调用点」「必须删除而不是写哨兵」），
 * 而注释拦不住任何人。审计里 H-1 的成因恰恰是「作废」被实现成写一条哨兵记录
 * 而读取侧不认识它 —— 这类缺陷在运行时很难被单元测试碰到，静态检查却一眼看穿。
 *
 * 检查的是源码文本。这有点粗糙（换个写法就绕过了），但它挡住的是「顺手加一个
 * 调用点」这种真实的退化方式，而不是刻意的规避。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((path) => {
  const text = readFileSync(path, 'utf8');
  return {
    path,
    rel: path.slice(SRC.length + 1).replace(/\\/g, '/'),
    text,
    /** 去掉注释行后的正文。注释里必须能自由讨论这些约束，否则文档就没法写。 */
    code: text
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n'),
  };
});

/** 调用点：排除定义、import、注释里的提及。 */
function callersOf(fn: string): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const line of f.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('import') || trimmed.startsWith('export async function') || trimmed.startsWith('export function')) continue;
      if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) out.push(f.rel);
    }
  }
  return [...new Set(out)];
}

describe('源码里确实存在待检查的文件', () => {
  it('扫到了 src 下的 TypeScript 文件', () => {
    // 先断言目标已找到，再断言约束 —— 否则路径写错会让所有检查静默通过。
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => f.rel)).toContain('background.ts');
    expect(files.map((f) => f.rel)).toContain('platform/storage.ts');
  });
});

describe('INV-1：基线只有一个写入点', () => {
  it('setBaseline 只被 background.ts 的依赖装配调用', () => {
    // engine/commit.ts 通过注入的 saveBaseline 回调触发写入，自己不认识 storage。
    expect(callersOf('setBaseline')).toEqual(['background.ts']);
  });

  it('engine 与 domain 都不直接 import storage', () => {
    for (const f of files) {
      if (!f.rel.startsWith('engine/') && !f.rel.startsWith('domain/')) continue;
      expect(f.code, `${f.rel} 不该直接依赖 storage`).not.toMatch(/platform\/storage\.js/);
    }
  });
});

describe('INV-3：清基线的入口受限', () => {
  it('clearBaseline 只在 storage.ts 内部被 resetSyncState 调用', () => {
    expect(callersOf('clearBaseline')).toEqual(['platform/storage.ts']);
  });
});

describe('H-1：能力缓存的作废必须是删除，不能写哨兵', () => {
  it('src 里没有任何地方写 probedAt 为空串', () => {
    for (const f of files) {
      // isCapsUsable 里可以出现 probedAt === ''（那是识别已经写进 storage 的
      // 旧哨兵），但不允许再有把空串**写进去**的对象字面量。
      expect(f.code, `${f.rel} 写了 caps 哨兵`).not.toMatch(/probedAt:\s*''/);
    }
  });

  it('作废走 clearCaps，且它确实在配置变更处被调用', () => {
    expect(callersOf('clearCaps')).toContain('background.ts');
  });
});

describe('红线一：domain 保持纯函数', () => {
  const forbidden = [
    { re: /\bchrome\./, why: 'chrome.* 属于 platform 层' },
    { re: /\bfetch\s*\(/, why: 'fetch 属于 platform/http' },
    { re: /\bDate\.now\s*\(/, why: '时间必须注入' },
    { re: /\bnew Date\s*\(/, why: '时间必须注入' },
    { re: /\bMath\.random\s*\(/, why: '随机源必须注入' },
    { re: /\bcrypto\./, why: '哈希必须注入' },
  ];

  it('domain/ 下不出现任何不纯来源', () => {
    const domain = files.filter((f) => f.rel.startsWith('domain/'));
    expect(domain.length).toBeGreaterThan(5);
    for (const f of domain) {
      for (const { re, why } of forbidden) {
        expect(f.code, `${f.rel}：${why}`).not.toMatch(re);
      }
    }
  });
});
