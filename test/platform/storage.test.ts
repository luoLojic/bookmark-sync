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
    await setBaseline(emptySnapshot());
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
    await setBaseline(emptySnapshot());
    await resetAll();
    expect(await getMap()).toEqual({});
    expect(await getBaseline()).toBeUndefined();
    expect((await getConfig()).remoteKind).toBe('webdav');
  });
});
