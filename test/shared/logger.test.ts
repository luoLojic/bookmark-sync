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
