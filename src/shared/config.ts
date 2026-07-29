/**
 * shared/config.ts —— 默认值表，严格对应需求文档第 10 节。
 */

import type { Config } from './types.js';

export const DEFAULT_CONFIG: Config = {
  remoteKind: 'webdav',
  webdav: { url: '', username: '', password: '', basePath: '/bookmark-sync/' },
  s3: {
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    prefix: 'bookmark-sync/',
    forcePathStyle: true,
  },
  scheduleEnabled: false,
  scheduleMinutes: 30,
  syncOnStartup: false,
  deleteGuardCount: 10,
  deleteGuardRatio: 0.1,
  timeoutMs: 30_000,
  maxRetries: 5,
  compress: true,
  deviceName: '',
};

/** NFR-2：指数退避基础间隔与上限。 */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** FR-17：外层合并轮次上限。 */
export const MAX_MERGE_ROUNDS = 3;

/** 方案 4 要点 3：WRITE_BASELINE 单独重试次数。 */
export const BASELINE_WRITE_RETRIES = 3;

/** NFR-8：同步僵死判定阈值。 */
export const STALE_SYNC_MS = 10 * 60 * 1000;

/** NFR-9：日志环形缓冲容量。 */
export const LOG_CAPACITY = 2000;

/** FR-10 / 9.2：确认弹窗最多列出的条目数。 */
export const CONFIRM_LIST_LIMIT = 20;

export const REMOTE_FILES = {
  bookmarks: 'bookmarks.json',
  historyDir: 'history/',
  historyIndex: 'history/index.json',
  probe: '.probe',
} as const;

export function normalizeBasePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLead = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

export function normalizePrefix(p: string): string {
  const trimmed = p.trim().replace(/^\/+/, '');
  if (trimmed === '') return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** 校验配置是否足以发起同步。返回缺失字段的 i18n key 列表。 */
export function validateConfig(cfg: Config): string[] {
  const missing: string[] = [];
  if (cfg.remoteKind === 'webdav') {
    if (!cfg.webdav.url.trim()) missing.push('fieldWebdavUrl');
  } else {
    if (!cfg.s3.endpoint.trim()) missing.push('fieldS3Endpoint');
    if (!cfg.s3.bucket.trim()) missing.push('fieldS3Bucket');
    if (!cfg.s3.accessKeyId.trim()) missing.push('fieldS3AccessKey');
    if (!cfg.s3.secretAccessKey.trim()) missing.push('fieldS3SecretKey');
  }
  return missing;
}
