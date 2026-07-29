/**
 * MV3 service worker 入口。
 *
 * M0 只提供配置、状态、日志与重置的消息编排。同步相关请求在对应里程碑
 * 实现前明确返回不可用，避免界面误报成功。
 */

import { STALE_SYNC_MS, normalizeBasePath, normalizePrefix, validateConfig } from './shared/config.js';
import { MisconfiguredError, serializeError } from './shared/errors.js';
import { log } from './shared/logger.js';
import {
  clearSyncState,
  getBaseline,
  getCaps,
  getConfig,
  getLastResult,
  getLogLines,
  getSyncState,
  logSink,
  patchConfig,
  resetAll,
  resetSyncState,
  setConfig,
} from './platform/storage.js';
import type { Config } from './shared/types.js';
import type { Request, Response, StatusPayload } from './ui/messages.js';

log.setSink(logSink);
void getLogLines().then((lines) => log.hydrate(lines));

function generatedDeviceName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const suffix = [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
  const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
  return `${browser}-${suffix}`;
}

async function configWithDeviceName(): Promise<Config> {
  const cfg = await getConfig();
  if (cfg.deviceName.trim() !== '') return cfg;
  return patchConfig({ deviceName: generatedDeviceName() });
}

async function status(): Promise<StatusPayload> {
  const [cfg, storedState, last, baseline, caps] = await Promise.all([
    configWithDeviceName(),
    getSyncState(),
    getLastResult(),
    getBaseline(),
    getCaps(),
  ]);

  let state = storedState ?? null;
  if (state?.running && Date.now() - state.startedAt > STALE_SYNC_MS) {
    await clearSyncState();
    state = null;
    log.warn('cleared stale sync marker');
  }

  return {
    configured: validateConfig(cfg).length === 0,
    state,
    last: last ?? null,
    // M2 之前不读书签树，M3 之前不读远端，两者一律为 null。
    localCounts: null,
    remoteCounts: null,
    caps: caps ?? null,
    hasBaseline: baseline !== undefined,
    deviceName: cfg.deviceName,
  };
}

async function applyConfigPatch(patch: Partial<Config>): Promise<Config> {
  const current = await configWithDeviceName();
  const next: Config = {
    ...current,
    ...patch,
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
    s3: { ...current.s3, ...(patch.s3 ?? {}) },
  };
  next.webdav.basePath = normalizeBasePath(next.webdav.basePath);
  next.s3.prefix = normalizePrefix(next.s3.prefix);
  await setConfig(next);
  return next;
}

function notReady(): Response {
  return {
    ok: false,
    error: new MisconfiguredError('feature is not implemented in the current milestone', {
      messageKey: 'errNotReady',
    }).serialize(),
  };
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    switch (req.t) {
      case 'getStatus':
        return { ok: true, t: 'status', payload: await status() };
      case 'getConfig':
        return { ok: true, t: 'config', config: await configWithDeviceName() };
      case 'setConfig':
        await applyConfigPatch(req.patch);
        return { ok: true, t: 'void' };
      case 'exportLog':
        return { ok: true, t: 'text', text: (await getLogLines()).join('\n'), filename: 'bookmark-sync.log' };
      case 'resetSyncState':
        await resetSyncState();
        return { ok: true, t: 'void' };
      case 'resetAll':
        await resetAll();
        return { ok: true, t: 'void' };
      case 'sync':
      case 'upload':
      case 'download':
      case 'preview':
      case 'cancel':
      case 'testConnection':
      case 'getHistory':
      case 'refreshHistoryIndex':
      case 'downloadHistory':
        return notReady();
    }
  } catch (error) {
    log.error('request failed', error);
    return { ok: false, error: serializeError(error) };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('t' in message)) return false;
  void handleRequest(message as Request).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void configWithDeviceName();
});
