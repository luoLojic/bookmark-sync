import { beforeEach, describe, expect, it } from 'vitest';
import { emptySnapshot } from '../../src/domain/tree.js';
import {
  getBaseline,
  getConfig,
  getMap,
  memoryArea,
  mergeMap,
  resetAll,
  resetSyncState,
  setBaseline,
  setConfig,
  setStorageArea,
  setSyncState,
} from '../../src/platform/storage.js';

describe('storage schema', () => {
  beforeEach(() => setStorageArea(memoryArea()));

  it('deeply merges default configuration on read', async () => {
    setStorageArea(memoryArea({ cfg: { webdav: { url: 'https://dav.test' } } }));
    const cfg = await getConfig();
    expect(cfg.webdav.url).toBe('https://dav.test');
    expect(cfg.webdav.basePath).toBe('/bookmark-sync/');
    expect(cfg.scheduleMinutes).toBe(30);
  });

  // INV-2：映射只增不减，重复写入既不丢旧项也不重复计数。
  it('accumulates mappings and never drops earlier entries', async () => {
    await mergeMap({ '1': 'b-one' });
    await mergeMap({ '2': 'b-two' });
    await mergeMap({ '2': 'b-two' });
    expect(await getMap()).toEqual({ '1': 'b-one', '2': 'b-two' });
  });

  it('ignores empty mapping writes', async () => {
    await mergeMap({ '1': 'b-one' });
    await mergeMap({});
    expect(await getMap()).toEqual({ '1': 'b-one' });
  });

  it('reset sync state clears baseline but preserves mappings and config', async () => {
    const cfg = await getConfig();
    await setConfig({ ...cfg, deviceName: 'Chrome-test' });
    await mergeMap({ '1': 'b-one' });
    await setBaseline(emptySnapshot(), 'remote-a');
    await setSyncState({
      running: true,
      startedAt: 1,
      phase: 'read',
      done: 0,
      total: 1,
      runId: 'run',
      kind: 'sync',
    });
    await resetSyncState();
    expect(await getBaseline()).toBeUndefined();
    expect(await getMap()).toEqual({ '1': 'b-one' });
    expect((await getConfig()).deviceName).toBe('Chrome-test');
  });

  it('complete reset clears local state and restores config defaults', async () => {
    await mergeMap({ '1': 'b-one' });
    await setBaseline(emptySnapshot(), 'remote-a');
    await resetAll();
    expect(await getMap()).toEqual({});
    expect(await getBaseline()).toBeUndefined();
    expect((await getConfig()).remoteKind).toBe('webdav');
  });
});

describe('mergeMap 的并发写入（审计 M-8）', () => {
  beforeEach(() => setStorageArea(memoryArea()));

  it('★ 两处并发合并不丢映射', async () => {
    // 「读 → 合并 → 写」中间的两个 await 都是可打断点：并发调用会双双读到同一份
    // 旧数据，后写的那次把先写的那批整个丢掉。丢一条映射的后果是下次读树给同一个
    // 书签分配新 GUID，于是它在远端表现为「旧的被删、新的被加」，远端多一份重复。
    await Promise.all([
      mergeMap({ '1': 'b-000000000001' }),
      mergeMap({ '2': 'b-000000000002' }),
      mergeMap({ '3': 'b-000000000003' }),
    ]);
    expect(await getMap()).toEqual({
      '1': 'b-000000000001',
      '2': 'b-000000000002',
      '3': 'b-000000000003',
    });
  });

  it('慢存储下同样不丢 —— 放大交错窗口', async () => {
    // 每次读写都在微任务队列里多绕几圈，把窗口放到必然命中。
    const store = new Map<string, unknown>();
    const hop = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    setStorageArea({
      async get(keys) {
        await hop();
        const out: Record<string, unknown> = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(items) {
        await hop();
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
      async remove(keys) {
        await hop();
        for (const k of keys) store.delete(k);
      },
    });

    const writes = Array.from({ length: 20 }, (_, i) =>
      mergeMap({ [String(i)]: `b-${String(i).padStart(12, '0')}` }),
    );
    await Promise.all(writes);
    expect(Object.keys(await getMap())).toHaveLength(20);
  });

  it('某次写入失败不会让后续写入全部拒绝', async () => {
    let failNext = true;
    setStorageArea({
      async get() {
        return {};
      },
      async set() {
        if (failNext) {
          failNext = false;
          throw new Error('quota exceeded');
        }
      },
      async remove() {
        return undefined;
      },
    });

    await expect(mergeMap({ a: 'b-00000000000a' })).rejects.toThrow(/quota/);
    await expect(mergeMap({ b: 'b-00000000000b' })).resolves.toBeUndefined();
  });
});
