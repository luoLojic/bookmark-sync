/**
 * test/engine/attention.test.ts —— 定时同步遇到「需用户确认」时不得无声结束（H-3）。
 *
 * 原实现对删除保护与首次同步一律返回 `{ ok: true, t: 'confirm' }` 并刻意不写
 * lastResult。这在用户点同步时是对的（popup 正等着弹确认框），在定时 / 启动同步
 * 时却意味着彻底无声：alarm 回调只是 `void executeSync(...)`，没人接这个应答。
 * 新设备开着定时同步每 30 分钟被 FirstSyncChoiceRequired 拦一次，popup 上永远是
 * 「尚未同步」，用户无从判断是没触发还是失败了。
 */

import { describe, expect, it } from 'vitest';
import { decideAttention } from '../../src/engine/attention.js';

describe('用户点的同步：照旧走 confirm 通道', () => {
  it('删除保护弹确认框，不写 lastResult、不打角标', () => {
    expect(
      decideAttention({ klass: 'userAction', code: 'deleteGuard', interactive: true, fallbackKey: 'errDeleteGuard' }),
    ).toEqual({ channel: 'confirm', badge: false });
  });

  it('首次同步选择同样走 confirm', () => {
    expect(
      decideAttention({ klass: 'userAction', code: 'firstSyncChoice', interactive: true }),
    ).toEqual({ channel: 'confirm', badge: false });
  });
});

describe('★ 定时 / 启动同步：必须留下痕迹', () => {
  it('删除保护写 lastResult 并打角标，文案换成带行动指引的那条', () => {
    expect(
      decideAttention({ klass: 'userAction', code: 'deleteGuard', interactive: false, fallbackKey: 'errDeleteGuard' }),
    ).toEqual({ channel: 'record', badge: true, messageKey: 'errNeedConfirmGuard' });
  });

  it('首次同步同理', () => {
    expect(
      decideAttention({ klass: 'userAction', code: 'firstSyncChoice', interactive: false, fallbackKey: 'errFirstSync' }),
    ).toEqual({ channel: 'record', badge: true, messageKey: 'errNeedConfirmFirstSync' });
  });

  it('没有专门文案的 userAction 错误回落到它自带的 key', () => {
    expect(
      decideAttention({
        klass: 'userAction',
        code: 'formatVersionTooNew',
        interactive: false,
        fallbackKey: 'errFormatTooNew',
      }),
    ).toEqual({ channel: 'record', badge: true, messageKey: 'errFormatTooNew' });
  });
});

describe('普通失败：与是否交互无关', () => {
  it('Fatal 错误照常记入 lastResult，但不打角标', () => {
    for (const interactive of [true, false]) {
      expect(
        decideAttention({ klass: 'fatal', code: 'auth', interactive, fallbackKey: 'errAuth' }),
      ).toEqual({ channel: 'record', badge: false, messageKey: 'errAuth' });
    }
  });

  it('瞬时错误同样只记录 —— 角标留给「需要你做点什么」的情形', () => {
    expect(decideAttention({ klass: 'transient', code: 'network', interactive: false, fallbackKey: 'errNetwork' })).toEqual(
      { channel: 'record', badge: false, messageKey: 'errNetwork' },
    );
  });

  it('连 key 都没有时不编一个出来，交给调用方回落到原始 message', () => {
    expect(decideAttention({ klass: 'fatal', code: 'internal', interactive: false })).toEqual({
      channel: 'record',
      badge: false,
    });
  });
});
