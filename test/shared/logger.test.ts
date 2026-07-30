import { describe, expect, it, vi } from 'vitest';
import { Logger, redact } from '../../src/shared/logger.js';

describe('logger', () => {
  it('redacts credentials, authorization and URL query strings', () => {
    const text = redact(
      'password=hunter2 Authorization: Bearer abc.def https://user:pass@example.test/a?X-Amz-Signature=secret',
    );
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('pass@');
    expect(text).not.toContain('secret');
    expect(text).toContain('?***');
  });

  it('uses a bounded ring buffer and persists a defensive copy', async () => {
    vi.useFakeTimers();
    const saved: string[][] = [];
    const logger = new Logger(2);
    logger.setConsoleMirror(false);
    logger.setSink({ persist: (lines) => void saved.push(lines) });
    logger.setContext({ runId: 'run-1', phase: 'read' });
    logger.info('one');
    logger.warn('two');
    logger.error('three');
    expect(logger.lines()).toHaveLength(2);
    expect(logger.lines()[1]).toContain('[run-1][read] three');
    await logger.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(logger.lines());
    logger.clear();
    expect(logger.export()).toBe('');
    vi.useRealTimers();
  });
});

describe('redact — 各种书写形式', () => {
  it('脱掉 JSON.stringify 产生的形式', () => {
    // 最容易犯的错是调试时顺手 log(config)，那出来的就是这种带闭引号的键名。
    const text = redact('{"username":"me","password":"hunter2","secretAccessKey":"abc123"}');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc123');
    // 非敏感字段保持原样，否则日志就没用了。
    expect(text).toContain('me');
  });

  it('脱掉 key=value 与 key: value 两种形式', () => {
    expect(redact('password=hunter2')).not.toContain('hunter2');
    expect(redact('password: hunter2')).not.toContain('hunter2');
    expect(redact("password='hunter2'")).not.toContain('hunter2');
  });

  it('secretAccessKey 不会被 secret 的前缀匹配吃掉', () => {
    const text = redact('{"secretAccessKey":"S3KEY","secret":"OTHER"}');
    expect(text).not.toContain('S3KEY');
    expect(text).not.toContain('OTHER');
  });

  it('大小写不敏感', () => {
    expect(redact('Password=hunter2')).not.toContain('hunter2');
    expect(redact('X-Amz-Signature=deadbeef')).not.toContain('deadbeef');
  });

  it('URL 的 userinfo 与 query 都被脱掉，主机与路径保留', () => {
    const text = redact('https://me:pw@dav.test/dav/file.json?token=abc');
    expect(text).not.toContain('pw@');
    expect(text).not.toContain('abc');
    expect(text).toContain('dav.test');
  });

  it('不含敏感信息的文本原样保留', () => {
    const plain = '[read] 第 1 轮，远端快照 version=7';
    expect(redact(plain)).toBe(plain);
  });
});
