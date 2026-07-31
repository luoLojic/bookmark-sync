/**
 * engine/attention.ts —— 「需要用户确认」的结果该往哪儿走（审计 H-3）。
 *
 * 删除保护与首次同步选择不是失败，而是「等用户决定」，因此走 confirm 通道并且
 * 刻意不写 lastResult —— 否则 popup 会把它显示成上次同步失败。
 *
 * 但那条推理有个前提：有人正在等这个应答。定时同步与启动同步没有接收方，
 * alarm 回调只是 `void executeSync(...)`。原实现于是在这两种情形下完全无声：
 * 不写 lastResult、不广播、不打角标，只在日志里留一行。新设备打开定时同步后，
 * 每 30 分钟被 FirstSyncChoiceRequired 拦一次，而 popup 上永远是「尚未同步」，
 * 用户无从判断是没触发还是失败了。
 *
 * 判定单独抽出来是因为真正容易错的是三个条件的组合（错误类别 × 是否交互 ×
 * 换哪条文案），而不是写 storage 或调 chrome.action。
 */

import type { ErrorClass, ErrorCode } from '../shared/errors.js';

export interface AttentionDecision {
  /**
   * confirm —— 交给正在等待的 UI 弹确认框；
   * record  —— 记进 lastResult，让用户下次打开 popup 时看到。
   */
  channel: 'confirm' | 'record';
  /** channel 为 record 时，lastResult 用的 i18n key。 */
  messageKey?: string;
  /** 是否在扩展图标上打角标。 */
  badge: boolean;
}

/** 非交互场景下换用的文案：泛化的「需要确认」看不出该做什么。 */
const ACTION_HINT: Partial<Record<ErrorCode, string>> = {
  deleteGuard: 'errNeedConfirmGuard',
  firstSyncChoice: 'errNeedConfirmFirstSync',
};

export function decideAttention(input: {
  klass: ErrorClass;
  code: ErrorCode;
  /** 请求来自 UI（用户点的）为 true；alarm / onStartup 为 false。 */
  interactive: boolean;
  /** 错误自带的 i18n key，用于非 userAction 的普通失败。 */
  fallbackKey?: string;
}): AttentionDecision {
  if (input.klass !== 'userAction') {
    const out: AttentionDecision = { channel: 'record', badge: false };
    if (input.fallbackKey !== undefined) out.messageKey = input.fallbackKey;
    return out;
  }
  if (input.interactive) return { channel: 'confirm', badge: false };

  const key = ACTION_HINT[input.code] ?? input.fallbackKey;
  const out: AttentionDecision = { channel: 'record', badge: true };
  if (key !== undefined) out.messageKey = key;
  return out;
}
