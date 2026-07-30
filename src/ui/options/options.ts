/**
 * ui/options/options.ts —— 设置页（需求 9.3）。
 *
 * 只做渲染与消息收发。所有远端访问、重置动作都由后台执行。
 */

import { localizeDom, t } from '../i18n.js';
import { sendRequest } from '../messages.js';
import { chromePermissions, ensureOrigin } from '../../platform/permissions.js';
import type { Config, HistoryEntry, RemoteKind } from '../../shared/types.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const f = {
  remoteKind: $<HTMLSelectElement>('remoteKind'),
  paneWebdav: $<HTMLDivElement>('pane-webdav'),
  paneS3: $<HTMLDivElement>('pane-s3'),
  webdavUrl: $<HTMLInputElement>('webdavUrl'),
  webdavUser: $<HTMLInputElement>('webdavUser'),
  webdavPass: $<HTMLInputElement>('webdavPass'),
  webdavBase: $<HTMLInputElement>('webdavBase'),
  s3Endpoint: $<HTMLInputElement>('s3Endpoint'),
  s3Region: $<HTMLInputElement>('s3Region'),
  s3Bucket: $<HTMLInputElement>('s3Bucket'),
  s3Key: $<HTMLInputElement>('s3Key'),
  s3Secret: $<HTMLInputElement>('s3Secret'),
  s3Prefix: $<HTMLInputElement>('s3Prefix'),
  s3PathStyle: $<HTMLInputElement>('s3PathStyle'),
  scheduleEnabled: $<HTMLInputElement>('scheduleEnabled'),
  scheduleMinutes: $<HTMLInputElement>('scheduleMinutes'),
  syncOnStartup: $<HTMLInputElement>('syncOnStartup'),
  guardCount: $<HTMLInputElement>('guardCount'),
  guardRatio: $<HTMLInputElement>('guardRatio'),
  timeoutSec: $<HTMLInputElement>('timeoutSec'),
  maxRetries: $<HTMLInputElement>('maxRetries'),
  compress: $<HTMLInputElement>('compress'),
  deviceName: $<HTMLInputElement>('deviceName'),
};

const ui = {
  test: $<HTMLButtonElement>('btn-test'),
  testResult: $<HTMLSpanElement>('test-result'),
  historyRefresh: $<HTMLButtonElement>('btn-history-refresh'),
  historyReload: $<HTMLButtonElement>('btn-history-reload'),
  historySummary: $<HTMLSpanElement>('history-summary'),
  historyBody: $<HTMLTableSectionElement>('history-body'),
  exportLog: $<HTMLButtonElement>('btn-export-log'),
  resetSync: $<HTMLButtonElement>('btn-reset-sync'),
  resetAll: $<HTMLButtonElement>('btn-reset-all'),
  saveState: $<HTMLSpanElement>('save-state'),
  degraded: $<HTMLParagraphElement>('degraded-warning'),
  confirm: $<HTMLDivElement>('confirm'),
  confirmTitle: $<HTMLHeadingElement>('confirm-title'),
  confirmBody: $<HTMLParagraphElement>('confirm-body'),
  confirmOk: $<HTMLButtonElement>('confirm-ok'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'),
};

function showPane(kind: RemoteKind): void {
  f.paneWebdav.hidden = kind !== 'webdav';
  f.paneS3.hidden = kind !== 's3';
}

function fill(cfg: Config): void {
  f.remoteKind.value = cfg.remoteKind;
  showPane(cfg.remoteKind);
  f.webdavUrl.value = cfg.webdav.url;
  f.webdavUser.value = cfg.webdav.username;
  f.webdavPass.value = cfg.webdav.password;
  f.webdavBase.value = cfg.webdav.basePath;
  f.s3Endpoint.value = cfg.s3.endpoint;
  f.s3Region.value = cfg.s3.region;
  f.s3Bucket.value = cfg.s3.bucket;
  f.s3Key.value = cfg.s3.accessKeyId;
  f.s3Secret.value = cfg.s3.secretAccessKey;
  f.s3Prefix.value = cfg.s3.prefix;
  f.s3PathStyle.checked = cfg.s3.forcePathStyle;
  f.scheduleEnabled.checked = cfg.scheduleEnabled;
  f.scheduleMinutes.value = String(cfg.scheduleMinutes);
  f.syncOnStartup.checked = cfg.syncOnStartup;
  f.guardCount.value = String(cfg.deleteGuardCount);
  f.guardRatio.value = String(Math.round(cfg.deleteGuardRatio * 100));
  f.timeoutSec.value = String(Math.round(cfg.timeoutMs / 1000));
  f.maxRetries.value = String(cfg.maxRetries);
  f.compress.checked = cfg.compress;
  f.deviceName.value = cfg.deviceName;
}

function num(input: HTMLInputElement, fallback: number): number {
  const v = Number(input.value);
  return Number.isFinite(v) ? v : fallback;
}

function collect(): Partial<Config> {
  return {
    remoteKind: f.remoteKind.value as RemoteKind,
    webdav: {
      url: f.webdavUrl.value.trim(),
      username: f.webdavUser.value,
      password: f.webdavPass.value,
      basePath: f.webdavBase.value.trim() || '/bookmark-sync/',
    },
    s3: {
      endpoint: f.s3Endpoint.value.trim(),
      region: f.s3Region.value.trim() || 'us-east-1',
      bucket: f.s3Bucket.value.trim(),
      accessKeyId: f.s3Key.value.trim(),
      secretAccessKey: f.s3Secret.value,
      prefix: f.s3Prefix.value.trim(),
      forcePathStyle: f.s3PathStyle.checked,
    },
    scheduleEnabled: f.scheduleEnabled.checked,
    scheduleMinutes: Math.max(1, Math.round(num(f.scheduleMinutes, 30))),
    syncOnStartup: f.syncOnStartup.checked,
    deleteGuardCount: Math.max(0, Math.round(num(f.guardCount, 10))),
    deleteGuardRatio: Math.min(1, Math.max(0, num(f.guardRatio, 10) / 100)),
    timeoutMs: Math.max(5000, Math.round(num(f.timeoutSec, 30) * 1000)),
    maxRetries: Math.max(0, Math.round(num(f.maxRetries, 5))),
    compress: f.compress.checked,
    deviceName: f.deviceName.value.trim(),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(): void {
  ui.saveState.textContent = t('saveStatePending');
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
}

async function save(): Promise<void> {
  const res = await sendRequest({ t: 'setConfig', patch: collect() });
  ui.saveState.textContent = res.ok ? t('saveStateSaved') : t('saveStateFailed');
}

for (const el of Object.values(f)) {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    el.addEventListener('change', scheduleSave);
    if (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'url' || el.type === 'password')) {
      el.addEventListener('input', scheduleSave);
    }
  }
}

f.remoteKind.addEventListener('change', () => showPane(f.remoteKind.value as RemoteKind));

// ── 测试连接（同时探测 If-Match，需求 9.3） ───────────────────────────

/**
 * 远端地址对应的 host 权限只在这里申请（NFR-13）。
 *
 * chrome.permissions.request 要求用户手势，service worker 里调用会直接失败，
 * 所以这一步必须留在设置页的点击处理里，不能下推给后台。
 */
async function ensureRemotePermission(): Promise<boolean> {
  const url = f.remoteKind.value === 's3' ? f.s3Endpoint.value.trim() : f.webdavUrl.value.trim();
  if (url === '') return true;
  try {
    return await ensureOrigin(url, chromePermissions);
  } catch {
    // 地址还没填对时不拦着用户，真正的错误由「测试连接」报出来。
    return true;
  }
}

ui.test.addEventListener('click', async () => {
  await save();

  if (!(await ensureRemotePermission())) {
    ui.testResult.className = 'error';
    ui.testResult.textContent = t('permissionDenied');
    return;
  }

  ui.test.disabled = true;
  ui.testResult.className = 'muted';
  ui.testResult.textContent = t('testRunning');
  const res = await sendRequest({ t: 'testConnection' });
  ui.test.disabled = false;
  if (!res.ok) {
    ui.testResult.className = 'error';
    ui.testResult.textContent = res.error.messageKey
      ? t(res.error.messageKey, ...(res.error.messageArgs ?? []))
      : res.error.message;
    return;
  }
  if (res.t !== 'caps') return;
  ui.testResult.className = res.caps.ifMatch ? 'ok' : 'warn';
  ui.testResult.textContent = res.caps.ifMatch ? t('testOkIfMatch') : t('testOkNoIfMatch');
  showDegraded(res.caps.ifMatch === false);
});

/** FR-18 要求把降级模式的更新丢失窗口明确告知用户，不能只在测试结果里一闪而过。 */
function showDegraded(degraded: boolean): void {
  ui.degraded.hidden = !degraded;
  ui.degraded.textContent = t('capDegradedWarning');
}

// ── 历史版本（FR-15 / FR-16） ─────────────────────────────────────────

function renderHistory(entries: HistoryEntry[], bytes: number): void {
  if (entries.length === 0) {
    ui.historySummary.textContent = t('historyEmpty');
    ui.historyBody.replaceChildren();
    return;
  }
  ui.historySummary.textContent = t('historySummary', String(entries.length), formatBytes(bytes));
  ui.historyBody.replaceChildren(
    ...entries.map((e) => {
      const tr = document.createElement('tr');
      const cells = [
        formatTime(e.writtenAt),
        e.writtenBy || '—',
        // 0 表示「刷新索引」从文件名重建的条目，计数无从得知（见 remote/history.ts）。
        e.bookmarks === 0 ? '—' : String(e.bookmarks),
        e.folders === 0 ? '—' : String(e.folders),
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      const tdBtn = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = t('actionDownloadFile');
      btn.addEventListener('click', () => void downloadHistory(e));
      tdBtn.append(btn);
      tr.append(tdBtn);
      return tr;
    }),
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadHistory(): Promise<void> {
  ui.historySummary.textContent = t('historyLoading');
  const res = await sendRequest({ t: 'getHistory' });
  if (!res.ok) {
    ui.historySummary.textContent = res.error.messageKey
      ? t(res.error.messageKey, ...(res.error.messageArgs ?? []))
      : res.error.message;
    return;
  }
  if (res.t === 'history') renderHistory(res.entries, res.totalBytesEstimate);
}

async function downloadHistory(e: HistoryEntry): Promise<void> {
  const res = await sendRequest({ t: 'downloadHistory', file: e.file });
  if (!res.ok || res.t !== 'text') return;
  saveTextFile(res.filename ?? e.file, res.text);
}

function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/\.gz$/, '');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

ui.historyReload.addEventListener('click', () => void loadHistory());
ui.historyRefresh.addEventListener('click', async () => {
  ui.historyRefresh.disabled = true;
  ui.historySummary.textContent = t('historyRebuilding');
  const res = await sendRequest({ t: 'refreshHistoryIndex' });
  ui.historyRefresh.disabled = false;
  if (!res.ok) {
    ui.historySummary.textContent = res.error.messageKey
      ? t(res.error.messageKey, ...(res.error.messageArgs ?? []))
      : res.error.message;
    return;
  }
  await loadHistory();
});

// ── 维护 ─────────────────────────────────────────────────────────────

ui.exportLog.addEventListener('click', async () => {
  const res = await sendRequest({ t: 'exportLog' });
  if (res.ok && res.t === 'text') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveTextFile(`bookmark-sync-log-${stamp}.txt`, res.text);
  }
});

let confirmResolve: ((ok: boolean) => void) | null = null;

function confirmDialog(titleKey: string, bodyKey: string): Promise<boolean> {
  ui.confirmTitle.textContent = t(titleKey);
  ui.confirmBody.textContent = t(bodyKey);
  ui.confirm.hidden = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(ok: boolean): void {
  ui.confirm.hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  r?.(ok);
}

ui.confirmCancel.addEventListener('click', () => closeConfirm(false));
ui.confirmOk.addEventListener('click', () => closeConfirm(true));

ui.resetSync.addEventListener('click', async () => {
  // 需二次确认，说明后果（需求 9.3 维护分组）。
  if (!(await confirmDialog('actionResetSync', 'hintResetSync'))) return;
  if (!(await confirmDialog('confirmResetSyncTitle', 'confirmAgain'))) return;
  const res = await sendRequest({ t: 'resetSyncState' });
  ui.saveState.textContent = res.ok ? t('resetDone') : t('saveStateFailed');
});

ui.resetAll.addEventListener('click', async () => {
  if (!(await confirmDialog('actionResetAll', 'hintResetAll'))) return;
  if (!(await confirmDialog('confirmResetAllTitle', 'confirmAgain'))) return;
  const res = await sendRequest({ t: 'resetAll' });
  if (res.ok) {
    const cfg = await sendRequest({ t: 'getConfig' });
    if (cfg.ok && cfg.t === 'config') fill(cfg.config);
    ui.saveState.textContent = t('resetDone');
  }
});

// ── 初始化 ───────────────────────────────────────────────────────────

async function init(): Promise<void> {
  localizeDom();
  const res = await sendRequest({ t: 'getConfig' });
  if (res.ok && res.t === 'config') fill(res.config);

  // 已探测过且不支持条件写时，进页面就要看到降级提示（FR-18）。
  const status = await sendRequest({ t: 'getStatus' });
  if (status.ok && status.t === 'status') showDegraded(status.payload.caps?.ifMatch === false);

  if (status.ok && status.t === 'status' && status.payload.configured) await loadHistory();
}

void init();
