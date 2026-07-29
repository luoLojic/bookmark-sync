/**
 * shared/types.ts —— 跨层共享的配置与状态类型（技术规划方案 3.1）。
 */

import type { Counts, Snapshot } from '../domain/tree.js';

export type RemoteKind = 'webdav' | 's3';

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  basePath: string;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  /** 路径风格寻址：MinIO 等自建服务需要。 */
  forcePathStyle: boolean;
}

export interface Config {
  remoteKind: RemoteKind;
  webdav: WebdavConfig;
  s3: S3Config;
  /** 定时同步（FR-7），默认关闭、30 分钟。 */
  scheduleEnabled: boolean;
  scheduleMinutes: number;
  /** 浏览器启动时同步（FR-8），默认关闭。 */
  syncOnStartup: boolean;
  /** 删除保护阈值（FR-10）。 */
  deleteGuardCount: number;
  deleteGuardRatio: number;
  /** 弱网参数（NFR-1 / NFR-2）。 */
  timeoutMs: number;
  maxRetries: number;
  /** 压缩上传（NFR-5）。 */
  compress: boolean;
  /** 设备名，仅用于历史展示（需求 9.3 设备分组）。 */
  deviceName: string;
}

/** 远端能力探测结果（方案 3.1 / 5.1）。 */
export interface RemoteCaps {
  /** 是否支持条件写 If-Match（FR-17 / FR-18）。 */
  ifMatch: boolean;
  /** bookmarks.json 实际使用的后缀，命中后缓存，避免每次双后缀探测。 */
  suffix: '.json' | '.json.gz';
  probedAt: string;
}

export type Phase =
  | 'idle'
  | 'read'
  | 'merge'
  | 'guard'
  | 'applyLocal'
  | 'putHistory'
  | 'putBookmarks'
  | 'verify'
  | 'putIndex'
  | 'writeBaseline'
  | 'done';

export type SyncKind = 'sync' | 'upload' | 'download';

export interface SyncState {
  running: boolean;
  /** 用于 NFR-8 僵死检测。 */
  startedAt: number;
  phase: Phase;
  done: number;
  total: number;
  runId: string;
  kind: SyncKind;
}

export interface ResultCounts {
  local: Counts;
  remote: Counts;
  created: number;
  updated: number;
  moved: number;
  removed: number;
  uploaded: boolean;
  version: number;
}

export interface LastResult {
  at: number;
  ok: boolean;
  kind: SyncKind;
  counts?: ResultCounts;
  error?: string;
}

/** 历史索引项（FR-15）。 */
export interface HistoryEntry {
  version: number;
  writtenAt: string;
  writtenBy: string;
  bookmarks: number;
  folders: number;
  file: string;
}

export interface HistoryIndex {
  formatVersion: 1;
  entries: HistoryEntry[];
}

/** 本地浏览器书签 ID ↔ GUID 映射（需求 2 术语表，INV-2）。 */
export type GuidMap = Record<string, string>;

export type Baseline = Snapshot | null;
