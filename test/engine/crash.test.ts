/**
 * test/engine/crash.test.ts —— 崩溃注入矩阵（方案 7.4 / INV-4 的验收依据）。
 *
 * 在提交协议的 9 个步骤之间各设一个注入点，× 3 种改动方向（仅本地改 /
 * 仅远端改 / 双改）= 27 个用例。每个用例的判定都一样：崩溃之后再跑一次
 * 完整同步，结果必须收敛，且无丢失、无重复。
 *
 * INV-4 的三个崩溃点分别落在：
 *   应用本地改动的中途        → crashAfterOps
 *   应用之后、远端 PUT 之前   → crashAfter: 'putBookmarks'（在 PUT 前抛）
 *   远端 PUT 成功、写基线之前 → crashAfter: 'verify' / 'putIndex' / 'writeBaseline'
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { decodeSnapshot } from '../../src/remote/codec.js';
import { canonicalize } from '../../src/domain/hash.js';
import { indexRoots, type Roots } from '../../src/domain/tree.js';
import { resetMemoryLock } from '../../src/engine/lock.js';
import type { Phase } from '../../src/shared/types.js';
import { bk, tree } from '../fixtures/trees.js';
import { FakeRemote } from '../fakes/remote.js';
import { createDevice, resetCounters, type Device } from './harness.js';

const content = (roots: Roots): string => canonicalize(roots);

beforeEach(() => {
  resetMemoryLock();
  resetCounters();
});

/** 读出远端当前快照的内容，用于三方一致性断言。 */
async function remoteContent(remote: FakeRemote): Promise<string | null> {
  const key = remote.paths().find((p) => p.endsWith('bookmarks.json.gz'));
  if (key === undefined) return null;
  const snapshot = await decodeSnapshot(remote.read(key)!);
  return canonicalize(snapshot.roots);
}

/** 节点没有重复出现 —— 重复是 floccus 缺陷二的典型症状。 */
function assertNoDuplicates(roots: Roots): void {
  const seen = new Set<string>();
  let count = 0;
  const walk = (children: Roots['bar']['children']): void => {
    for (const node of children) {
      count++;
      expect(seen.has(node.guid), `重复 GUID ${node.guid}`).toBe(false);
      seen.add(node.guid);
      if (node.type === 'folder') walk(node.children);
    }
  };
  walk(roots.bar.children);
  walk(roots.other.children);
  expect(seen.size).toBe(count);
  expect(indexRoots(roots).size).toBe(count);
}

type Direction = 'localOnly' | 'remoteOnly' | 'both';

/**
 * 搭一个「两台设备已同步、随后按 direction 各自改动」的局面。
 * 返回 A 设备（待崩溃的那台）与共享远端。
 */
async function scenario(direction: Direction): Promise<{
  remote: FakeRemote;
  a: Device;
  b: Device;
  /** 改动完成后，本应出现在最终结果里的标题集合。 */
  expected: string[];
}> {
  const remote = new FakeRemote();
  const base = tree([
    bk('b-000000000001', '共同一', 'https://c1.test/'),
    bk('b-000000000002', '共同二', 'https://c2.test/'),
  ]);

  const a = createDevice(remote, { name: 'A', local: base });
  await a.sync();
  const b = createDevice(remote, { name: 'B' });
  await b.sync();

  const expected = ['共同一', '共同二'];

  if (direction === 'localOnly' || direction === 'both') {
    a.bookmarks.seed(a.bookmarks.barId, { title: 'A 新增', url: 'https://a-new.test/' });
    expected.push('A 新增');
  }
  if (direction === 'remoteOnly' || direction === 'both') {
    b.bookmarks.seed(b.bookmarks.barId, { title: 'B 新增', url: 'https://b-new.test/' });
    await b.sync();
    expected.push('B 新增');
  }

  return { remote, a, b, expected };
}

/** 崩溃点：8 个阶段注入 + 1 个「应用中途」注入 = 9 个（方案 7.4）。 */
const CRASH_POINTS: { label: string; inject: Record<string, unknown> }[] = [
  { label: 'read', inject: { crashAfter: 'read' as Phase } },
  { label: 'merge', inject: { crashAfter: 'merge' as Phase } },
  { label: 'guard', inject: { crashAfter: 'guard' as Phase } },
  { label: 'applyLocal（中途）', inject: { crashAfterOps: 1 } },
  { label: 'putHistory', inject: { crashAfter: 'putHistory' as Phase } },
  { label: 'putBookmarks（★之前）', inject: { crashAfter: 'putBookmarks' as Phase } },
  { label: 'verify（★之后）', inject: { crashAfter: 'verify' as Phase } },
  { label: 'putIndex', inject: { crashAfter: 'putIndex' as Phase } },
  { label: 'writeBaseline', inject: { crashAfter: 'writeBaseline' as Phase } },
];

const DIRECTIONS: Direction[] = ['localOnly', 'remoteOnly', 'both'];

describe('崩溃注入矩阵：9 个崩溃点 × 3 种改动方向（方案 7.4）', () => {
  for (const point of CRASH_POINTS) {
    for (const direction of DIRECTIONS) {
      it(`在 ${point.label} 崩溃后（${direction}）重跑收敛且无丢失无重复`, async () => {
        const { remote, a, b, expected } = await scenario(direction);

        // 第一次同步注入崩溃。有些崩溃点在特定方向下根本到不了
        // （例如 localOnly 时远端没变化，会走无变化短路），那时不抛错也正常。
        await a.sync({ kind: 'sync' }, point.inject).catch(() => undefined);

        // 重跑一次完整同步。
        await a.sync();

        const localA = await a.readLocal();
        assertNoDuplicates(localA);

        // 标题集合完全一致 —— 少一个是丢失，多一个是重复。
        expect([...localA.bar.children.map((c) => c.title)].sort()).toEqual([...expected].sort());

        // 三方内容一致：A 本地 == 远端；B 再同步一次后也一致。
        expect(content(localA)).toBe(await remoteContent(remote));
        await b.sync();
        expect(content(await b.readLocal())).toBe(content(localA));
      });
    }
  }
});

describe('崩溃后的状态不变量（INV-1 / INV-2 / INV-3）', () => {
  it('★ 之前崩溃：远端未写、基线仍是旧的', async () => {
    const { remote, a } = await scenario('localOnly');
    const before = a.baseline()!.version;
    remote.clearLog();

    await a.sync({ kind: 'sync' }, { crashAfter: 'putBookmarks' }).catch(() => undefined);

    // 历史快照可能已写（步骤 5 先于 6，方案说它是无害的孤儿文件），
    // 但 bookmarks 本体绝不能被写。
    const wrote = remote.log.filter((r) => r.method === 'PUT').map((r) => r.path);
    expect(wrote.some((p) => p.endsWith('bookmarks.json.gz'))).toBe(false);
    expect(a.baseline()!.version).toBe(before);
  });

  it('★ 之后崩溃：远端已提交而基线仍是旧的，下次同步只补基线', async () => {
    // INV-4 的第三个崩溃点。合并会得出 merge(旧base, T, T) = T → 空操作。
    const { remote, a } = await scenario('localOnly');
    await a.sync({ kind: 'sync' }, { crashAfter: 'verify' }).catch(() => undefined);

    const committed = await remoteContent(remote);
    expect(committed).not.toBeNull();

    const outcome = await a.sync();
    expect(outcome.uploaded).toBe(false);
    expect(content(await a.readLocal())).toBe(committed);
  });

  it('应用本地改动中途崩溃：已创建的条目不会被重复创建（INV-2）', async () => {
    const remote = new FakeRemote();
    // 远端先有 3 条，本地为空 → 同步会在本地创建 3 条。
    const seedDevice = createDevice(remote, {
      name: 'seed',
      local: tree([
        bk('b-000000000001', '一', 'https://1.test/'),
        bk('b-000000000002', '二', 'https://2.test/'),
        bk('b-000000000003', '三', 'https://3.test/'),
      ]),
    });
    await seedDevice.sync();

    const fresh = createDevice(remote, { name: 'fresh' });
    // 建到第 2 条时崩溃。
    await fresh.sync({ kind: 'sync' }, { crashAfterOps: 2 }).catch(() => undefined);
    const afterCrash = fresh.bookmarks.titlesOf(fresh.bookmarks.barId);
    expect(afterCrash.length).toBeGreaterThan(0);
    expect(afterCrash.length).toBeLessThan(3);

    // 重跑时基线仍不存在（★ 从未到达），而两侧都有内容 —— 按 FR-4 这确实是
    // 「首次同步」，引擎要求用户选择。选「合并」后，需求 6.4 的按 URL 匹配
    // 正是这里防止重复的机制。
    await expect(fresh.sync()).rejects.toMatchObject({ code: 'firstSyncChoice' });
    await fresh.sync({ kind: 'sync', firstSyncChoice: 'merge' });

    const titles = fresh.bookmarks.titlesOf(fresh.bookmarks.barId);
    expect(titles.sort()).toEqual(['一', '三', '二']);
    assertNoDuplicates(await fresh.readLocal());
  });

  it('瞬时错误不清基线也不清映射（INV-3）', async () => {
    const { a } = await scenario('localOnly');
    const baselineBefore = a.baseline();
    const mappingSize = a.bookmarks.size;

    // 注入一个纯网络故障：所有请求都失败。
    await a
      .sync({ kind: 'sync' }, {
        store: {
          get: async () => {
            throw new (await import('../../src/shared/errors.js')).NetworkError('断网');
          },
          put: async () => ({}),
          remove: async () => undefined,
          list: async () => [],
          ensureContainer: async () => undefined,
        },
      })
      .catch(() => undefined);

    expect(a.baseline()).toEqual(baselineBefore);
    expect(a.bookmarks.size).toBe(mappingSize);
  });
});
