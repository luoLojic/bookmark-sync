/**
 * ui/messages.ts —— UI ↔ Engine 消息协议（方案 5.3）。
 *
 * L4 与 L3 共享的唯一类型文件。界面层只做渲染与消息收发，不含同步逻辑。
 */

import type { Counts } from '../domain/tree.js';
import type { SerializedError } from '../shared/errors.js';
import type {
  Config,
  HistoryEntry,
  LastResult,
  Phase,
  RemoteCaps,
  ResultCounts,
  SyncKind,
  SyncState,
} from '../shared/types.js';

/** 首次同步的三种选择（FR-4）。 */
export type FirstSyncChoice = 'merge' | 'useLocal' | 'useRemote';

export type Request =
  | { t: 'getStatus' }
  /** skipDeleteGuard 只在本次运行内有效，不持久化（FR-11）。 */
  | { t: 'sync'; skipDeleteGuard?: boolean; firstSyncChoice?: FirstSyncChoice }
  | { t: 'upload'; confirmed: boolean }
  | { t: 'download'; confirmed: boolean }
  /** 纯读，只算影响数量，不写任何东西（FR-2 / FR-3 的确认弹窗数据源）。 */
  | { t: 'preview'; op: 'upload' | 'download' | 'sync' }
  | { t: 'cancel' }
  | { t: 'testConnection' }
  | { t: 'getConfig' }
  | { t: 'setConfig'; patch: Partial<Config> }
  | { t: 'getHistory' }
  | { t: 'refreshHistoryIndex' }
  | { t: 'downloadHistory'; file: string }
  | { t: 'exportLog' }
  | { t: 'resetSyncState' }
  | { t: 'resetAll' };

export interface StatusPayload {
  configured: boolean;
  state: SyncState | null;
  last: LastResult | null;
  localCounts: Counts | null;
  remoteCounts: Counts | null;
  caps: RemoteCaps | null;
  hasBaseline: boolean;
  deviceName: string;
}

/** 确认弹窗的数据（需求 9.2，四种情形共用一个结构）。 */
export interface ConfirmDetail {
  kind: 'upload' | 'download' | 'deleteGuard' | 'firstSync';
  /** 受影响数量，用于弹窗正文。 */
  localCounts: Counts;
  remoteCounts: Counts;
  /** 将要丢失/删除的条目数。 */
  losing: number;
  /** 至多 20 条（CONFIRM_LIST_LIMIT）。 */
  items: { title: string; url?: string; path: string }[];
  itemsTruncated: number;
  /** 仅 deleteGuard：触发侧。 */
  side?: 'local' | 'remote' | 'both';
  /** 仅 deleteGuard：分母。 */
  totals?: { local: number; remote: number };
  /** 仅 firstSync：合并预览结果。 */
  merged?: Counts;
}

export type Event =
  | { t: 'status'; payload: StatusPayload }
  | { t: 'progress'; phase: Phase; done: number; total: number; kind: SyncKind }
  | { t: 'needConfirm'; detail: ConfirmDetail }
  | { t: 'done'; result: ResultCounts; kind: SyncKind }
  | { t: 'error'; error: SerializedError };

/** 请求的直接应答（与广播事件区分：应答是一问一答，事件是主动推送）。 */
export type Response =
  | { ok: true; t: 'status'; payload: StatusPayload }
  | { ok: true; t: 'confirm'; detail: ConfirmDetail }
  | { ok: true; t: 'done'; result: ResultCounts }
  | { ok: true; t: 'config'; config: Config }
  | { ok: true; t: 'caps'; caps: RemoteCaps }
  | { ok: true; t: 'history'; entries: HistoryEntry[]; totalBytesEstimate: number }
  | { ok: true; t: 'text'; text: string; filename?: string }
  | { ok: true; t: 'void' }
  | { ok: false; error: SerializedError };

export const EVENT_CHANNEL = 'bookmark-sync-event';

/** UI 侧发请求。runtime.sendMessage 的类型化封装。 */
export async function sendRequest(req: Request): Promise<Response> {
  const res = (await chrome.runtime.sendMessage(req)) as Response | undefined;
  if (!res) {
    return {
      ok: false,
      error: { code: 'internal', klass: 'fatal', message: 'no response from background' },
    };
  }
  return res;
}

/** 后台侧广播事件。UI 未打开时 sendMessage 会抛错，忽略即可。 */
export function broadcast(ev: Event): void {
  void chrome.runtime.sendMessage({ [EVENT_CHANNEL]: ev }).catch(() => undefined);
}

export function isEventEnvelope(m: unknown): m is Record<typeof EVENT_CHANNEL, Event> {
  return typeof m === 'object' && m !== null && EVENT_CHANNEL in m;
}

/** UI 侧订阅事件。返回取消订阅函数。 */
export function onEvent(handler: (ev: Event) => void): () => void {
  const listener = (m: unknown): void => {
    if (isEventEnvelope(m)) handler(m[EVENT_CHANNEL]);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
