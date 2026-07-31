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

/**
 * 远端身份指纹：「基线属于哪个远端」的判定依据（审计 BUG-01）。
 *
 * 只包含决定**数据存放位置**的字段。凭据不在内：改密码不会让远端变成另一个
 * 远端，把它算进去会让每次改密码都要求用户重置同步状态。compress 也不在内：
 * 它只决定文件后缀，双后缀探测本来就能读到另一种（commit.ts 的 otherPath）。
 *
 * 为什么必须有这个东西：基线的语义是「上次与远端达成一致时的内容」。换一个
 * 远端之后它就不再成立，可三方合并无法自己发现这件事 —— 它会把「基线有、
 * 本地未改、新远端没有」判成「远端删除」，从而删掉本地书签。远端为空时由
 * RemoteSnapshotMissing 拦住，但新远端**自己有一份别的快照**时拦不住：那时
 * 两边都会产生凭空的删除，而删除保护要求条数与比例同时超标才拦。
 *
 * 归一化到与真实请求一致的形式（basePath / prefix 都过 normalize），否则
 * `/a` 与 `/a/` 会被判成两个远端，用户会莫名收到「远端变了」。
 */
export function remoteIdentity(cfg: Config): string {
  if (cfg.remoteKind === 'webdav') {
    // URL 末尾斜杠不影响 joinUrl 的结果，统一去掉。
    const url = cfg.webdav.url.trim().replace(/\/+$/, '');
    return JSON.stringify(['webdav', url, normalizeBasePath(cfg.webdav.basePath)]);
  }
  const endpoint = cfg.s3.endpoint.trim().replace(/\/+$/, '');
  return JSON.stringify([
    's3',
    endpoint,
    cfg.s3.region.trim() || 'us-east-1',
    cfg.s3.bucket.trim(),
    normalizePrefix(cfg.s3.prefix),
    // 寻址方式会改变 host（虚拟主机风格把 bucket 拼进域名），同一个 bucket
    // 在两种方式下指向同一份数据，但填错时指向的是另一台服务器，仍要算进去。
    cfg.s3.forcePathStyle,
  ]);
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
