/**
 * test/remote/weaknet.test.ts —— 弱网条件下的读写可靠性（NFR-1 / NFR-2 / NFR-4）。
 *
 * 方案 8 的 M3 验收要求「注入 10% 丢包时读写仍成功」。这里把丢包、延迟、
 * 429、5xx、响应体截断逐项注入，走完整链路（webdav → store → http），
 * 并用可播种的随机源保证失败可复现。
 */

import { describe, expect, it } from 'vitest';
import { ProtocolError, ServerError } from '../../src/shared/errors.js';
import { decodeJson, encodeJson } from '../../src/remote/codec.js';
import { createWebdavStore } from '../../src/remote/webdav.js';
import { probeStore } from '../../src/remote/store.js';
import type { WebdavConfig } from '../../src/shared/types.js';
import { FakeRemote, type FakeRemoteOptions } from '../fakes/remote.js';

const CONFIG: WebdavConfig = {
  url: 'https://dav.test/dav',
  username: 'me',
  password: 'pw',
  basePath: '/bookmark-sync/',
};

/** 退避等待折叠为 0，用例才能秒级完成；重试逻辑本身不受影响。 */
function build(options: FakeRemoteOptions) {
  const remote = new FakeRemote(options);
  const store = createWebdavStore(CONFIG, {
    timeoutMs: 1000,
    maxRetries: 5,
    fetchImpl: remote.fetch,
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { remote, store };
}

/** 约 100KB 的真实量级载荷（需求第 3 节）。 */
function payload(): unknown {
  return {
    formatVersion: 1,
    version: 42,
    roots: Array.from({ length: 900 }, (_, i) => ({
      guid: `b-${String(i).padStart(12, '0')}`,
      title: `书签 ${i}`,
      url: `https://example${i}.test/path/${i}`,
    })),
  };
}

describe('10% 丢包（M3 验收）', () => {
  for (const seed of [1, 7, 42, 99, 2026]) {
    it(`seed=${seed} 时写入与读回都成功`, async () => {
      const { store } = build({ lossRate: 0.1, seed });
      const bytes = await encodeJson(payload(), true);

      await store.put('bookmarks.json', bytes);
      const got = await store.get('bookmarks.json');

      expect(got).not.toBeNull();
      expect(await decodeJson(got!.bytes)).toEqual(payload());
    });
  }
});

describe('组合弱网：延迟 + 丢包 + 429 + 5xx', () => {
  for (const seed of [3, 11, 77]) {
    it(`seed=${seed} 时仍能完成一次完整往返`, async () => {
      const { store } = build({
        latencyMs: 1,
        jitterMs: 2,
        lossRate: 0.1,
        throttleRate: 0.05,
        errorRate: 0.05,
        seed,
      });
      const bytes = await encodeJson(payload(), true);
      await store.put('bookmarks.json', bytes);
      expect(await decodeJson((await store.get('bookmarks.json'))!.bytes)).toEqual(payload());
    });
  }

  it('能力探测在弱网下同样得出正确结论', async () => {
    const { store } = build({ lossRate: 0.1, errorRate: 0.05, seed: 5 });
    const caps = await probeStore(store, { now: () => new Date('2026-07-30T00:00:00.000Z'), compress: true });
    expect(caps.ifMatch).toBe(true);
  });
});

describe('故障持续时如实失败（不假装成功）', () => {
  it('丢包率 100% 时用尽重试后抛错', async () => {
    // 「要么完整成功，要么完全不生效」—— 绝不能静默返回空内容。
    const { store } = build({ lossRate: 1, seed: 1 });
    await expect(store.get('bookmarks.json')).rejects.toThrow();
  });

  it('5xx 持续时抛 ServerError（Transient，engine 可重试且不清状态）', async () => {
    const { store } = build({ errorRate: 1, seed: 1 });
    await expect(store.put('bookmarks.json', new Uint8Array([1]))).rejects.toBeInstanceOf(ServerError);
  });

  it('重试次数受 maxRetries 约束，不会无限撞', async () => {
    const remote = new FakeRemote({ errorRate: 1, seed: 1 });
    const store = createWebdavStore(CONFIG, {
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl: remote.fetch,
      sleep: async () => undefined,
    });
    await expect(store.get('bookmarks.json')).rejects.toBeInstanceOf(ServerError);
    expect(remote.countRequests('GET')).toBe(3);
  });
});

describe('响应体截断（NFR-4）', () => {
  it('gzip 被截断时抛 ProtocolError，而不是交出残缺的树', async () => {
    // floccus 为此专门有 FileSizeMismatch 一类错误；这里靠 gzip 自身的
    // 完整性校验兜住，解压失败就是截断。
    const { store } = build({ truncateRate: 1, seed: 1 });
    await store.put('bookmarks.json', await encodeJson(payload(), true));
    const got = await store.get('bookmarks.json');
    await expect(decodeJson(got!.bytes)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('明文 JSON 被截断时同样抛 ProtocolError', async () => {
    const { store } = build({ truncateRate: 1, seed: 2 });
    await store.put('bookmarks.json', await encodeJson(payload(), false));
    const got = await store.get('bookmarks.json');
    await expect(decodeJson(got!.bytes)).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('并发写（多设备指向同一远端）', () => {
  it('两台设备用同一份 ETag 提交时只有一个成功（FR-17）', async () => {
    const remote = new FakeRemote({ seed: 1 });
    const mk = () =>
      createWebdavStore(CONFIG, {
        timeoutMs: 1000,
        maxRetries: 0,
        fetchImpl: remote.fetch,
        sleep: async () => undefined,
      });
    const deviceA = mk();
    const deviceB = mk();

    await deviceA.put('bookmarks.json', new TextEncoder().encode('base'));
    const shared = (await deviceA.get('bookmarks.json'))!.etag!;

    const results = await Promise.allSettled([
      deviceA.put('bookmarks.json', new TextEncoder().encode('from A'), { ifMatch: shared }),
      deviceB.put('bookmarks.json', new TextEncoder().encode('from B'), { ifMatch: shared }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // 落地的内容一定是成功那一方写的，不会是两者的混合。
    const key = remote.paths().find((p) => p.endsWith('bookmarks.json'))!;
    expect(['from A', 'from B']).toContain(new TextDecoder().decode(remote.read(key)!));
  });
});
