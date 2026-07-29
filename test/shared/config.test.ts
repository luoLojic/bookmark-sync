import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, normalizeBasePath, normalizePrefix, validateConfig } from '../../src/shared/config.js';

describe('configuration', () => {
  it('matches documented defaults', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      remoteKind: 'webdav',
      scheduleEnabled: false,
      scheduleMinutes: 30,
      syncOnStartup: false,
      deleteGuardCount: 10,
      deleteGuardRatio: 0.1,
      timeoutMs: 30_000,
      maxRetries: 5,
      compress: true,
    });
  });

  it.each([
    ['', '/'],
    ['/', '/'],
    [' bookmark-sync ', '/bookmark-sync/'],
    ['/nested/path', '/nested/path/'],
  ])('normalizes WebDAV base path %j', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each([
    ['', ''],
    ['/', ''],
    ['/bookmark-sync', 'bookmark-sync/'],
    [' nested/path/ ', 'nested/path/'],
  ])('normalizes S3 prefix %j', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected);
  });

  it('validates only fields required by the selected backend', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual(['fieldWebdavUrl']);
    expect(validateConfig({ ...DEFAULT_CONFIG, webdav: { ...DEFAULT_CONFIG.webdav, url: 'https://dav.test' } })).toEqual([]);
    expect(validateConfig({ ...DEFAULT_CONFIG, remoteKind: 's3' })).toEqual([
      'fieldS3Endpoint',
      'fieldS3Bucket',
      'fieldS3AccessKey',
      'fieldS3SecretKey',
    ]);
  });
});
