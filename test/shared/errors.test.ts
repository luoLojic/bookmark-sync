import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  AuthError,
  DeleteGuardTripped,
  NetworkError,
  serializeError,
  toAppError,
} from '../../src/shared/errors.js';

describe('error model', () => {
  it('classifies cancellation as transient and preserves UI metadata', () => {
    expect(new AbortedError().serialize()).toMatchObject({
      code: 'aborted',
      klass: 'transient',
      messageKey: 'errAborted',
    });
  });

  it('keeps fatal and user-action errors distinct', () => {
    expect(new AuthError(401).klass).toBe('fatal');
    const detail = {
      side: 'local' as const,
      localDeletes: 11,
      localTotal: 50,
      remoteDeletes: 0,
      remoteTotal: 50,
      items: [],
      itemsTruncated: 0,
    };
    expect(new DeleteGuardTripped(detail).serialize()).toMatchObject({ klass: 'userAction', detail });
  });

  it('normalizes network and unknown exceptions without clearing state', () => {
    expect(toAppError(new TypeError('offline'))).toBeInstanceOf(NetworkError);
    expect(toAppError(new DOMException('cancelled', 'AbortError'))).toBeInstanceOf(AbortedError);
    expect(serializeError('boom')).toMatchObject({ code: 'internal', klass: 'fatal', message: 'boom' });
  });
});
