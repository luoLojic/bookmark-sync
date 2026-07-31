/**
 * platform/storage.ts —— chrome.storage.local 键空间（方案 3.1）。
 *
 * 键名固定，每个键独立读写，避免大对象整体重写。
 *
 * ★ INV-1：setBaseline() 的唯一合法调用点是 engine/commit.ts。
 * ★ INV-3：clearBaseline() 全局只允许两处调用点 ——
 *          FormatVersionTooNew 处理路径，与用户显式重置。
 */

import { DEFAULT_CONFIG, LOG_CAPACITY } from '../shared/config.js';
import type { LogSink } from '../shared/logger.js';
import type { Snapshot } from '../domain/tree.js';
import type { Config, GuidMap, RemoteCaps, SyncState, LastResult } from '../shared/types.js';

export const K = {
  cfg: 'cfg',
  caps: 'caps',
  baseline: 'baseline',
  /** 基线属于哪个远端（shared/config.ts 的 remoteIdentity）。见 setBaseline。 */
  baselineRemote: 'baselineRemote',
  map: 'map',
  syncState: 'syncState',
  lastResult: 'lastResult',
  log: 'log',
} as const;

/** 可替换的底层，便于测试注入内存实现。 */
export interface KeyValueArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

class ChromeArea implements KeyValueArea {
  get(keys: string[]): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(keys) as Promise<Record<string, unknown>>;
  }
  set(items: Record<string, unknown>): Promise<void> {
    return chrome.storage.local.set(items);
  }
  remove(keys: string[]): Promise<void> {
    return chrome.storage.local.remove(keys);
  }
}

let area: KeyValueArea = typeof chrome !== 'undefined' && chrome.storage ? new ChromeArea() : memoryArea();

/** 测试用：内存键值区。 */
export function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea {
  const m = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (m.has(k)) out[k] = structuredCloneSafe(m.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, structuredCloneSafe(v));
    },
    async remove(keys) {
      for (const k of keys) m.delete(k);
    },
  };
}

function structuredCloneSafe<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function setStorageArea(a: KeyValueArea): void {
  area = a;
}

async function readKey<T>(key: string): Promise<T | undefined> {
  const got = await area.get([key]);
  return got[key] as T | undefined;
}

// ── cfg ──────────────────────────────────────────────────────────────

export async function getConfig(): Promise<Config> {
  const stored = await readKey<Partial<Config>>(K.cfg);
  // 逐字段合并默认值：扩展升级新增设置项时旧配置不至于缺键。
  return {
    ...DEFAULT_CONFIG,
    ...(stored ?? {}),
    webdav: { ...DEFAULT_CONFIG.webdav, ...(stored?.webdav ?? {}) },
    s3: { ...DEFAULT_CONFIG.s3, ...(stored?.s3 ?? {}) },
  };
}

export async function setConfig(cfg: Config): Promise<void> {
  await area.set({ [K.cfg]: cfg });
}

export async function patchConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await getConfig()), ...patch };
  await setConfig(next);
  return next;
}

// ── caps ─────────────────────────────────────────────────────────────

export async function getCaps(): Promise<RemoteCaps | undefined> {
  return readKey<RemoteCaps>(K.caps);
}

export async function setCaps(caps: RemoteCaps): Promise<void> {
  await area.set({ [K.caps]: caps });
}

/**
 * 作废能力探测结果。
 *
 * ★ 必须是删除，不能写一条 ifMatch:false 的「占位」记录：ensureCaps 只按
 * suffix 判断缓存是否可用，占位记录在它眼里是完全有效的缓存，于是条件写永久
 * 停在降级模式，且 ensureContainer（唯一调用点在 probeStore 里）再也不会跑，
 * 换到新的 WebDAV 目录后 MKCOL 不执行，PUT 直接 409。
 */
export async function clearCaps(): Promise<void> {
  await area.remove([K.caps]);
}

// ── baseline（INV-1） ────────────────────────────────────────────────

export async function getBaseline(): Promise<Snapshot | undefined> {
  return readKey<Snapshot>(K.baseline);
}

/**
 * ★ 唯一合法调用点：engine/commit.ts 的 WRITE_BASELINE 终态。
 * 任何其他调用点都是 INV-1 违规，代码评审必查。
 *
 * remoteIdentity 与基线在同一次 set 里落盘（storage.local 的单次 set 是原子的）。
 * 分两次写会留下「基线已是新远端的、指纹还是旧远端的」这种中间态 —— 那比没有
 * 指纹更危险，因为它会让校验放行一个属于别处的基线。
 */
export async function setBaseline(snap: Snapshot, remoteIdentity: string): Promise<void> {
  await area.set({ [K.baseline]: snap, [K.baselineRemote]: remoteIdentity });
}

/** 基线所属远端的指纹。undefined = 记录基线时还没有这个字段（旧版本升级上来）。 */
export async function getBaselineRemote(): Promise<string | undefined> {
  return readKey<string>(K.baselineRemote);
}

/**
 * 补记基线所属的远端。仅用于旧版本升级：那时基线已存在但没有指纹，
 * 只能认定它属于当前配置的远端 —— 别处不该调用。
 */
export async function adoptBaselineRemote(remoteIdentity: string): Promise<void> {
  await area.set({ [K.baselineRemote]: remoteIdentity });
}

/**
 * ★ INV-3：只允许两处调用 —— FormatVersionTooNew 处理路径、用户显式重置。
 * 映射表不受影响（INV-2：只增不减）。
 */
export async function clearBaseline(): Promise<void> {
  await area.remove([K.baseline, K.baselineRemote]);
}

// ── map（INV-2：只增不减） ───────────────────────────────────────────

export async function getMap(): Promise<GuidMap> {
  return (await readKey<GuidMap>(K.map)) ?? {};
}

/** 合并写入。绝不覆盖式删除已有项（INV-2）。 */
export async function mergeMap(entries: GuidMap): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const cur = await getMap();
  await area.set({ [K.map]: { ...cur, ...entries } });
}

/**
 * INV-2 只增不减：故本模块不提供整表替换接口。
 * 首次同步匹配得到的多条映射同样经 mergeMap 一次写入；
 * 唯一的删除入口是用户显式重置走的 clearMap / resetAll。
 */
export async function clearMap(): Promise<void> {
  await area.remove([K.map]);
}

// ── syncState（NFR-8 僵死检测） ──────────────────────────────────────

export async function getSyncState(): Promise<SyncState | undefined> {
  return readKey<SyncState>(K.syncState);
}

export async function setSyncState(s: SyncState): Promise<void> {
  await area.set({ [K.syncState]: s });
}

export async function clearSyncState(): Promise<void> {
  await area.remove([K.syncState]);
}

// ── lastResult ───────────────────────────────────────────────────────

export async function getLastResult(): Promise<LastResult | undefined> {
  return readKey<LastResult>(K.lastResult);
}

export async function setLastResult(r: LastResult): Promise<void> {
  await area.set({ [K.lastResult]: r });
}

// ── log ──────────────────────────────────────────────────────────────

export async function getLogLines(): Promise<string[]> {
  return (await readKey<string[]>(K.log)) ?? [];
}

export const logSink: LogSink = {
  async persist(lines: string[]) {
    await area.set({ [K.log]: lines.slice(-LOG_CAPACITY) });
  },
};

export async function clearLog(): Promise<void> {
  await area.remove([K.log]);
}

// ── 重置（设置页「维护」分组） ────────────────────────────────────────

/** 重置同步状态：清空基线，保留映射与配置（需求 9.3 / INV-3）。 */
export async function resetSyncState(): Promise<void> {
  await clearBaseline();
  await clearSyncState();
}

/** 完全重置：清空基线、映射、配置。 */
export async function resetAll(): Promise<void> {
  await area.remove([K.baseline, K.baselineRemote, K.map, K.syncState, K.cfg, K.caps, K.lastResult]);
}
