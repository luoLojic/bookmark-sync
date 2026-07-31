/**
 * test/engine/cancel-after-commit.test.ts —— ★ 之后取消必须走完到终态（M-1）。
 *
 * 方案第 4 节要点 4 写明「★ PUT bookmarks 成功之后忽略取消请求」。原实现只把
 * abortIfRequested() 停在 ★ 之前，而 transport 拿的是同一个 AbortSignal ——
 * platform/http.ts 每次尝试开始时都查 signal.aborted，于是用户在 PUT 已成功、
 * VERIFY 未完成时点取消，校验的 GET 抛 AbortedError；它既不是 ConflictError 也
 * 不是 VerificationError，runCommit 不重试，WRITE_BASELINE 被整个跳过。
 *
 * 不丢数据（下一轮落在「仅本地改动」分支会重走一遍完整提交），但 INV-1 最危险的
 * 那个窗口 ——「远端已提交、基线未写」—— 被人为延长，PUT_INDEX 也一起被打断。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createCancellationGate } from '../../src/engine/cancellation.js';
import { createWebdavStore } from '../../src/remote/webdav.js';
import type { Phase } from '../../src/shared/types.js';
import { bk, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters } from './harness.js';

beforeEach(() => {
  resetCounters();
});

/** 与 background.ts 相同的装配：store 绑 httpSignal，引擎拿 userSignal。 */
function wire(remote: FakeRemote) {
  const gate = createCancellationGate();
  const store = createWebdavStore(
    { url: 'https://dav.test/dav', username: 'u', password: 'p', basePath: '/bookmark-sync/' },
    {
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: remote.fetch,
      sleep: async () => undefined,
      signal: gate.httpSignal,
    },
  );
  return { gate, store };
}

describe('取消闸门本身', () => {
  it('未 seal 时，取消会传导到 HTTP 信号', () => {
    const gate = createCancellationGate();
    gate.cancel();
    expect(gate.cancelled).toBe(true);
    expect(gate.httpSignal.aborted).toBe(true);
  });

  it('seal 之后取消不再传导 —— 但仍记录为「用户已取消」', () => {
    const gate = createCancellationGate();
    gate.seal();
    gate.cancel();
    expect(gate.cancelled).toBe(true);
    expect(gate.httpSignal.aborted).toBe(false);
  });

  it('seal 可以重复调用（外层重试轮会经过多次 ★）', () => {
    const gate = createCancellationGate();
    gate.seal();
    gate.seal();
    gate.cancel();
    expect(gate.httpSignal.aborted).toBe(false);
  });

  it('取消发生在 seal 之前时，之后 seal 也救不回来 —— 那本来就该被取消', () => {
    const gate = createCancellationGate();
    gate.cancel();
    gate.seal();
    expect(gate.httpSignal.aborted).toBe(true);
  });
});

describe('★ 之后取消：必须写完基线', () => {
  it('在 VERIFY 阶段取消，同步照样走到 done 并落盘基线', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const { gate, store } = wire(remote);

    const outcome = await dev.sync(
      { kind: 'sync' },
      {
        store,
        signal: gate.userSignal,
        sealCancellation: () => gate.seal(),
        onPhase: (phase: Phase) => {
          // ★ 已经成功（PUT_BOOKMARKS 在 VERIFY 之前），此刻的取消必须无效。
          if (phase === 'verify') gate.cancel();
        },
      },
    );

    expect(outcome.phase).toBe('done');
    expect(dev.baseline()).toBeDefined();
    expect(gate.cancelled).toBe(true);
    // 索引也该写上 —— 它同样在 ★ 之后。
    expect(remote.paths().some((p) => p.endsWith('history/index.json'))).toBe(true);
  });

  it('在 PUT_INDEX 阶段取消同样不影响基线', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const { gate, store } = wire(remote);

    const outcome = await dev.sync(
      { kind: 'sync' },
      {
        store,
        signal: gate.userSignal,
        sealCancellation: () => gate.seal(),
        onPhase: (phase: Phase) => {
          if (phase === 'putIndex') gate.cancel();
        },
      },
    );

    expect(outcome.phase).toBe('done');
    expect(dev.baseline()).toBeDefined();
  });

  it('对照：不解除传导时，同一时刻的取消会让基线写不下去', async () => {
    // 这就是修复前的行为，留作对照 —— 它证明上面两条测的是 seal 这个机制，
    // 而不是「取消在 VERIFY 阶段恰好不生效」。
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const { gate, store } = wire(remote);

    await expect(
      dev.sync(
        { kind: 'sync' },
        {
          store,
          signal: gate.userSignal,
          // 故意不传 sealCancellation。
          onPhase: (phase: Phase) => {
            if (phase === 'verify') gate.cancel();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(dev.baseline()).toBeUndefined();
    // 远端却已经提交了 —— 正是 INV-1 要避免的不一致窗口。
    expect(remote.paths().some((p) => p.endsWith('bookmarks.json.gz'))).toBe(true);
  });
});

describe('★ 之前取消：仍按瞬时错误处理（INV-3）', () => {
  it('在 MERGE 阶段取消会中止，且不动任何持久状态', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const { gate, store } = wire(remote);

    await expect(
      dev.sync(
        { kind: 'sync' },
        {
          store,
          signal: gate.userSignal,
          sealCancellation: () => gate.seal(),
          onPhase: (phase: Phase) => {
            if (phase === 'merge') gate.cancel();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'aborted', klass: 'transient' });

    expect(dev.baseline()).toBeUndefined();
    expect(remote.paths()).toEqual([]);
  });

  it('在 PUT_HISTORY 阶段取消也还来得及 —— 它在 ★ 之前', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const { gate, store } = wire(remote);

    await expect(
      dev.sync(
        { kind: 'sync' },
        {
          store,
          signal: gate.userSignal,
          sealCancellation: () => gate.seal(),
          onPhase: (phase: Phase) => {
            if (phase === 'putHistory') gate.cancel();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(dev.baseline()).toBeUndefined();
    // bookmarks.json 一定没被写 —— ★ 没到达。
    expect(remote.paths().some((p) => p.endsWith('bookmarks.json.gz'))).toBe(false);
  });
});
