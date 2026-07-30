/**
 * test/engine/harness.ts —— 组装一台「设备」，用于引擎级集成测试。
 *
 * 一台设备 = FakeBookmarks（本地书签）+ 自己的基线与映射 + 指向共享
 * FakeRemote 的真实 WebDAV store。多台设备共用一个 FakeRemote 就构成
 * 多设备场景（方案 7.2 第 5 条、7.4 崩溃矩阵）。
 *
 * 刻意不替换 store / bookmarks 之外的任何东西：commit.ts、sync.ts、
 * webdav.ts、http.ts、codec.ts、domain 全在测试路径上。
 */

import { DEFAULT_CONFIG } from '../../src/shared/config.js';
import { contentHasher } from '../../src/platform/crypto.js';
import { MappingTable, readLocalTree } from '../../src/platform/bookmarks.js';
import { createWebdavStore } from '../../src/remote/webdav.js';
import { runSync, type EngineDeps, type SyncRequest } from '../../src/engine/sync.js';
import type { CommitOutcome } from '../../src/engine/commit.js';
import type { Roots, Snapshot } from '../../src/domain/tree.js';
import type { Config, GuidMap, Phase, RemoteCaps } from '../../src/shared/types.js';
import { FakeBookmarks, plantRoots } from '../fakes/bookmarks.js';
import type { FakeRemote } from '../fakes/remote.js';

export interface DeviceOptions {
  name?: string;
  /** 初始本地书签树。 */
  local?: Roots;
  /** 远端能力。默认支持条件写。 */
  caps?: Partial<RemoteCaps>;
  config?: Partial<Config>;
  /** 记录日志行，便于断言阶段顺序。 */
  captureLog?: boolean;
}

export interface Device {
  readonly name: string;
  readonly bookmarks: FakeBookmarks;
  readonly mapping: MappingTable;
  /** 每次同步的阶段序列，按发生顺序。 */
  readonly phases: Phase[];
  readonly logs: string[];
  baseline(): Snapshot | undefined;
  /** 直接读回本地树（GUID 形式），用于断言收敛。 */
  readLocal(): Promise<Roots>;
  sync(req?: SyncRequest, over?: Partial<EngineDeps>): Promise<CommitOutcome>;
  /** 基线写入失败注入，用于验证 WRITE_BASELINE 的重试。 */
  failBaselineWrites(times: number): void;
}

let guidCounter = 0;
let nonceCounter = 0;

/** 确定性 GUID / nonce，让失败可复现。 */
export function resetCounters(): void {
  guidCounter = 0;
  nonceCounter = 0;
}

export function createDevice(remote: FakeRemote, options: DeviceOptions = {}): Device {
  const name = options.name ?? 'device';
  const bookmarks = new FakeBookmarks();

  const stored: GuidMap = options.local === undefined ? {} : plantRoots(bookmarks, options.local);
  const persisted: GuidMap = { ...stored };
  const mapping = new MappingTable(stored, async (entries) => {
    Object.assign(persisted, entries);
  });

  const config: Config = { ...DEFAULT_CONFIG, deviceName: name, ...options.config };
  const caps: RemoteCaps = { ifMatch: true, suffix: '.json.gz', probedAt: '', ...options.caps };

  const store = createWebdavStore(
    { url: 'https://dav.test/dav', username: 'u', password: 'p', basePath: '/bookmark-sync/' },
    {
      timeoutMs: 1000,
      maxRetries: 3,
      fetchImpl: remote.fetch,
      sleep: async () => undefined,
      random: () => 0.5,
    },
  );

  let baseline: Snapshot | undefined;
  let baselineFailures = 0;
  const phases: Phase[] = [];
  const logs: string[] = [];

  const deps = (): EngineDeps => ({
    store,
    bookmarks,
    mapping,
    caps,
    config,
    now: () => new Date(Date.UTC(2026, 6, 30, 10, 0, 0, ++nonceCounter)),
    nonce: () => `${name}-nonce-${nonceCounter}`,
    hash: contentHasher,
    // 从 0xe… 起编号，与 fixtures 里 0 开头的 GUID 不可能撞 ——
    // 撞了会表现为「同一个 GUID 出现两次」，而那正是崩溃矩阵要检测的症状，
    // 假阳性会掩盖真问题。
    newGuid: (type) =>
      `${type === 'folder' ? 'f' : 'b'}-${(0xe00000000000 + ++guidCounter).toString(16)}`,
    loadBaseline: async () => baseline,
    saveBaseline: async (snapshot) => {
      if (baselineFailures > 0) {
        baselineFailures--;
        throw new Error('storage 写入失败（注入）');
      }
      baseline = snapshot;
    },
    onPhase: (phase) => {
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    },
    log: {
      info: (m, ...a) => {
        if (options.captureLog === true) logs.push(`INFO ${m} ${a.map(String).join(' ')}`.trim());
      },
      warn: (m, ...a) => {
        logs.push(`WARN ${m} ${a.map(String).join(' ')}`.trim());
      },
    },
  });

  return {
    name,
    bookmarks,
    mapping,
    phases,
    logs,
    baseline: () => baseline,
    readLocal: async () => (await readLocalTree(bookmarks, mapping, () => {
      throw new Error('读回时不应有未映射节点');
    })).roots,
    sync: async (req = { kind: 'sync' }, over = {}) => {
      phases.length = 0;
      return runSync(req, { ...deps(), ...over });
    },
    failBaselineWrites: (times) => {
      baselineFailures = times;
    },
  };
}
