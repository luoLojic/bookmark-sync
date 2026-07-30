import { describe, expect, it } from 'vitest';
import { checkGuard, type GuardInput } from '../../src/domain/guard.js';

/** 默认阈值取自需求第 10 节：条数 10、百分比 10%。 */
const base: GuardInput = {
  localDeletes: 0,
  localTotal: 100,
  remoteDeletes: 0,
  remoteTotal: 100,
  countThreshold: 10,
  ratioThreshold: 0.1,
};

const withLocal = (deletes: number, total = 100): GuardInput => ({
  ...base,
  localDeletes: deletes,
  localTotal: total,
});
const withRemote = (deletes: number, total = 100): GuardInput => ({
  ...base,
  remoteDeletes: deletes,
  remoteTotal: total,
});

describe('checkGuard — 两个阈值必须同时满足（FR-10）', () => {
  it('没有删除时不触发', () => {
    expect(checkGuard(base).tripped).toBe(false);
  });

  it('条数超阈值但比例未超 → 不触发', () => {
    // 11 条 / 1000 条 = 1.1%，远低于 10%。
    expect(checkGuard(withLocal(11, 1000)).tripped).toBe(false);
  });

  it('比例超阈值但条数未超 → 不触发', () => {
    // 5 条 / 20 条 = 25%，但 5 条不足 10 条。小书签库不该被频繁打扰。
    expect(checkGuard(withLocal(5, 20)).tripped).toBe(false);
  });

  it('两者都超 → 触发', () => {
    // 20 条 / 100 条 = 20%。
    const v = checkGuard(withLocal(20));
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.side).toBe('local');
  });
});

describe('checkGuard — 阈值边界（M5 验收要核对）', () => {
  it('恰好 10 条不触发：需求写的是「> 10 个」', () => {
    // 10 / 50 = 20%，比例已超；条数恰好等于阈值，不触发。
    expect(checkGuard(withLocal(10, 50)).tripped).toBe(false);
  });

  it('11 条且比例超过 → 触发（条数边界的另一侧）', () => {
    expect(checkGuard(withLocal(11, 50)).tripped).toBe(true);
  });

  it('恰好 10% 不触发：需求写的是「> 10%」', () => {
    // 20 / 200 = 恰好 10%；条数已超，比例恰好等于阈值，不触发。
    expect(checkGuard(withLocal(20, 200)).tripped).toBe(false);
  });

  it('略高于 10% 且条数超过 → 触发（比例边界的另一侧）', () => {
    // 21 / 200 = 10.5%。
    expect(checkGuard(withLocal(21, 200)).tripped).toBe(true);
  });
});

describe('checkGuard — 两侧独立判定', () => {
  it('仅本地触发时 side 为 local', () => {
    const v = checkGuard(withLocal(20));
    if (v.tripped) expect(v.side).toBe('local');
  });

  it('仅远端触发时 side 为 remote', () => {
    const v = checkGuard(withRemote(20));
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.side).toBe('remote');
  });

  it('两侧都触发时 side 为 both', () => {
    const v = checkGuard({ ...base, localDeletes: 20, remoteDeletes: 30 });
    if (v.tripped) expect(v.side).toBe('both');
  });

  it('各自用自己的总数作分母', () => {
    // 本地 15/100 = 15% 触发；远端 15/1000 = 1.5% 不触发。
    const v = checkGuard({
      ...base,
      localDeletes: 15,
      localTotal: 100,
      remoteDeletes: 15,
      remoteTotal: 1000,
    });
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.side).toBe('local');
    expect(v.local.tripped).toBe(true);
    expect(v.remote.tripped).toBe(false);
  });
});

describe('checkGuard — 统计数据与边界输入', () => {
  it('返回两侧的条数、总数与比例，供弹窗渲染', () => {
    const v = checkGuard(withLocal(25, 200));
    expect(v.local).toEqual({ deletes: 25, total: 200, ratio: 0.125, tripped: true });
    expect(v.remote).toEqual({ deletes: 0, total: 100, ratio: 0, tripped: false });
  });

  it('总数为 0 时比例记为 0，不产生 NaN', () => {
    const v = checkGuard({ ...base, localTotal: 0, remoteTotal: 0 });
    expect(v.local.ratio).toBe(0);
    expect(v.remote.ratio).toBe(0);
    expect(v.tripped).toBe(false);
  });

  it('阈值为 0 时任何一次删除都触发', () => {
    // 用户可在设置页把阈值调到 0，等于「每次删除都确认」。
    const v = checkGuard({ ...base, localDeletes: 1, countThreshold: 0, ratioThreshold: 0 });
    expect(v.tripped).toBe(true);
  });

  it('删除数等于总数（清空一侧）必然触发', () => {
    const v = checkGuard(withLocal(100, 100));
    expect(v.tripped).toBe(true);
    expect(v.local.ratio).toBe(1);
  });

  it('负数与非整数输入被规整，不会静默通过', () => {
    // 防御性：上游计数不应为负，但真为负时不能因此绕过保护。
    const v = checkGuard({ ...base, localDeletes: -5 });
    expect(v.local.deletes).toBe(0);
    expect(v.tripped).toBe(false);
  });
});
