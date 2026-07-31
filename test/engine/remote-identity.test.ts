/**
 * test/engine/remote-identity.test.ts —— 基线与远端的绑定（BUG-01）与能力缓存
 * 作废（H-1）的回归测试。
 *
 * 两条缺陷本来是同一处代码的两面：`applyConfigPatch` 检测「远端变了」时既漏了
 * 一半字段（basePath / prefix / region / 寻址方式都不算），又用一条
 * `probedAt: ''` 的哨兵记录表示作废，而读取侧只看 suffix，把哨兵当成有效缓存。
 *
 * 前者的后果是数据丢失：换到一个自己有快照的远端后，旧基线照旧参与三方合并，
 * 「基线有、本地未改、新远端没有」的条目被判成远端删除。后者的后果是永久降级：
 * 条件写不再带 If-Match，同时 ensureContainer（唯一调用点在 probeStore 里）
 * 再也不执行。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, remoteIdentity } from '../../src/shared/config.js';
import { assertBaselineBelongsTo, judgeIdentity } from '../../src/engine/identity.js';
import { isCapsUsable } from '../../src/remote/store.js';
import type { Config, RemoteCaps } from '../../src/shared/types.js';

const webdav = (patch: Partial<Config['webdav']> = {}): Config => ({
  ...DEFAULT_CONFIG,
  remoteKind: 'webdav',
  webdav: { url: 'https://dav.example.com/remote.php/dav', username: 'u', password: 'p', basePath: '/bookmark-sync/', ...patch },
});

const s3 = (patch: Partial<Config['s3']> = {}): Config => ({
  ...DEFAULT_CONFIG,
  remoteKind: 's3',
  s3: {
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    prefix: 'bookmark-sync/',
    forcePathStyle: true,
    ...patch,
  },
});

describe('远端身份指纹只随「数据存放位置」变化（BUG-01）', () => {
  it('同一份配置得到同一个指纹', () => {
    expect(remoteIdentity(webdav())).toBe(remoteIdentity(webdav()));
  });

  it('WebDAV 地址或基础路径变了就是另一个远端', () => {
    const base = remoteIdentity(webdav());
    expect(remoteIdentity(webdav({ url: 'https://other.example.com/dav' }))).not.toBe(base);
    // basePath 先前根本不参与判定 —— 只改它同样会换掉真正被访问的目录。
    expect(remoteIdentity(webdav({ basePath: '/other-folder/' }))).not.toBe(base);
  });

  it('S3 的 bucket、prefix、region、寻址方式任一项变了都是另一个远端', () => {
    const base = remoteIdentity(s3());
    expect(remoteIdentity(s3({ bucket: 'other-bucket' }))).not.toBe(base);
    expect(remoteIdentity(s3({ prefix: 'other-prefix/' }))).not.toBe(base);
    expect(remoteIdentity(s3({ region: 'eu-west-1' }))).not.toBe(base);
    expect(remoteIdentity(s3({ forcePathStyle: false }))).not.toBe(base);
    expect(remoteIdentity(s3({ endpoint: 'https://minio.internal:9000' }))).not.toBe(base);
  });

  it('后端类型换了就是另一个远端', () => {
    expect(remoteIdentity({ ...webdav(), remoteKind: 's3' })).not.toBe(remoteIdentity(webdav()));
  });

  it('改凭据不算换远端 —— 否则每次改密码都要求用户重置同步状态', () => {
    const base = remoteIdentity(webdav());
    expect(remoteIdentity(webdav({ username: 'u2', password: 'p2' }))).toBe(base);
    expect(remoteIdentity(s3({ accessKeyId: 'AKIB', secretAccessKey: 'other' }))).toBe(
      remoteIdentity(s3()),
    );
  });

  it('压缩开关不算换远端（它只决定后缀，双后缀探测能读到另一种）', () => {
    expect(remoteIdentity({ ...webdav(), compress: false })).toBe(
      remoteIdentity({ ...webdav(), compress: true }),
    );
  });

  it('末尾斜杠与等价的 basePath / prefix 写法不算换远端', () => {
    expect(remoteIdentity(webdav({ url: 'https://dav.example.com/remote.php/dav/' }))).toBe(
      remoteIdentity(webdav()),
    );
    // normalizeBasePath 会把 'x' 补成 '/x/'。
    expect(remoteIdentity(webdav({ basePath: 'bookmark-sync' }))).toBe(remoteIdentity(webdav()));
    expect(remoteIdentity(s3({ prefix: '/bookmark-sync' }))).toBe(remoteIdentity(s3()));
    // region 留空时按 us-east-1 处理，与 transport 的默认值一致。
    expect(remoteIdentity(s3({ region: '' }))).toBe(remoteIdentity(s3()));
  });

  it('调度、阈值、设备名这类与位置无关的设置不影响指纹', () => {
    expect(
      remoteIdentity({
        ...webdav(),
        scheduleEnabled: true,
        scheduleMinutes: 5,
        deleteGuardCount: 99,
        timeoutMs: 1,
        maxRetries: 0,
        deviceName: 'Chrome-ff',
      }),
    ).toBe(remoteIdentity(webdav()));
  });
});

describe('三种判定（judgeIdentity）', () => {
  it('没有基线时一律放行 —— 首次同步不需要绑定', () => {
    expect(judgeIdentity({ hasBaseline: false, stored: undefined, current: 'a' })).toEqual({ t: 'ok' });
    expect(judgeIdentity({ hasBaseline: false, stored: 'b', current: 'a' })).toEqual({ t: 'ok' });
  });

  it('指纹一致时放行', () => {
    expect(judgeIdentity({ hasBaseline: true, stored: 'a', current: 'a' })).toEqual({ t: 'ok' });
  });

  it('有基线但没记过指纹时补记（旧版本升级上来）', () => {
    expect(judgeIdentity({ hasBaseline: true, stored: undefined, current: 'a' })).toEqual({ t: 'adopt' });
  });

  it('指纹不一致时判为换了远端', () => {
    expect(judgeIdentity({ hasBaseline: true, stored: 'b', current: 'a' })).toEqual({
      t: 'mismatch',
      stored: 'b',
    });
  });
});

describe('双向同步前的校验（assertBaselineBelongsTo）', () => {
  const deps = (opts: { hasBaseline: boolean; stored?: string }) => {
    const adopted: string[] = [];
    return {
      adopted,
      deps: {
        hasBaseline: async (): Promise<boolean> => opts.hasBaseline,
        getStored: async (): Promise<string | undefined> => opts.stored,
        adopt: async (v: string): Promise<void> => {
          adopted.push(v);
        },
      },
    };
  };

  it('基线属于另一个远端时抛 RemoteChanged，且不补记指纹', async () => {
    const { adopted, deps: d } = deps({ hasBaseline: true, stored: remoteIdentity(webdav()) });
    await expect(
      assertBaselineBelongsTo(remoteIdentity(webdav({ basePath: '/other/' })), d),
    ).rejects.toMatchObject({ code: 'remoteChanged', klass: 'fatal' });
    // 中止路径不该改任何持久状态（INV-3）。
    expect(adopted).toEqual([]);
  });

  it('指纹一致时通过，不写 storage', async () => {
    const id = remoteIdentity(s3());
    const { adopted, deps: d } = deps({ hasBaseline: true, stored: id });
    await expect(assertBaselineBelongsTo(id, d)).resolves.toBeUndefined();
    expect(adopted).toEqual([]);
  });

  it('旧基线没有指纹时补记为当前远端并放行', async () => {
    const id = remoteIdentity(s3());
    const { adopted, deps: d } = deps({ hasBaseline: true });
    await expect(assertBaselineBelongsTo(id, d)).resolves.toBeUndefined();
    expect(adopted).toEqual([id]);
  });

  it('没有基线时不补记也不拦 —— 指纹随第一次提交落盘', async () => {
    const { adopted, deps: d } = deps({ hasBaseline: false, stored: 'stale' });
    await expect(assertBaselineBelongsTo(remoteIdentity(s3()), d)).resolves.toBeUndefined();
    expect(adopted).toEqual([]);
  });
});

describe('能力缓存的有效性判定（H-1）', () => {
  const caps = (patch: Partial<RemoteCaps> = {}): RemoteCaps => ({
    ifMatch: true,
    suffix: '.json.gz',
    probedAt: '2026-07-30T10:00:00.000Z',
    ...patch,
  });

  it('没有缓存时要探测', () => {
    expect(isCapsUsable(undefined, true)).toBe(false);
  });

  it('后缀与压缩开关一致时可用', () => {
    expect(isCapsUsable(caps(), true)).toBe(true);
    expect(isCapsUsable(caps({ suffix: '.json' }), false)).toBe(true);
  });

  it('后缀与压缩开关不一致时要重新探测', () => {
    expect(isCapsUsable(caps(), false)).toBe(false);
    expect(isCapsUsable(caps({ suffix: '.json' }), true)).toBe(false);
  });

  it('★ probedAt 为空的哨兵记录不算缓存 —— 否则永久停在降级模式', () => {
    // 这正是 H-1：旧版本作废缓存时写的就是这条记录，而判定只看 suffix，
    // 于是 ifMatch 永远是 false，且 probeStore 再也不跑、ensureContainer
    // 再也不执行。
    expect(isCapsUsable(caps({ ifMatch: false, probedAt: '' }), true)).toBe(false);
  });
});
