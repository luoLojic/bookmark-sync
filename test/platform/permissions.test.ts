import { describe, expect, it } from 'vitest';
import { MisconfiguredError } from '../../src/shared/errors.js';
import {
  ensureOrigin,
  hasOrigin,
  originPatternOf,
  pruneOrigins,
  type PermissionsApi,
} from '../../src/platform/permissions.js';

/** 记录调用的假 permissions API。 */
function fakePermissions(granted: string[] = [], grantOnRequest = true) {
  const held = new Set(granted);
  const calls: string[] = [];
  const api: PermissionsApi = {
    async contains(perms) {
      calls.push(`contains:${perms.origins.join(',')}`);
      return perms.origins.every((o) => held.has(o));
    },
    async request(perms) {
      calls.push(`request:${perms.origins.join(',')}`);
      if (!grantOnRequest) return false;
      for (const o of perms.origins) held.add(o);
      return true;
    },
    async remove(perms) {
      calls.push(`remove:${perms.origins.join(',')}`);
      for (const o of perms.origins) held.delete(o);
      return true;
    },
    async getAll() {
      calls.push('getAll');
      return { origins: [...held] };
    },
  };
  return { api, calls, held };
}

describe('originPatternOf（NFR-13：权限最小化）', () => {
  it('只保留 scheme 与主机，路径一律 /*', () => {
    expect(originPatternOf('https://dav.example.com/remote.php/dav/files/me')).toBe('https://dav.example.com/*');
  });

  it('端口不写进模式 —— Chrome 的 match pattern 不支持按端口区分', () => {
    expect(originPatternOf('http://localhost:8080/dav')).toBe('http://localhost/*');
  });

  it('http 与 https 分别对待', () => {
    expect(originPatternOf('http://a.test/x')).toBe('http://a.test/*');
    expect(originPatternOf('https://a.test/x')).toBe('https://a.test/*');
  });

  it('绝不返回 *://*/* 这类宽泛模式', () => {
    const pattern = originPatternOf('https://a.test/x');
    expect(pattern).not.toContain('*://');
    expect(pattern.startsWith('https://a.test')).toBe(true);
  });

  it('非 http(s) 或无法解析时抛 MisconfiguredError', () => {
    expect(() => originPatternOf('ftp://a.test/x')).toThrow(MisconfiguredError);
    expect(() => originPatternOf('不是地址')).toThrow(MisconfiguredError);
    expect(() => originPatternOf('')).toThrow(MisconfiguredError);
  });
});

describe('ensureOrigin', () => {
  it('已有权限时直接返回，不弹窗打扰用户', async () => {
    const { api, calls } = fakePermissions(['https://a.test/*']);
    expect(await ensureOrigin('https://a.test/dav', api)).toBe(true);
    expect(calls.some((c) => c.startsWith('request:'))).toBe(false);
  });

  it('没有权限时发起申请', async () => {
    const { api, calls, held } = fakePermissions();
    expect(await ensureOrigin('https://a.test/dav', api)).toBe(true);
    expect(calls).toContain('request:https://a.test/*');
    expect(held.has('https://a.test/*')).toBe(true);
  });

  it('用户拒绝时返回 false', async () => {
    const { api } = fakePermissions([], false);
    expect(await ensureOrigin('https://a.test/dav', api)).toBe(false);
  });

  it('hasOrigin 只查不申请', async () => {
    const { api, calls } = fakePermissions();
    expect(await hasOrigin('https://a.test/dav', api)).toBe(false);
    expect(calls.every((c) => !c.startsWith('request:'))).toBe(true);
  });
});

describe('pruneOrigins（改地址后回收多余权限）', () => {
  it('保留当前使用的，撤销其余', async () => {
    const { api, held } = fakePermissions(['https://old.test/*', 'https://new.test/*']);
    const removed = await pruneOrigins('https://new.test/dav', api);
    expect(removed).toEqual(['https://old.test/*']);
    expect([...held]).toEqual(['https://new.test/*']);
  });

  it('没有要保留的地址时全部撤销', async () => {
    const { api, held } = fakePermissions(['https://a.test/*', 'https://b.test/*']);
    await pruneOrigins(null, api);
    expect([...held]).toEqual([]);
  });

  it('撤销失败不抛错 —— 多留一个权限不影响功能', async () => {
    const { api } = fakePermissions(['https://a.test/*']);
    const failing: PermissionsApi = {
      ...api,
      remove: async () => {
        throw new Error('拒绝撤销');
      },
    };
    await expect(pruneOrigins(null, failing)).resolves.toEqual([]);
  });

  it('保留地址无法解析时按「无保留」处理，不因此崩掉', async () => {
    const { api, held } = fakePermissions(['https://a.test/*']);
    await pruneOrigins('乱写的地址', api);
    expect([...held]).toEqual([]);
  });
});
