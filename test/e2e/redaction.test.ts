/**
 * test/e2e/redaction.test.ts —— 日志脱敏审计（NFR-9 / 方案第 11 节）。
 *
 * 「日志中不含凭据」不能只靠 redact() 的单测：真正的风险是某个模块在打日志时
 * 把整个 config 或整个 URL 塞进去，而那条路径没人测过。这里跑一次真实同步
 * （engine + webdav + http 全在路径上），把所有日志行收集起来逐项搜敏感串。
 *
 * M7 验收要求「日志中无凭据」，这个文件就是它的自动化依据。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config.js';
import { Logger } from '../../src/shared/logger.js';
import { contentHasher } from '../../src/platform/crypto.js';
import { MappingTable } from '../../src/platform/bookmarks.js';
import { createWebdavStore } from '../../src/remote/webdav.js';
import { createS3Store } from '../../src/remote/s3.js';
import { runSync } from '../../src/engine/sync.js';
import { probeStore } from '../../src/remote/store.js';
import type { Config, GuidMap, RemoteCaps } from '../../src/shared/types.js';
import type { Roots, Snapshot } from '../../src/domain/tree.js';
import { resetMemoryLock } from '../../src/engine/lock.js';
import { FakeBookmarks, plantRoots } from '../fakes/bookmarks.js';
import { FakeRemote } from '../fakes/remote.js';
import { bk, fd, tree } from '../fixtures/trees.js';

/** 这些串一旦出现在日志里就是泄露。刻意选得容易被 grep 到。 */
const SECRETS = {
  webdavPassword: 'SUPER-SECRET-WEBDAV-PW-9f3a',
  s3Secret: 'SUPER-SECRET-S3-KEY-7c2b',
  s3AccessKey: 'AKIAEXAMPLESECRETID',
  queryToken: 'TOKEN-IN-QUERY-4d1e',
} as const;

beforeEach(() => {
  resetMemoryLock();
});

function configWith(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    deviceName: '审计设备',
    webdav: {
      // URL 里同时塞了 userinfo 与 query token，两种都要被脱掉。
      url: `https://user:${SECRETS.webdavPassword}@dav.test/dav?access=${SECRETS.queryToken}`,
      username: 'auditor',
      password: SECRETS.webdavPassword,
      basePath: '/bookmark-sync/',
    },
    s3: {
      endpoint: 'https://s3.test',
      region: 'us-east-1',
      bucket: 'audit',
      accessKeyId: SECRETS.s3AccessKey,
      secretAccessKey: SECRETS.s3Secret,
      prefix: 'bookmark-sync/',
      forcePathStyle: true,
    },
    ...overrides,
  };
}

/** 收集全部日志行的 Logger（关掉控制台镜像，避免污染测试输出）。 */
function collectingLogger(): { logger: Logger; lines: () => string[] } {
  const logger = new Logger(5000);
  logger.setConsoleMirror(false);
  return { logger, lines: () => logger.lines() };
}

function assertClean(lines: readonly string[]): void {
  const blob = lines.join('\n');
  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(blob.includes(secret), `日志泄露了 ${name}`).toBe(false);
  }
  // Basic 认证头的 base64 也不能出现。
  const basic = btoa(`auditor:${SECRETS.webdavPassword}`);
  expect(blob.includes(basic), '日志泄露了 Basic 认证头').toBe(false);
}

async function runOneSync(local: Roots, logger: Logger, config: Config): Promise<void> {
  const remote = new FakeRemote();
  const bookmarks = new FakeBookmarks();
  const stored: GuidMap = plantRoots(bookmarks, local);
  const mapping = new MappingTable(stored, async () => undefined);
  const caps: RemoteCaps = { ifMatch: true, suffix: '.json.gz', probedAt: '' };

  const store = createWebdavStore(config.webdav, {
    timeoutMs: 1000,
    maxRetries: 2,
    fetchImpl: remote.fetch,
    sleep: async () => undefined,
    onRetry: (info) => logger.warn(`重试 ${info.attempt}，等待 ${info.delayMs}ms：${info.reason}`),
  });

  let baseline: Snapshot | undefined;
  let guid = 0;

  await runSync(
    { kind: 'sync' },
    {
      store,
      bookmarks,
      mapping,
      caps,
      config,
      now: () => new Date('2026-07-30T10:00:00Z'),
      nonce: () => 'nonce-audit',
      hash: contentHasher,
      newGuid: (type) => `${type === 'folder' ? 'f' : 'b'}-${(0xd00000000000 + ++guid).toString(16)}`,
      loadBaseline: async () => baseline,
      saveBaseline: async (s) => {
        baseline = s;
      },
      log: {
        info: (m, ...a) => logger.info(m, ...a),
        warn: (m, ...a) => logger.warn(m, ...a),
      },
    },
  );
}

describe('日志脱敏审计（NFR-9 / M7 验收）', () => {
  const local = tree([bk('b-0000000000a1', 'MDN', 'https://mdn.test/'), fd('f-0000000000a1', '技术')]);

  it('一次完整同步的日志里不含任何凭据', async () => {
    const { logger, lines } = collectingLogger();
    await runOneSync(local, logger, configWith());
    expect(lines().length).toBeGreaterThan(0);
    assertClean(lines());
  });

  it('把整个 config 直接打进日志也不会泄露', async () => {
    // 这是最容易犯的错：调试时顺手 log(config)。redact 必须兜住。
    const { logger, lines } = collectingLogger();
    logger.info('配置快照', configWith());
    assertClean(lines());
  });

  it('把远端 URL 直接打进日志也不会泄露 userinfo 与 query', async () => {
    const { logger, lines } = collectingLogger();
    const config = configWith();
    logger.warn(`请求失败：GET ${config.webdav.url}/bookmarks.json`);
    assertClean(lines());
    expect(lines().join('\n')).toContain('?***');
  });

  it('把 Authorization 头打进日志也不会泄露', async () => {
    const { logger, lines } = collectingLogger();
    const basic = btoa(`auditor:${SECRETS.webdavPassword}`);
    logger.warn(`headers: authorization=Basic ${basic}`);
    assertClean(lines());
  });

  it('S3 的签名头与密钥不会泄露', async () => {
    const { logger, lines } = collectingLogger();
    const config = configWith();
    logger.info('S3 配置', config.s3);
    logger.warn(`x-amz-signature=${'a'.repeat(64)} secretAccessKey=${SECRETS.s3Secret}`);
    assertClean(lines());
  });

  it('网络错误重试的日志不含凭据', async () => {
    const { logger, lines } = collectingLogger();
    const remote = new FakeRemote({ errorRate: 1 });
    const config = configWith();
    const store = createWebdavStore(config.webdav, {
      timeoutMs: 100,
      maxRetries: 2,
      fetchImpl: remote.fetch,
      sleep: async () => undefined,
      onRetry: (info) => logger.warn(`重试 ${info.attempt}：${info.reason}`),
    });
    await store.get('bookmarks.json').catch((e: unknown) => logger.warn('读取失败', e));
    expect(lines().length).toBeGreaterThan(0);
    assertClean(lines());
  });

  it('能力探测的日志不含凭据', async () => {
    const { logger, lines } = collectingLogger();
    const remote = new FakeRemote();
    const config = configWith();
    const store = createWebdavStore(config.webdav, {
      timeoutMs: 1000,
      maxRetries: 1,
      fetchImpl: remote.fetch,
      sleep: async () => undefined,
    });
    const caps = await probeStore(store, { now: () => new Date(0), compress: true });
    logger.info(`探测结果 ${JSON.stringify(caps)}，地址 ${config.webdav.url}`);
    assertClean(lines());
  });

  it('S3 store 构造与请求过程不把密钥写进错误信息', async () => {
    const { logger, lines } = collectingLogger();
    const config = configWith();
    const store = createS3Store(config.s3, {
      timeoutMs: 100,
      maxRetries: 0,
      fetchImpl: (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => new Date(0),
    });
    await store.get('bookmarks.json').catch((e: unknown) => logger.warn('S3 读取失败', e));
    assertClean(lines());
  });
});
