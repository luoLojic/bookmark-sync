/**
 * background.ts —— MV3 service worker：消息路由与依赖装配。
 *
 * 这一层只做三件事：把 storage 里的配置装配成引擎依赖、路由 UI 消息、
 * 广播进度。所有同步语义都在 engine/ 里，这里不做任何判断 ——
 * 一旦在这里加「如果……就跳过某步」，方案 1.2 的分层就破了。
 */

import { STALE_SYNC_MS, remoteIdentity, validateConfig } from './shared/config.js';
import { AbortedError, MisconfiguredError, serializeError, toAppError } from './shared/errors.js';
import { log } from './shared/logger.js';
import { countRoots } from './domain/tree.js';
import { contentHasher, randomHex, randomSource } from './platform/crypto.js';
import { makeGuidFactory } from './domain/guid.js';
import { MappingTable, chromeBookmarks, readLocalTree } from './platform/bookmarks.js';
import { withKeepalive } from './platform/keepalive.js';
import { createWebdavStore } from './remote/webdav.js';
import { createS3Store } from './remote/s3.js';
import { isCapsUsable, probeStore, type RemoteStore } from './remote/store.js';
import { decodeJson, decodeSnapshot, encodeJson, parseHistoryIndex } from './remote/codec.js';
import { EMPTY_INDEX, estimateIndexBytes, rebuildIndexFromNames } from './remote/history.js';
import { REMOTE_FILES } from './shared/config.js';
import { acquireLock, clearStaleLock } from './engine/lock.js';
import { createCancellationGate, type CancellationGate } from './engine/cancellation.js';
import { assertBaselineBelongsTo } from './engine/identity.js';
import { previewOverwrite, runSync, type SyncRequest } from './engine/sync.js';
import { applySchedule, chromeAlarms, SYNC_ALARM } from './scheduler/alarms.js';
import {
  adoptBaselineRemote,
  clearCaps,
  clearSyncState,
  getBaseline,
  getBaselineRemote,
  getCaps,
  getConfig,
  getLastResult,
  getLogLines,
  getMap,
  getSyncState,
  logSink,
  setSyncState,
  mergeMap,
  patchConfig,
  resetAll,
  resetSyncState,
  setBaseline,
  setCaps,
  setConfig,
  setLastResult,
} from './platform/storage.js';
import { broadcast } from './ui/messages.js';
import type { Config, RemoteCaps, SyncKind } from './shared/types.js';
import type { ConfirmDetail, Request, Response, StatusPayload } from './ui/messages.js';

log.setSink(logSink);
void getLogLines().then((lines) => log.hydrate(lines));

// ── 设备名（需求 9.3 / 方案 9.2） ────────────────────────────────────

function generatedDeviceName(): string {
  const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
  return `${browser}-${randomHex(2)}`;
}

async function configWithDeviceName(): Promise<Config> {
  const cfg = await getConfig();
  if (cfg.deviceName.trim() !== '') return cfg;
  return patchConfig({ deviceName: generatedDeviceName() });
}

// ── 远端装配 ─────────────────────────────────────────────────────────

function buildStore(config: Config, signal?: AbortSignal): RemoteStore {
  const deps = {
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    ...(signal === undefined ? {} : { signal }),
    onRetry: (info: { attempt: number; delayMs: number; reason: string }) => {
      log.warn(`第 ${info.attempt} 次重试，等待 ${info.delayMs}ms：${info.reason}`);
    },
  };
  return config.remoteKind === 's3' ? createS3Store(config.s3, deps) : createWebdavStore(config.webdav, deps);
}

async function requireConfigured(): Promise<Config> {
  const config = await configWithDeviceName();
  const missing = validateConfig(config);
  if (missing.length > 0) {
    throw new MisconfiguredError(`远端未配置：${missing.join(', ')}`, { messageKey: 'errNotConfigured' });
  }
  return config;
}

/** 没探测过就先探测一次，结果缓存（方案 3.1 的 caps 键）。 */
async function ensureCaps(config: Config, store: RemoteStore): Promise<RemoteCaps> {
  const cached = await getCaps();
  if (isCapsUsable(cached, config.compress)) return cached;

  const caps = await probeStore(store, { now: () => new Date(), compress: config.compress });
  await setCaps(caps);
  log.info(`能力探测：条件写 ${caps.ifMatch ? '支持' : '不支持（已降级）'}`);
  return caps;
}

async function loadMapping(): Promise<MappingTable> {
  return new MappingTable(await getMap(), mergeMap);
}

// ── 状态 ─────────────────────────────────────────────────────────────

async function status(): Promise<StatusPayload> {
  const [config, storedState, last, baseline, caps] = await Promise.all([
    configWithDeviceName(),
    getSyncState(),
    getLastResult(),
    getBaseline(),
    getCaps(),
  ]);

  let state = storedState ?? null;
  if (state?.running === true && Date.now() - state.startedAt > STALE_SYNC_MS) {
    // NFR-8：worker 被杀后留下的标记。只清标记（INV-3）。
    await clearSyncState();
    state = null;
    log.warn('清除了僵死的同步标记');
  }

  let localCounts: StatusPayload['localCounts'] = null;
  try {
    const read = await readLocalTree(chromeBookmarks, await loadMapping(), makeGuidFactory(randomSource()));
    localCounts = countRoots(read.roots);
  } catch (error) {
    log.warn('读取本地书签数失败', error);
  }

  return {
    configured: validateConfig(config).length === 0,
    state,
    last: last ?? null,
    localCounts,
    // 云端计数取自基线，避免每次打开 popup 都发一次网络请求。
    // 基线就是「上次同步成功时的远端内容」，对展示足够准确。
    remoteCounts: baseline === undefined ? null : countRoots(baseline.roots),
    caps: caps ?? null,
    hasBaseline: baseline !== undefined,
    deviceName: config.deviceName,
  };
}

// ── 同步执行 ─────────────────────────────────────────────────────────

/** 当前运行的取消闸门。popup 的取消按钮通过它生效（★ 之后自动失效）。 */
let currentAbort: CancellationGate | null = null;

async function executeSync(req: SyncRequest): Promise<Response> {
  const config = await requireConfigured();
  const runId = randomHex(4);
  const gate = createCancellationGate();

  const handle = await acquireLock(req.kind, runId, {
    store: { getSyncState, setSyncState: (s) => import('./platform/storage.js').then((m) => m.setSyncState(s)), clearSyncState },
    now: () => Date.now(),
    onStale: (stale) => log.warn(`清除僵死标记 runId=${stale.runId} phase=${stale.phase}`),
  });
  currentAbort = gate;
  log.setContext({ runId, phase: 'read' });

  try {
    // ★ 基线必须属于当前远端，否则三方合并会凭空产生删除（审计 BUG-01）。
    // 只拦双向同步：上传与下载的目标树不取自基线，它们既安全、又是用户把基线
    // 重新绑定到新远端的出路。放在任何网络请求之前，失败得快一点。
    const identity = remoteIdentity(config);
    if (req.kind === 'sync') {
      await assertBaselineBelongsTo(identity, {
        hasBaseline: async () => (await getBaseline()) !== undefined,
        getStored: getBaselineRemote,
        adopt: adoptBaselineRemote,
        log: { warn: (m, ...a) => log.warn(m, ...a) },
      });
    }

    // ★ 之后 gate.seal() 会切断这个信号，见 engine/cancellation.ts。
    const store = buildStore(config, gate.httpSignal);
    const caps = await ensureCaps(config, store);
    const mapping = await loadMapping();

    const outcome = await withKeepalive(() =>
      runSync(req, {
        store,
        bookmarks: chromeBookmarks,
        mapping,
        caps,
        config,
        now: () => new Date(),
        nonce: () => randomHex(16),
        hash: contentHasher,
        newGuid: makeGuidFactory(randomSource()),
        loadBaseline: async () => await getBaseline(),
        // ★ INV-1：这是全项目唯一把基线交给 storage 的地方，
        // 由 engine/commit.ts 在远端提交成功后调用。基线与远端指纹一起落盘，
        // 上传/下载因此能把绑定改到新远端。
        saveBaseline: (snap) => setBaseline(snap, identity),
        signal: gate.userSignal,
        sealCancellation: () => gate.seal(),
        log: { info: (m, ...a) => log.info(m, ...a), warn: (m, ...a) => log.warn(m, ...a) },
        onPhase: (phase, done, total) => {
          log.setContext({ phase });
          void handle.update(phase, done, total);
          broadcast({ t: 'progress', phase, done, total, kind: req.kind });
        },
      }),
    );

    await setLastResult({ at: Date.now(), ok: true, kind: req.kind, counts: outcome.result });
    broadcast({ t: 'done', result: outcome.result, kind: req.kind });
    log.info(`同步完成，轮次 ${outcome.rounds}，${outcome.uploaded ? '已写远端' : '远端无变化'}`);
    return { ok: true, t: 'done', result: outcome.result };
  } catch (error) {
    return await handleSyncError(error, req.kind);
  } finally {
    currentAbort = null;
    log.clearContext();
    await handle.release();
    await log.flush();
  }
}

/**
 * 把引擎抛出的错误翻译成 UI 应答。
 *
 * 需要确认的两类（删除保护、首次同步）不是失败，而是「等用户决定」，
 * 因此走 confirm 通道且**不写 lastResult** —— 否则 popup 会显示成上次同步失败。
 */
async function handleSyncError(error: unknown, kind: SyncKind): Promise<Response> {
  const appError = toAppError(error);

  if (appError.code === 'deleteGuard') {
    const detail = (appError as unknown as { detail: ConfirmDetail & Record<string, unknown> }).detail;
    return {
      ok: true,
      t: 'confirm',
      detail: {
        kind: 'deleteGuard',
        localCounts: { bookmarks: 0, folders: 0 },
        remoteCounts: { bookmarks: 0, folders: 0 },
        losing: Number(detail['localDeletes'] ?? 0) + Number(detail['remoteDeletes'] ?? 0),
        items: (detail.items ?? []) as ConfirmDetail['items'],
        itemsTruncated: Number(detail['itemsTruncated'] ?? 0),
        side: (detail['side'] as 'local' | 'remote' | 'both' | undefined) ?? 'both',
        totals: {
          local: Number(detail['localTotal'] ?? 0),
          remote: Number(detail['remoteTotal'] ?? 0),
        },
      },
    };
  }

  if (appError.code === 'firstSyncChoice') {
    const d = (appError as unknown as { detail: Record<string, number> }).detail;
    return {
      ok: true,
      t: 'confirm',
      detail: {
        kind: 'firstSync',
        localCounts: { bookmarks: d['localBookmarks'] ?? 0, folders: d['localFolders'] ?? 0 },
        remoteCounts: { bookmarks: d['remoteBookmarks'] ?? 0, folders: d['remoteFolders'] ?? 0 },
        losing: 0,
        items: [],
        itemsTruncated: 0,
        merged: { bookmarks: d['mergedBookmarks'] ?? 0, folders: d['mergedFolders'] ?? 0 },
      },
    };
  }

  const serialized = serializeError(appError);
  // 用户主动取消不算失败，不污染「上次同步」状态。
  if (!(appError instanceof AbortedError)) {
    await setLastResult({ at: Date.now(), ok: false, kind, error: serialized.messageKey ?? serialized.message });
  }
  log.error(`同步失败：${serialized.message}`);
  broadcast({ t: 'error', error: serialized });
  return { ok: false, error: serialized };
}

// ── 预览（FR-2 / FR-3） ──────────────────────────────────────────────

/** 读远端快照（双后缀探测），供预览与历史使用。 */
async function readRemoteRoots(store: RemoteStore, caps: RemoteCaps) {
  const names = caps.suffix === '.json.gz'
    ? [`${REMOTE_FILES.bookmarks}.gz`, REMOTE_FILES.bookmarks]
    : [REMOTE_FILES.bookmarks, `${REMOTE_FILES.bookmarks}.gz`];
  for (const name of names) {
    const got = await store.get(name);
    if (got !== null) return (await decodeSnapshot(got.bytes)).roots;
  }
  return null;
}

async function preview(op: 'upload' | 'download' | 'sync'): Promise<Response> {
  const config = await requireConfigured();
  const store = buildStore(config);
  const caps = await ensureCaps(config, store);

  const localRead = await readLocalTree(chromeBookmarks, await loadMapping(), makeGuidFactory(randomSource()));
  const remoteRoots = await readRemoteRoots(store, caps);

  if (op === 'sync') {
    // 同步没有「覆盖」语义，预览只报两侧计数。
    return {
      ok: true,
      t: 'confirm',
      detail: {
        kind: 'upload',
        localCounts: countRoots(localRead.roots),
        remoteCounts: remoteRoots === null ? { bookmarks: 0, folders: 0 } : countRoots(remoteRoots),
        losing: 0,
        items: [],
        itemsTruncated: 0,
      },
    };
  }

  const result = previewOverwrite(op, {
    local: localRead.roots,
    remote: remoteRoots ?? { bar: { guid: 'root-bar', type: 'folder', title: '', children: [] }, other: { guid: 'root-other', type: 'folder', title: '', children: [] } },
  });

  return {
    ok: true,
    t: 'confirm',
    detail: {
      kind: op,
      localCounts: result.localCounts,
      remoteCounts: result.remoteCounts,
      losing: result.losing,
      items: result.items,
      itemsTruncated: result.itemsTruncated,
    },
  };
}

// ── 测试连接（需求 9.3） ─────────────────────────────────────────────

async function testConnection(): Promise<Response> {
  const config = await requireConfigured();
  const store = buildStore(config);
  const caps = await probeStore(store, { now: () => new Date(), compress: config.compress });
  await setCaps(caps);
  log.info(`测试连接成功，条件写 ${caps.ifMatch ? '支持' : '不支持'}`);
  return { ok: true, t: 'caps', caps };
}

// ── 历史版本（FR-15 / FR-16） ────────────────────────────────────────

/** 单份历史快照的估算大小，用于设置页展示占用（需求 13）。 */
const SNAPSHOT_BYTES_ESTIMATE = 8 * 1024;

async function loadHistoryIndex(store: RemoteStore) {
  const got = await store.get(REMOTE_FILES.historyIndex);
  if (got === null) return EMPTY_INDEX;
  return parseHistoryIndex(await decodeJson(got.bytes));
}

async function getHistory(): Promise<Response> {
  const config = await requireConfigured();
  const store = buildStore(config);
  const index = await loadHistoryIndex(store);
  return {
    ok: true,
    t: 'history',
    entries: index.entries,
    totalBytesEstimate: estimateIndexBytes(index, SNAPSHOT_BYTES_ESTIMATE),
  };
}

/** 用目录列举重建索引（FR-15 的「刷新索引」）。 */
async function refreshHistoryIndex(): Promise<Response> {
  const config = await requireConfigured();
  const store = buildStore(config);
  const names = await store.list(REMOTE_FILES.historyDir.replace(/\/$/, ''));
  const rebuilt = rebuildIndexFromNames(names);
  await store.put(REMOTE_FILES.historyIndex, await encodeJson(rebuilt, false));
  log.info(`索引已重建，共 ${rebuilt.entries.length} 项`);
  return { ok: true, t: 'void' };
}

/** 下载单份历史快照为文本（FR-16：只查看与下载，不做回滚）。 */
async function downloadHistory(file: string): Promise<Response> {
  const config = await requireConfigured();
  const store = buildStore(config);
  const got = await store.get(file);
  if (got === null) throw new MisconfiguredError(`历史文件不存在：${file}`);
  // 解压后给出明文，用户拿到的是可读的 JSON。
  const value = await decodeJson(got.bytes);
  const name = (file.split('/').pop() ?? 'snapshot.json').replace(/\.gz$/, '');
  return { ok: true, t: 'text', text: JSON.stringify(value, null, 2), filename: name };
}

// ── 配置与维护 ───────────────────────────────────────────────────────

async function applyConfigPatch(patch: Partial<Config>): Promise<Config> {
  const current = await configWithDeviceName();
  const next: Config = {
    ...current,
    ...patch,
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
    s3: { ...current.s3, ...(patch.s3 ?? {}) },
  };
  await setConfig(next);

  // 远端地址或压缩开关变了，之前探测的能力可能不再适用。
  //
  // 用指纹比较而不是逐字段列举：先前只比了 remoteKind / webdav.url /
  // s3.endpoint / s3.bucket / compress 五项，basePath、prefix、region、
  // 寻址方式改了都不作废，而这几项同样会换掉真正被访问的位置。
  const remoteChanged =
    remoteIdentity(next) !== remoteIdentity(current) || next.compress !== current.compress;
  if (remoteChanged) {
    // ★ 必须删除而不是写一条 ifMatch:false 的占位记录，理由见 clearCaps。
    await clearCaps();
    log.info('远端配置已变更，能力探测结果作废');
  }

  await applySchedule(next, chromeAlarms);
  return next;
}

// ── 消息路由 ─────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  try {
    switch (req.t) {
      case 'getStatus':
        return { ok: true, t: 'status', payload: await status() };

      case 'sync': {
        const request: SyncRequest = { kind: 'sync' };
        if (req.skipDeleteGuard === true) request.skipDeleteGuard = true;
        if (req.firstSyncChoice !== undefined) request.firstSyncChoice = req.firstSyncChoice;
        return await executeSync(request);
      }

      case 'upload':
        return await executeSync({ kind: 'upload' });

      case 'download':
        return await executeSync({ kind: 'download' });

      case 'preview':
        return await preview(req.op);

      case 'cancel':
        // ★ 之后引擎会忽略取消，这里只负责发出信号（方案 4 要点 4）。
        currentAbort?.cancel();
        log.info('用户请求取消');
        return { ok: true, t: 'void' };

      case 'testConnection':
        return await testConnection();

      case 'getConfig':
        return { ok: true, t: 'config', config: await configWithDeviceName() };

      case 'setConfig':
        await applyConfigPatch(req.patch);
        return { ok: true, t: 'void' };

      case 'getHistory':
        return await getHistory();

      case 'refreshHistoryIndex':
        return await refreshHistoryIndex();

      case 'downloadHistory':
        return await downloadHistory(req.file);

      case 'exportLog':
        await log.flush();
        return { ok: true, t: 'text', text: (await getLogLines()).join('\n'), filename: 'bookmark-sync.log' };

      case 'resetSyncState':
        // 清基线，保留映射与配置（需求 9.3 / INV-3）。
        await resetSyncState();
        log.warn('用户重置了同步状态（基线已清空，映射保留）');
        return { ok: true, t: 'void' };

      case 'resetAll':
        await resetAll();
        log.warn('用户执行了完全重置');
        return { ok: true, t: 'void' };
    }
  } catch (error) {
    const serialized = serializeError(toAppError(error));
    log.error(`请求 ${req.t} 失败：${serialized.message}`);
    await log.flush();
    return { ok: false, error: serialized };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('t' in message)) return false;
  void handleRequest(message as Request).then(sendResponse);
  // 返回 true 保持消息通道开启，异步应答才能送达。
  return true;
});

// ── 定时与启动（FR-7 / FR-8） ────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  log.info('定时同步触发');
  // 与手动同步竞争时由单实例锁拒绝（NFR-10），这里不做额外判断。
  void executeSync({ kind: 'sync' });
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    // worker 重启后先清掉上次留下的僵死标记（NFR-8）。
    await clearStaleLock({
      store: { getSyncState, setSyncState, clearSyncState },
      now: () => Date.now(),
      onStale: (s) => log.warn(`启动时清除僵死标记 runId=${s.runId}`),
    });

    const config = await configWithDeviceName();
    await applySchedule(config, chromeAlarms);
    if (config.syncOnStartup && validateConfig(config).length === 0) {
      log.info('启动同步触发');
      await executeSync({ kind: 'sync' });
    }
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const config = await configWithDeviceName();
    await applySchedule(config, chromeAlarms);
  })();
});
