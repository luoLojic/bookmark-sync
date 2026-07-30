import { describe, expect, it } from 'vitest';
import { ConflictError, MisconfiguredError } from '../../src/shared/errors.js';
import { createS3Store, parseListKeys, parseNextToken } from '../../src/remote/s3.js';
import { probeStore } from '../../src/remote/store.js';
import type { S3Config } from '../../src/shared/types.js';

const utf8 = new TextEncoder();
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG: S3Config = {
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  prefix: 'bookmark-sync/',
  forcePathStyle: true,
};

/** 记录请求并按对象键存内容的最小 S3 假实现。 */
function fakeS3(options: { ifMatch?: boolean; etags?: boolean } = {}) {
  const files = new Map<string, { bytes: Uint8Array; etag: string }>();
  const log: { method: string; url: string; headers: Record<string, string> }[] = [];
  let counter = 0;
  const supportsIfMatch = options.ifMatch ?? true;
  const withEtags = options.etags ?? true;

  const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url.href;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    log.push({ method, url: href, headers });

    const parsed = new URL(href);
    const key = decodeURIComponent(parsed.pathname);

    if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
      const listPrefix = parsed.searchParams.get('prefix') ?? '';
      const keys = [...files.keys()]
        .map((k) => k.replace(`/${CONFIG.bucket}/`, ''))
        .filter((k) => k.startsWith(listPrefix));
      const xml =
        '<?xml version="1.0"?><ListBucketResult>' +
        keys.map((k) => `<Key>${k}</Key>`).join('') +
        '<IsTruncated>false</IsTruncated></ListBucketResult>';
      return new Response(xml, { status: 200 });
    }

    if (method === 'GET') {
      const file = files.get(key);
      if (file === undefined) return new Response('no', { status: 404 });
      return new Response(file.bytes as BlobPart, {
        status: 200,
        ...(withEtags ? { headers: { etag: file.etag } } : {}),
      });
    }

    if (method === 'PUT') {
      const ifMatch = headers['if-match'];
      const existing = files.get(key);
      if (supportsIfMatch && ifMatch !== undefined && existing?.etag !== ifMatch) {
        return new Response('precondition failed', { status: 412 });
      }
      const bytes = new Uint8Array(
        init?.body instanceof ArrayBuffer ? init.body : new ArrayBuffer(0),
      );
      const etag = `"e${++counter}"`;
      files.set(key, { bytes, etag });
      return new Response(null, { status: 200, ...(withEtags ? { headers: { etag } } : {}) });
    }

    if (method === 'DELETE') {
      files.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response('bad', { status: 400 });
  }) as unknown as typeof fetch;

  return { impl, log, files };
}

function make(config: Partial<S3Config> = {}, fake = fakeS3()) {
  const store = createS3Store(
    { ...CONFIG, ...config },
    {
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: fake.impl,
      sleep: async () => undefined,
      now: () => new Date('2026-07-30T10:00:00Z'),
    },
  );
  return { store, fake };
}

describe('s3 — 配置校验', () => {
  const deps = { timeoutMs: 1000, maxRetries: 0 };
  it('缺 Endpoint / Bucket / 凭据时抛 MisconfiguredError', () => {
    expect(() => createS3Store({ ...CONFIG, endpoint: '' }, deps)).toThrow(MisconfiguredError);
    expect(() => createS3Store({ ...CONFIG, bucket: '' }, deps)).toThrow(MisconfiguredError);
    expect(() => createS3Store({ ...CONFIG, accessKeyId: '' }, deps)).toThrow(MisconfiguredError);
    expect(() => createS3Store({ ...CONFIG, secretAccessKey: '' }, deps)).toThrow(MisconfiguredError);
  });

  it('Endpoint 协议不对时抛错', () => {
    expect(() => createS3Store({ ...CONFIG, endpoint: 's3://x' }, deps)).toThrow(/http/);
  });
});

describe('s3 — 寻址风格', () => {
  it('路径风格把 bucket 放在路径里（MinIO 等自建服务需要）', async () => {
    const { store, fake } = make({ forcePathStyle: true });
    await store.put('bookmarks.json', utf8.encode('x'));
    expect(fake.log[0]!.url).toBe(
      'https://s3.us-east-1.amazonaws.com/my-bucket/bookmark-sync/bookmarks.json',
    );
  });

  it('虚拟主机风格把 bucket 放进主机名', async () => {
    const { store, fake } = make({ forcePathStyle: false });
    await store.put('bookmarks.json', utf8.encode('x'));
    expect(fake.log[0]!.url).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/bookmark-sync/bookmarks.json');
  });

  it('路径前缀参与键名', async () => {
    const { store, fake } = make({ prefix: 'deep/nested/' });
    await store.put('a.json', utf8.encode('x'));
    expect(fake.log[0]!.url).toContain('/deep/nested/a.json');
  });

  it('中文与空格被 AWS 规则编码（大写十六进制）', async () => {
    const { store, fake } = make();
    await store.put('history/我的 快照.json', utf8.encode('x'));
    expect(fake.log[0]!.url).toContain('%E6%88%91%E7%9A%84%20');
  });
});

describe('s3 — 读写', () => {
  it('PUT 后 GET 得到同样的字节', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('{"a":1}'));
    expect(text((await store.get('bookmarks.json'))!.bytes)).toBe('{"a":1}');
  });

  it('不存在的键返回 null', async () => {
    const { store } = make();
    expect(await store.get('bookmarks.json')).toBeNull();
  });

  it('每个请求都带签名与载荷哈希', async () => {
    const { store, fake } = make();
    await store.put('bookmarks.json', utf8.encode('x'));
    const headers = fake.log[0]!.headers;
    expect(headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    // host 参与签名但不能显式发送（浏览器禁止）。
    expect(headers['host']).toBeUndefined();
    expect(headers['authorization']).toContain('host');
  });

  it('DELETE 幂等', async () => {
    const { store } = make();
    await expect(store.remove('nope.json')).resolves.toBeUndefined();
  });

  it('ensureContainer 是空操作，不发请求（对象存储没有目录）', async () => {
    const { store, fake } = make();
    await store.ensureContainer();
    expect(fake.log).toHaveLength(0);
  });
});

describe('s3 — 条件写与降级（FR-17 / FR-18）', () => {
  it('ETag 不匹配时抛 ConflictError', async () => {
    const { store } = make();
    await store.put('bookmarks.json', utf8.encode('v1'));
    await expect(
      store.put('bookmarks.json', utf8.encode('v2'), { ifMatch: '"wrong"' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('忽略 If-Match 的服务被探测为不支持条件写', async () => {
    const { store } = make({}, fakeS3({ ifMatch: false }));
    const caps = await probeStore(store, { now: () => new Date('2026-07-30T10:00:00Z'), compress: true });
    expect(caps.ifMatch).toBe(false);
  });

  it('支持条件写的服务被探测为支持', async () => {
    const { store } = make();
    const caps = await probeStore(store, { now: () => new Date('2026-07-30T10:00:00Z'), compress: true });
    expect(caps.ifMatch).toBe(true);
  });

  it('409 被当作前置条件失败（部分兼容服务如此表达）', async () => {
    const impl = (async () => new Response('conflict', { status: 409 })) as unknown as typeof fetch;
    const store = createS3Store(CONFIG, {
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: impl,
      sleep: async () => undefined,
      now: () => new Date(0),
    });
    await expect(store.put('a.json', utf8.encode('x'), { ifMatch: '"v"' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('s3 — 列举（刷新索引）', () => {
  it('列出前缀下的对象名，去掉前缀与子目录', async () => {
    const { store } = make();
    await store.put('history/v000001-a.json.gz', utf8.encode('x'));
    await store.put('history/v000002-b.json.gz', utf8.encode('y'));
    await store.put('bookmarks.json', utf8.encode('z'));
    expect((await store.list('history')).sort()).toEqual(['v000001-a.json.gz', 'v000002-b.json.gz']);
  });
});

describe('ListObjectsV2 解析', () => {
  it('取出全部 Key', () => {
    const xml = '<ListBucketResult><Contents><Key>a/b.json</Key></Contents><Contents><Key>a/c.json</Key></Contents></ListBucketResult>';
    expect(parseListKeys(xml)).toEqual(['a/b.json', 'a/c.json']);
  });

  it('解码 XML 实体', () => {
    expect(parseListKeys('<Key>a&amp;b.json</Key>')).toEqual(['a&b.json']);
  });

  it('IsTruncated 为 true 时给出续传令牌', () => {
    const xml = '<IsTruncated>true</IsTruncated><NextContinuationToken>abc123</NextContinuationToken>';
    expect(parseNextToken(xml)).toBe('abc123');
  });

  it('未截断时没有令牌', () => {
    expect(parseNextToken('<IsTruncated>false</IsTruncated>')).toBeUndefined();
    expect(parseNextToken('')).toBeUndefined();
  });
});
