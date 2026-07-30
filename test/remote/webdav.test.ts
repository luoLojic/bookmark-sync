import { describe, expect, it } from 'vitest';
import { AuthError, ConflictError, NotFoundError, ServerError, VerificationError } from '../../src/shared/errors.js';
import { createWebdavStore, parsePropfindNames } from '../../src/remote/webdav.js';
import { probeStore } from '../../src/remote/store.js';
import type { RemoteStore } from '../../src/remote/store.js';
import type { WebdavConfig } from '../../src/shared/types.js';
import { FakeRemote, type FakeRemoteOptions } from '../fakes/remote.js';

const utf8 = new TextEncoder();
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG: WebdavConfig = {
  url: 'https://dav.test/remote.php/dav/files/me',
  username: 'me',
  password: 'secret',
  basePath: '/bookmark-sync/',
};

function make(options: FakeRemoteOptions = {}, config: Partial<WebdavConfig> = {}) {
  const remote = new FakeRemote(options);
  const store = createWebdavStore(
    { ...CONFIG, ...config },
    { timeoutMs: 1000, maxRetries: 3, fetchImpl: remote.fetch, sleep: async () => undefined, random: () => 1 },
  );
  return { remote, store };
}

describe('webdav — 基本读写', () => {
  it('PUT 后 GET 得到同样的字节', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('{"a":1}'));
    const got = await store.get('bookmarks.json');
    expect(text(got!.bytes)).toBe('{"a":1}');
  });

  it('不存在的文件 GET 返回 null，而不是抛错', async () => {
    // 首次同步时远端本来就没有 bookmarks.json，这不是错误。
    const { store } = make();
    expect(await store.get('bookmarks.json')).toBeNull();
  });

  it('GET 带回 ETag', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('x'));
    expect((await store.get('bookmarks.json'))!.etag).toMatch(/^"v\d+"$/);
  });

  it('服务器不给 ETag 时 etag 为 undefined', async () => {
    const { store } = make({ etags: false });
    await store.put('bookmarks.json', utf8.encode('x'));
    expect((await store.get('bookmarks.json'))!.etag).toBeUndefined();
  });

  it('同名 PUT 覆盖旧内容（需求 13 的风险项）', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('old'));
    await store.put('bookmarks.json', utf8.encode('new'));
    expect(text((await store.get('bookmarks.json'))!.bytes)).toBe('new');
  });

  it('DELETE 幂等：删不存在的文件不抛错', async () => {
    const { store } = make();
    await expect(store.remove('nope.json')).resolves.toBeUndefined();
  });

  it('路径里的中文与空格被正确编码', async () => {
    const { remote, store } = make();
    await store.put('history/我的 快照.json', utf8.encode('x'));
    // 服务器侧看到的是解码后的路径，说明编码-解码往返正确。
    expect(remote.paths().some((p) => p.includes('我的 快照.json'))).toBe(true);
    expect(text((await store.get('history/我的 快照.json'))!.bytes)).toBe('x');
  });

  it('基础路径参与 URL 拼接', async () => {
    const { remote, store } = make({}, { basePath: '/深层/目录/' });
    await store.put('bookmarks.json', utf8.encode('x'));
    expect(remote.paths()[0]).toContain('/深层/目录/bookmarks.json');
  });
});

describe('webdav — 错误分类（方案第 6 节）', () => {
  it('401 抛 AuthError（Fatal，不重试）', async () => {
    const remote = new FakeRemote();
    const store = createWebdavStore(CONFIG, {
      timeoutMs: 1000,
      maxRetries: 3,
      sleep: async () => undefined,
      fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(store.get('bookmarks.json')).rejects.toBeInstanceOf(AuthError);
    expect(remote.countRequests()).toBe(0);
  });

  it('PUT 到不存在的路径得到 404 时抛 NotFoundError', async () => {
    const store = createWebdavStore(CONFIG, {
      timeoutMs: 1000,
      maxRetries: 0,
      sleep: async () => undefined,
      fetchImpl: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch,
    });
    await expect(store.put('a.json', utf8.encode('x'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('5xx 用尽重试后抛 ServerError（Transient）', async () => {
    const { store } = make({ errorRate: 1 });
    await expect(store.get('bookmarks.json')).rejects.toBeInstanceOf(ServerError);
  });

  it('412 抛 ConflictError，交给 engine 的合并轮次（FR-17）', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('v1'));
    await expect(
      store.put('bookmarks.json', utf8.encode('v2'), { ifMatch: '"wrong"' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('配置缺失或协议不对时抛 MisconfiguredError', () => {
    const deps = { timeoutMs: 1000, maxRetries: 0 };
    expect(() => createWebdavStore({ ...CONFIG, url: '' }, deps)).toThrow(/未配置/);
    expect(() => createWebdavStore({ ...CONFIG, url: 'ftp://x/y' }, deps)).toThrow(/http/);
  });
});

describe('webdav — 条件写（FR-17）', () => {
  it('ETag 匹配时写入成功', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('v1'));
    const etag = (await store.get('bookmarks.json'))!.etag!;
    await store.put('bookmarks.json', utf8.encode('v2'), { ifMatch: etag });
    expect(text((await store.get('bookmarks.json'))!.bytes)).toBe('v2');
  });

  it('其他设备已提交后原 ETag 失效 → 412', async () => {
    const { remote, store } = make();
    await store.put('bookmarks.json', utf8.encode('v1'));
    const stale = (await store.get('bookmarks.json'))!.etag!;
    const key = remote.paths().find((p) => p.endsWith('bookmarks.json'))!;

    remote.commitFromOtherDevice(key, utf8.encode('other device'));

    await expect(
      store.put('bookmarks.json', utf8.encode('mine'), { ifMatch: stale }),
    ).rejects.toBeInstanceOf(ConflictError);
    // 关键：对方的提交没有被覆盖 —— 这正是乐观并发要保住的东西（FR-17）。
    expect(text(remote.read(key)!)).toBe('other device');
  });

  it('不支持条件写的服务器会忽略 If-Match 直接写成功（FR-18 的降级前提）', async () => {
    const { store } = make({ ifMatch: false });
    await store.put('bookmarks.json', utf8.encode('v1'));
    await expect(
      store.put('bookmarks.json', utf8.encode('v2'), { ifMatch: '"definitely-wrong"' }),
    ).resolves.toBeTruthy();
  });
});

describe('probeStore — 能力探测（方案 5.1）', () => {
  const now = (): Date => new Date('2026-07-30T10:00:00.000Z');

  it('支持条件写的服务器被识别为 ifMatch: true', async () => {
    const { store } = make();
    const caps = await probeStore(store, { now, compress: true });
    expect(caps).toMatchObject({ ifMatch: true, suffix: '.json.gz', probedAt: '2026-07-30T10:00:00.000Z' });
  });

  it('忽略 If-Match 的服务器被识别为 false', async () => {
    // 只测「用对的 ETag 能通过」查不出这种服务器 —— 它对什么都返回 2xx。
    const { store } = make({ ifMatch: false });
    expect((await probeStore(store, { now, compress: true })).ifMatch).toBe(false);
  });

  it('不返回 ETag 的服务器直接判为不支持', async () => {
    const { store } = make({ etags: false });
    expect((await probeStore(store, { now, compress: true })).ifMatch).toBe(false);
  });

  it('探测完成后删除探测文件', async () => {
    const { remote, store } = make();
    await probeStore(store, { now, compress: true });
    expect(remote.paths().some((p) => p.endsWith('.probe'))).toBe(false);
  });

  it('压缩关闭时后缀为 .json', async () => {
    const { store } = make();
    expect((await probeStore(store, { now, compress: false })).suffix).toBe('.json');
  });

  it('读回内容与写入不一致时抛 VerificationError', async () => {
    // 截断是弱网下的真实风险，也可能是服务器缓存了旧内容。
    const { store } = make({ truncateRate: 1 });
    await expect(probeStore(store, { now, compress: true })).rejects.toBeInstanceOf(VerificationError);
  });

  it('写入后读不到时抛 VerificationError', async () => {
    const store: RemoteStore = {
      get: async () => null,
      put: async () => ({ etag: '"1"' }),
      remove: async () => undefined,
      list: async () => [],
      ensureContainer: async () => undefined,
    };
    await expect(probeStore(store, { now, compress: true })).rejects.toBeInstanceOf(VerificationError);
  });

  it('探测过程中的认证错误如实上抛，不被当成「不支持条件写」', async () => {
    // detectIfMatch 只把 ConflictError 解读为「支持」，其他错误必须原样抛出，
    // 否则一次 403 会被记成 caps.ifMatch = false 并永久降级。
    let stored = new Uint8Array();
    let puts = 0;
    const store: RemoteStore = {
      get: async () => ({ bytes: stored, etag: '"1"' }),
      put: async (_path, bytes) => {
        if (++puts > 1) throw new AuthError(403);
        stored = bytes;
        return { etag: '"1"' };
      },
      remove: async () => undefined,
      list: async () => [],
      ensureContainer: async () => undefined,
    };
    await expect(
      probeStore(store, { now: () => new Date(0), compress: true, path: 'p' }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('webdav — 目录与列举', () => {
  it('ensureContainer 逐级建目录，含 history/', async () => {
    const { remote, store } = make();
    await store.ensureContainer();
    const mkcols = remote.log.filter((r) => r.method === 'MKCOL').map((r) => r.path);
    expect(mkcols.some((p) => p.includes('/bookmark-sync'))).toBe(true);
    expect(mkcols.some((p) => p.includes('history'))).toBe(true);
  });

  it('目录已存在（405）时不报错', async () => {
    const { store } = make({ mkcol: false });
    await expect(store.ensureContainer()).resolves.toBeUndefined();
  });

  it('list 列出前缀下的文件（仅供刷新索引，FR-15）', async () => {
    const { store } = make();
    await store.put('history/v000001-a.json.gz', utf8.encode('x'));
    await store.put('history/v000002-b.json.gz', utf8.encode('y'));
    await store.put('bookmarks.json', utf8.encode('z'));
    const names = await store.list('history');
    expect(names.sort()).toEqual(['v000001-a.json.gz', 'v000002-b.json.gz']);
  });

  it('list 对不存在的前缀返回空数组', async () => {
    const { store } = make();
    expect(await store.list('history')).toEqual([]);
  });
});

describe('parsePropfindNames', () => {
  it('取出文件名，跳过目录自身', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/bookmark-sync/history/</D:href></D:response>
      <D:response><D:href>/dav/bookmark-sync/history/v000001-a.json.gz</D:href></D:response>
    </D:multistatus>`;
    expect(parsePropfindNames(xml)).toEqual(['v000001-a.json.gz']);
  });

  it('解码百分号编码的名字', () => {
    const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/%E4%B9%A6%E7%AD%BE.json</d:href></d:response></d:multistatus>';
    expect(parsePropfindNames(xml)).toEqual(['书签.json']);
  });

  it('命名空间前缀任意、大小写不敏感', () => {
    const xml = '<multistatus><response><HREF>/a/b.json</HREF></response></multistatus>';
    expect(parsePropfindNames(xml)).toEqual(['b.json']);
  });

  it('无 href 时返回空数组，不抛错', () => {
    expect(parsePropfindNames('<multistatus/>')).toEqual([]);
    expect(parsePropfindNames('完全不是 XML')).toEqual([]);
  });
});
