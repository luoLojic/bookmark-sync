/**
 * engine/identity.ts —— 基线与远端的绑定校验（审计 BUG-01）。
 *
 * 基线的语义是「上次与**这个**远端达成一致时的内容」。远端换了地方，它就不再
 * 成立，而三方合并没有任何办法自己发现这件事 —— 传进去的只是三棵树，谁也没
 * 告诉它 base 与 remote 来自不同的服务器。所以只能在进入合并之前拦。
 *
 * 判定刻意做成纯函数：真正容易出错的是三个状态的组合（有没有基线、记过没记过
 * 指纹、指纹一样不一样），而不是读写 storage。
 */

import { RemoteChanged } from '../shared/errors.js';

export type IdentityVerdict =
  /** 可以继续：没有基线，或基线确实属于当前远端。 */
  | { t: 'ok' }
  /** 有基线但没记过指纹（旧版本升级上来）：补记为当前远端。 */
  | { t: 'adopt' }
  /** 基线属于别的远端：中止。 */
  | { t: 'mismatch'; stored: string };

export function judgeIdentity(input: {
  hasBaseline: boolean;
  stored: string | undefined;
  current: string;
}): IdentityVerdict {
  // 没有基线时谈不上「属于谁」。首次同步照常走，指纹会随第一次提交落盘。
  if (!input.hasBaseline) return { t: 'ok' };
  if (input.stored === undefined) return { t: 'adopt' };
  if (input.stored === input.current) return { t: 'ok' };
  return { t: 'mismatch', stored: input.stored };
}

export interface IdentityDeps {
  hasBaseline: () => Promise<boolean>;
  getStored: () => Promise<string | undefined>;
  /** 仅 adopt 分支调用。 */
  adopt: (identity: string) => Promise<void>;
  log?: { warn: (m: string, ...a: unknown[]) => void };
}

/**
 * 双向同步前的校验。mismatch 抛 RemoteChanged（Fatal，不清任何状态）。
 *
 * 为什么 adopt 分支选择放行而不是一并拦住：升级到带指纹的版本时，每个已有
 * 基线都没有指纹。把它们全判成「远端变了」会要求所有老用户重置一次同步状态，
 * 而绝大多数人的远端根本没变。此刻能拿到的最好证据就是当前配置，补记下来，
 * 之后的每一次改动都在保护范围内。这一条只在「升级前就已经换过远端、升级后
 * 第一次同步」这个窗口里失效，而那个窗口里远端为空的情形仍由
 * RemoteSnapshotMissing 拦着。
 */
export async function assertBaselineBelongsTo(current: string, deps: IdentityDeps): Promise<void> {
  const verdict = judgeIdentity({
    hasBaseline: await deps.hasBaseline(),
    stored: await deps.getStored(),
    current,
  });

  if (verdict.t === 'mismatch') {
    deps.log?.warn('基线属于另一个远端，双向同步已中止（改用上传或下载可重新绑定）');
    throw new RemoteChanged();
  }
  if (verdict.t === 'adopt') {
    deps.log?.warn('基线没有远端指纹（旧版本写入），补记为当前远端');
    await deps.adopt(current);
  }
}
