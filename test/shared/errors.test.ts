import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  AuthError,
  DeleteGuardTripped,
  InternalError,
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

  it('normalizes cancellation and unknown exceptions without clearing state', () => {
    expect(toAppError(new DOMException('cancelled', 'AbortError'))).toBeInstanceOf(AbortedError);
    expect(serializeError('boom')).toMatchObject({ code: 'internal', klass: 'fatal', message: 'boom' });
  });

  it('★ 不把 TypeError 兜底成瞬时的网络错误（红线三）', () => {
    // fetch 的 TypeError 已由 platform/http.ts 的 classifyFetchError 就地归类；
    // 留一条兜底只会掩盖真问题 —— 畸形远端数据引发的「读 undefined 的属性」也是
    // TypeError，归成瞬时错误后用户看到的是「网络错误」，而它其实是程序性缺陷。
    const normalized = toAppError(new TypeError("Cannot read properties of undefined"));
    expect(normalized).toBeInstanceOf(InternalError);
    expect(normalized.klass).toBe('fatal');
    expect(normalized).not.toBeInstanceOf(NetworkError);
  });
});
