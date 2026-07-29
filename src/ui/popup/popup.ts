/**
 * ui/popup/popup.ts —— 弹窗界面（需求 9.1 / 9.2）。
 *
 * 只做渲染与消息收发，不含任何同步逻辑（方案 1.1 L4 约束）。
 */

import { localizeDom, t } from '../i18n.js';
import { onEvent, sendRequest, type ConfirmDetail, type Request, type StatusPayload } from '../messages.js';
import type { Counts } from '../../domain/tree.js';
import type { Phase } from '../../shared/types.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const el = {
  lastSync: $<HTMLSpanElement>('last-sync'),
  counts: $<HTMLSpanElement>('counts'),
  stateLine: $<HTMLSpanElement>('state-line'),
  progressWrap: $<HTMLDivElement>('progress-wrap'),
  progressBar: $<HTMLDivElement>('progress-bar'),
  sync: $<HTMLButtonElement>('btn-sync'),
  upload: $<HTMLButtonElement>('btn-upload'),
  download: $<HTMLButtonElement>('btn-download'),
  cancel: $<HTMLButtonElement>('btn-cancel'),
  options: $<HTMLButtonElement>('btn-options'),
  confirm: $<HTMLDivElement>('confirm'),
  confirmTitle: $<HTMLHeadingElement>('confirm-title'),
  confirmBody: $<HTMLParagraphElement>('confirm-body'),
  confirmList: $<HTMLUListElement>('confirm-list'),
  confirmMore: $<HTMLParagraphElement>('confirm-more'),
  confirmChoices: $<HTMLDivElement>('confirm-choices'),
  confirmOk: $<HTMLButtonElement>('confirm-ok'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'),
};

let busy = false;

function fmtCounts(c: Counts | null): string {
  return c ? String(c.bookmarks + c.folders) : '—';
}

function fmtAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('agoJustNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('agoMinutes', String(m));
  const h = Math.round(m / 60);
  if (h < 24) return t('agoHours', String(h));
  return t('agoDays', String(Math.round(h / 24)));
}

function phaseLabel(phase: Phase): string {
  return t(`phase_${phase}`);
}

function setBusy(on: boolean): void {
  busy = on;
  el.sync.disabled = on;
  el.upload.disabled = on;
  el.download.disabled = on;
  el.cancel.hidden = !on;
  el.progressWrap.hidden = !on;
}

function render(s: StatusPayload): void {
  if (!s.configured) {
    el.stateLine.textContent = t('stateNotConfigured');
    el.stateLine.className = 'warn';
    el.lastSync.textContent = '';
    el.counts.textContent = '';
    setBusy(false);
    el.sync.disabled = true;
    el.upload.disabled = true;
    el.download.disabled = true;
    return;
  }

  el.lastSync.textContent = s.last ? t('lastSyncAt', fmtAgo(s.last.at)) : t('lastSyncNever');
  el.counts.textContent = t('countsLine', fmtCounts(s.localCounts), fmtCounts(s.remoteCounts));

  const running = s.state?.running === true;
  setBusy(running);
  if (running && s.state) {
    el.stateLine.textContent = phaseLabel(s.state.phase);
    el.stateLine.className = '';
    setProgress(s.state.done, s.state.total);
  } else if (s.last && !s.last.ok) {
    el.stateLine.textContent = s.last.error ?? t('stateError');
    el.stateLine.className = 'error';
  } else {
    el.stateLine.textContent = t('stateReady');
    el.stateLine.className = 'ok';
  }
}

function setProgress(done: number, total: number): void {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  el.progressBar.style.width = `${pct}%`;
}

async function refresh(): Promise<void> {
  const res = await sendRequest({ t: 'getStatus' });
  if (res.ok && res.t === 'status') render(res.payload);
}

// ── 确认覆盖层（需求 9.2） ─────────────────────────────────────────────

type ConfirmResolve = (v: string | null) => void;
let pendingResolve: ConfirmResolve | null = null;

function showConfirm(detail: ConfirmDetail): Promise<string | null> {
  el.confirmTitle.textContent = t(`confirmTitle_${detail.kind}`);
  el.confirmBody.textContent = confirmBody(detail);

  el.confirmList.replaceChildren(
    ...detail.items.map((it) => {
      const li = document.createElement('li');
      li.textContent = it.url ? `${it.path}${it.title} — ${it.url}` : `${it.path}${it.title}/`;
      li.title = li.textContent;
      return li;
    }),
  );
  el.confirmMore.hidden = detail.itemsTruncated <= 0;
  el.confirmMore.textContent = t('confirmMore', String(detail.itemsTruncated));

  // 首次同步是三选一（FR-4），其余是确认/取消。
  const isChoice = detail.kind === 'firstSync';
  el.confirmChoices.hidden = !isChoice;
  el.confirmOk.hidden = isChoice;
  if (isChoice) {
    el.confirmChoices.replaceChildren(
      ...(['merge', 'useLocal', 'useRemote'] as const).map((c) => {
        const b = document.createElement('button');
        b.textContent = t(`firstSync_${c}`);
        b.className = c === 'merge' ? 'primary' : '';
        b.addEventListener('click', () => finishConfirm(c));
        return b;
      }),
    );
  }

  el.confirm.hidden = false;
  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve;
  });
}

function confirmBody(d: ConfirmDetail): string {
  const l = d.localCounts.bookmarks + d.localCounts.folders;
  const r = d.remoteCounts.bookmarks + d.remoteCounts.folders;
  switch (d.kind) {
    case 'upload':
      return t('confirmBodyUpload', String(r), String(l), String(d.losing));
    case 'download':
      return t('confirmBodyDownload', String(l), String(r), String(d.losing));
    case 'deleteGuard':
      return t('confirmBodyGuard', String(d.losing), t(`side_${d.side ?? 'both'}`));
    case 'firstSync':
      return t(
        'confirmBodyFirstSync',
        String(l),
        String(r),
        String((d.merged?.bookmarks ?? 0) + (d.merged?.folders ?? 0)),
      );
  }
}

function finishConfirm(value: string | null): void {
  el.confirm.hidden = true;
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.(value);
}

el.confirmCancel.addEventListener('click', () => finishConfirm(null));
el.confirmOk.addEventListener('click', () => finishConfirm('ok'));

// ── 操作 ─────────────────────────────────────────────────────────────

async function run(req: Request): Promise<void> {
  if (busy) return;
  setBusy(true);
  el.stateLine.className = '';
  el.stateLine.textContent = t('phase_read');
  const res = await sendRequest(req);
  setBusy(false);

  if (res.ok && res.t === 'confirm') {
    // 引擎要求确认（删除保护 / 首次同步）。
    const answer = await showConfirm(res.detail);
    if (answer === null) {
      await refresh();
      return;
    }
    if (res.detail.kind === 'deleteGuard') {
      // FR-11：从头重新完整执行，不复用已计算的计划。
      await run({ t: 'sync', skipDeleteGuard: true });
      return;
    }
    if (res.detail.kind === 'firstSync') {
      await run({ t: 'sync', firstSyncChoice: answer as 'merge' | 'useLocal' | 'useRemote' });
      return;
    }
    return;
  }

  if (!res.ok) {
    el.stateLine.className = 'error';
    el.stateLine.textContent = res.error.messageKey
      ? t(res.error.messageKey, ...(res.error.messageArgs ?? []))
      : res.error.message;
    await refresh();
    return;
  }
  await refresh();
}

/** 上传/下载：先 preview 拿影响数量，确认后再执行（FR-2 / FR-3）。 */
async function runOverwrite(op: 'upload' | 'download'): Promise<void> {
  if (busy) return;
  const pre = await sendRequest({ t: 'preview', op });
  if (!pre.ok) {
    el.stateLine.className = 'error';
    el.stateLine.textContent = pre.error.messageKey
      ? t(pre.error.messageKey, ...(pre.error.messageArgs ?? []))
      : pre.error.message;
    return;
  }
  if (pre.t !== 'confirm') return;
  const answer = await showConfirm(pre.detail);
  if (answer === null) return;
  await run(op === 'upload' ? { t: 'upload', confirmed: true } : { t: 'download', confirmed: true });
}

el.sync.addEventListener('click', () => void run({ t: 'sync' }));
el.upload.addEventListener('click', () => void runOverwrite('upload'));
el.download.addEventListener('click', () => void runOverwrite('download'));
el.cancel.addEventListener('click', () => void sendRequest({ t: 'cancel' }));
el.options.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

onEvent((ev) => {
  switch (ev.t) {
    case 'progress':
      setBusy(true);
      el.stateLine.className = '';
      el.stateLine.textContent = phaseLabel(ev.phase);
      setProgress(ev.done, ev.total);
      break;
    case 'status':
      render(ev.payload);
      break;
    case 'done':
    case 'error':
      void refresh();
      break;
    case 'needConfirm':
      void showConfirm(ev.detail);
      break;
  }
});

localizeDom();
void refresh();
