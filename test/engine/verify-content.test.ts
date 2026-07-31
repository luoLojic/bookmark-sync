/**
 * test/engine/verify-content.test.ts —— 写后校验与无变化短路都必须重算哈希（H-5）。
 *
 * 两处原本都在比较快照**自报**的 contentHash 字段：
 *
 *   · verifyCommit：那个字段是本扩展刚写进 JSON 的，只要 JSON 能解析出来它就
 *     必然等于写入值 —— 检查永远通过，NFR-4 想防的「上传被截断 / 内容被改写」
 *     一个都发现不了（gzip 截断、JSON 截断能被解码器挡住，但「JSON 仍然合法而
 *     roots 不对」挡不住）；
 *   · 无变化短路：拿远端自报字段与本地算出的目标哈希比，字段对得上就跳过全部
 *     三个 PUT。远端被手工编辑过（FR-16 明确引导用户下载历史文件后手动导入）
 *     而字段没跟着改时，这一跳过是错的。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeJson } from '../../src/remote/codec.js';
import { createWebdavStore } from '../../src/remote/webdav.js';
import { bk, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters } from './harness.js';

beforeEach(() => {
  resetCounters();
});

const keyOf = (remote: FakeRemote): string =>
  remote.paths().find((p) => p.endsWith('bookmarks.json.gz'))!;

/** 改远端快照的 roots，但让 contentHash 字段保持原样。 */
async function tamperRootsKeepingHash(remote: FakeRemote): Promise<void> {
  const key = keyOf(remote);
  const snap = await decodeSnapshot(remote.read(key)!);
  const first = snap.roots.bar.children[0]!;
  snap.roots.bar.children[0] = { ...first, title: `${first.title}（被改过）` };
  remote.commitFromOtherDevice(key, await encodeJson(snap, true));
}

describe('写后校验必须对读回的 roots 重算哈希', () => {
  it('★ 提交后内容被改写、contentHash 字段未变时校验失败并重来一轮', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    // 先正常同步一次拿到基线 —— 否则校验失败后的第二轮会因为「两侧都有内容且
    // 无基线」变成首次同步选择，掩盖真正要测的东西。
    await dev.sync();
    dev.bookmarks.seed(dev.bookmarks.barId, { title: '新增', url: 'https://c.test/' });

    // 只在第一轮的 VERIFY 阶段开始时改写远端。onPhase 会被 await，所以这一定
    // 发生在校验的 GET 之前（commit.ts 就是为此把 onPhase 设计成可等待的）。
    let tampered = false;
    const outcome = await dev.sync(
      { kind: 'sync' },
      {
        onPhase: async (phase) => {
          if (phase !== 'verify' || tampered) return;
          tampered = true;
          await tamperRootsKeepingHash(remote);
        },
      },
    );

    // 断言的是「这一轮被判失败并回到 READ」，而不是最终失败：损坏只发生一次，
    // 第二轮重新合并后收敛成功正是 FR-17 与 INV-4 想要的行为。
    // 原实现比较自报字段，这次改写根本不会被发现，也就不会有这条重试记录。
    expect(dev.logs.some((l) => l.includes('第 1 轮遇到冲突'))).toBe(true);
    expect(outcome.rounds).toBe(2);
  });

  it('正常提交不会被误判（没有假阳性）', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    await expect(dev.sync()).resolves.toMatchObject({ uploaded: true });
  });
});

describe('无变化短路必须对远端 roots 重算哈希', () => {
  it('★ 远端 roots 与目标一致、只有 contentHash 字段不对时，仍应短路', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    await dev.sync();

    // 只改自报字段，roots 一字不动 —— 手工编辑过快照又忘了改哈希就是这样。
    // 原实现拿这个字段与目标哈希比，于是判定「远端变了」，白写三个文件并推进
    // 一个新的历史版本；重算之后才看得出内容其实没变。
    const key = keyOf(remote);
    const snap = await decodeSnapshot(remote.read(key)!);
    remote.commitFromOtherDevice(
      key,
      await encodeJson({ ...snap, contentHash: 'sha256:deadbeef' }, true),
    );

    remote.clearLog();
    const outcome = await dev.sync();

    expect(outcome.uploaded).toBe(false);
    expect(remote.countRequests('PUT')).toBe(0);
  });

  it('远端内容确实与目标一致时照旧短路，不产生多余写入', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    await dev.sync();

    remote.clearLog();
    const second = await dev.sync();
    expect(second.uploaded).toBe(false);
    expect(remote.countRequests('PUT')).toBe(0);
  });
});

/**
 * ResultCounts 的 uploaded / remote 要如实（审计 L-5）。
 *
 * 原实现无条件写 uploaded: true、remote 一律取自 target，于是无变化短路时同一个
 * CommitOutcome 里 result.uploaded 与 outcome.uploaded 互相矛盾。目前 UI 不读这两个
 * 字段，但留着就是个陷阱。
 */
describe('结果计数如实反映本轮是否写了远端', () => {
  it('真的写了远端时 uploaded 为 true', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    const outcome = await dev.sync();
    expect(outcome.uploaded).toBe(true);
    expect(outcome.result.uploaded).toBe(true);
  });

  it('★ 走无变化短路时 uploaded 为 false，两个字段一致', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });
    await dev.sync();
    const second = await dev.sync();

    expect(second.uploaded).toBe(false);
    expect(second.result.uploaded).toBe(false);
    // 远端计数取自实际读回的远端树，不是目标树。
    expect(second.result.remote).toEqual({ bookmarks: 1, folders: 0 });
  });
});

/**
 * 远端目录被删掉后能自愈（审计 M-11）。
 *
 * ensureContainer 唯一的调用点在 probeStore 里，caps 一旦缓存就不再探测。于是远端
 * 目录被删除或改名后 MKCOL 不会执行，PUT 一直 409，用户看到「服务器错误」。
 * 快路径上不能无条件 MKCOL —— 那会让「无改动的定时同步不产生写流量」（FR-14 的性能
 * 验收项）失效，所以只在真的撞上 409 时重建一次再重试。
 */
describe('远端目录不存在时重建后重试', () => {
  it('★ 本轮第一次写返回 409 时重建目录并最终成功', async () => {
    const remote = new FakeRemote();
    const dev = createDevice(remote, {
      name: 'A',
      local: tree([bk('b-0000000000a1', '甲', 'https://a.test/')]),
    });

    // 只让第一次写历史快照返回 409（WebDAV 用它表达「父集合不存在」）。
    let rejected = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const href = typeof url === 'string' ? url : url.href;
      if (method === 'PUT' && href.includes('/history/') && !rejected) {
        rejected = true;
        return new Response('conflict', { status: 409 });
      }
      return remote.fetch(url as string, init);
    }) as unknown as typeof fetch;

    const store = createWebdavStore(
      { url: 'https://dav.test/dav', username: 'u', password: 'p', basePath: '/bookmark-sync/' },
      { timeoutMs: 1000, maxRetries: 0, fetchImpl, sleep: async () => undefined },
    );

    const outcome = await dev.sync({ kind: 'sync' }, { store });

    expect(rejected).toBe(true);
    expect(outcome.uploaded).toBe(true);
    // 重建目录时发过 MKCOL。
    expect(remote.countRequests('MKCOL')).toBeGreaterThan(0);
    expect(dev.logs.some((l) => l.includes('409'))).toBe(true);
  });
});
