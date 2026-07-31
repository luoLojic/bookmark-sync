/**
 * shared/errors.ts —— 错误模型（技术规划方案第 6 节 / 红线三）。
 *
 * 每个错误必须归入 Transient / Fatal / UserActionRequired 三类之一，由基类强制。
 * 清除本地状态的分支只允许出现在 UserActionRequired 处理路径（INV-3）。
 */

export type ErrorClass = 'transient' | 'fatal' | 'userAction';

export type ErrorCode =
  // transient
  | 'network'
  | 'timeout'
  | 'server'
  | 'rateLimited'
  | 'conflict'
  | 'aborted'
  // fatal
  | 'auth'
  | 'notFound'
  | 'misconfigured'
  | 'verification'
  | 'protocol'
  | 'busy'
  | 'remoteSnapshotMissing'
  | 'remoteChanged'
  | 'internal'
  // userAction
  | 'deleteGuard'
  | 'firstSyncChoice'
  | 'formatVersionTooNew';

export interface SerializedError {
  code: ErrorCode;
  klass: ErrorClass;
  message: string;
  /** i18n key，UI 优先用它渲染。 */
  messageKey?: string;
  messageArgs?: string[];
  detail?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly klass: ErrorClass;
  abstract readonly code: ErrorCode;
  readonly messageKey?: string;
  readonly messageArgs?: string[];

  constructor(message: string, opts?: { messageKey?: string; messageArgs?: string[]; cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (opts?.messageKey !== undefined) this.messageKey = opts.messageKey;
    if (opts?.messageArgs !== undefined) this.messageArgs = opts.messageArgs;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }

  /** 供 UI 传输的可序列化形式。子类可覆盖以附带 detail。 */
  serialize(): SerializedError {
    const out: SerializedError = { code: this.code, klass: this.klass, message: this.message };
    if (this.messageKey !== undefined) out.messageKey = this.messageKey;
    if (this.messageArgs !== undefined) out.messageArgs = this.messageArgs;
    return out;
  }
}

// ── Transient：重试即可，绝不清状态（INV-3） ───────────────────────────

export abstract class TransientError extends AppError {
  readonly klass = 'transient' as const;
}

/**
 * 每个会走到界面的错误都带 messageKey：NFR-11 要求全部界面文字经
 * chrome.i18n 取得，直接把英文的 message 显示给用户就破了这条。
 */
export class NetworkError extends TransientError {
  readonly code = 'network' as const;
  override readonly messageKey = 'errNetwork';
}

export class TimeoutError extends TransientError {
  readonly code = 'timeout' as const;
  override readonly messageKey = 'errTimeout';
}

export class ServerError extends TransientError {
  readonly code = 'server' as const;
  override readonly messageKey = 'errServer';
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

export class RateLimited extends TransientError {
  readonly code = 'rateLimited' as const;
  override readonly messageKey = 'errServer';
  constructor(readonly retryAfterMs?: number) {
    super('HTTP 429');
  }
}

/** 412：其他设备已提交，回到 READ 重新合并（FR-17）。 */
export class ConflictError extends TransientError {
  readonly code = 'conflict' as const;
  override readonly messageKey = 'errConflictExhausted';
  constructor(message = 'precondition failed') {
    super(message);
  }
}

/** 用户取消：原子提交点之前按瞬时错误处理，不清任何状态（方案 4 要点 4）。 */
export class AbortedError extends TransientError {
  readonly code = 'aborted' as const;
  constructor() {
    super('aborted by user', { messageKey: 'errAborted' });
  }
}

// ── Fatal：本次失败，报给用户，不清状态 ───────────────────────────────

export abstract class FatalError extends AppError {
  readonly klass = 'fatal' as const;
}

export class AuthError extends FatalError {
  readonly code = 'auth' as const;
  constructor(readonly status: number) {
    super(`HTTP ${status}`, { messageKey: 'errAuth' });
  }
}

export class NotFoundError extends FatalError {
  readonly code = 'notFound' as const;
  constructor(readonly path: string) {
    super(`not found: ${path}`, { messageKey: 'errNotFound', messageArgs: [path] });
  }
}

export class MisconfiguredError extends FatalError {
  readonly code = 'misconfigured' as const;
}

/** 写后校验不通过、内容截断（NFR-4）。 */
export class VerificationError extends FatalError {
  readonly code = 'verification' as const;
  override readonly messageKey = 'errVerification';
}

/** 快照格式损坏、JSON 解析失败。 */
export class ProtocolError extends FatalError {
  readonly code = 'protocol' as const;
  override readonly messageKey = 'errProtocol';
}

/** NFR-10 单实例：已有同步在运行。 */
export class BusyError extends FatalError {
  readonly code = 'busy' as const;
  constructor() {
    super('another sync is running', { messageKey: 'errBusy' });
  }
}

/**
 * 本设备有基线，但远端快照文件读不到。
 *
 * 这不是「远端把书签删空了」，而是「本设备的基线不属于这个远端」：换了地址、
 * 改了基础路径、远端文件被删、路径填错一个字符都会走到这里。若按空树参与三方
 * 合并，所有自上次同步以来未改动过的条目都会被判成「仅远端删」而删掉本地，
 * 且总数 ≤ 10 时连删除保护都不触发。所以必须中止并让用户判断。
 */
export class RemoteSnapshotMissing extends FatalError {
  readonly code = 'remoteSnapshotMissing' as const;
  override readonly messageKey = 'errRemoteMissing';
  constructor() {
    super('remote snapshot missing while a baseline exists');
  }
}

/**
 * 远端配置已换过地方，本设备的基线属于旧远端。
 *
 * 与 RemoteSnapshotMissing 互补：那条拦的是「新远端什么都没有」，这条拦的是
 * 「新远端自己有一份别的快照」。后者更隐蔽 —— 三方合并会拿旧远端的基线去比
 * 新远端的内容，凡是「基线有、本地未改、新远端没有」的条目都被判成远端删除，
 * 反过来新远端独有的条目又会在下一轮被本地判成删除。两侧都产生凭空的删除，
 * 而删除保护要求条数与比例同时超标才拦得住。
 *
 * 只拦双向同步。上传与下载的目标树不取自基线（分别是本地树与远端树），因此
 * 它们既安全、又正好是用户重新绑定远端的出口：提交成功后基线会连同新指纹一起
 * 落盘。消息文案要把这两条出路讲清楚。
 */
export class RemoteChanged extends FatalError {
  readonly code = 'remoteChanged' as const;
  override readonly messageKey = 'errRemoteChanged';
  constructor() {
    super('baseline belongs to a different remote');
  }
}

export class InternalError extends FatalError {
  readonly code = 'internal' as const;
  override readonly messageKey = 'errUnknown';
  constructor(message: string, opts?: { cause?: unknown }) {
    // errUnknown 带一个占位符，把原始信息填进去 —— 未知错误至少要让用户
    // 看到能复制给我们的线索，而不是一句「未知错误」。
    super(message, { messageArgs: [message], ...(opts ?? {}) });
  }
}

// ── UserActionRequired ───────────────────────────────────────────────

export abstract class UserActionRequiredError extends AppError {
  readonly klass = 'userAction' as const;
}

export interface GuardItem {
  title: string;
  url?: string;
  path: string;
}

export interface DeleteGuardDetail {
  side: 'local' | 'remote' | 'both';
  localDeletes: number;
  localTotal: number;
  remoteDeletes: number;
  remoteTotal: number;
  items: GuardItem[];
  itemsTruncated: number;
}

/** FR-10。 */
export class DeleteGuardTripped extends UserActionRequiredError {
  readonly code = 'deleteGuard' as const;
  constructor(readonly detail: DeleteGuardDetail) {
    super('delete guard tripped', { messageKey: 'errDeleteGuard' });
  }
  override serialize(): SerializedError {
    return { ...super.serialize(), detail: this.detail };
  }
}

export interface FirstSyncDetail {
  localBookmarks: number;
  localFolders: number;
  remoteBookmarks: number;
  remoteFolders: number;
  mergedBookmarks: number;
  mergedFolders: number;
}

/** FR-4。 */
export class FirstSyncChoiceRequired extends UserActionRequiredError {
  readonly code = 'firstSyncChoice' as const;
  constructor(readonly detail: FirstSyncDetail) {
    super('first sync choice required', { messageKey: 'errFirstSync' });
  }
  override serialize(): SerializedError {
    return { ...super.serialize(), detail: this.detail };
  }
}

/**
 * INV-3：这是唯一允许重置基线的错误。
 * 全局 clearBaseline 的调用点只应有两处：此错误的处理路径，与用户显式重置。
 */
export class FormatVersionTooNew extends UserActionRequiredError {
  readonly code = 'formatVersionTooNew' as const;
  constructor(readonly remoteVersion: number) {
    super(`remote formatVersion ${remoteVersion} is newer than supported`, {
      messageKey: 'errFormatTooNew',
      messageArgs: [String(remoteVersion)],
    });
  }
  override serialize(): SerializedError {
    return { ...super.serialize(), detail: { remoteVersion: this.remoteVersion } };
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function isTransient(e: unknown): boolean {
  return e instanceof AppError && e.klass === 'transient';
}

export function serializeError(e: unknown): SerializedError {
  if (isAppError(e)) return e.serialize();
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'internal', klass: 'fatal', message };
}

/**
 * 把任意异常收敛为 AppError。未知异常一律按 Fatal 处理 ——
 * 宁可要求用户重试，也不让未知错误走上清状态的分支。
 *
 * ★ 这里刻意**不**把 TypeError 归成 NetworkError。
 *
 * fetch 确实把 DNS、连接中断、CORS 一律报成 TypeError，但那些已经由
 * platform/http.ts 的 classifyFetchError 在 transport 层就地归类了。留一条
 * 兜底的 TypeError → NetworkError 只会掩盖真正的问题：畸形远端数据引发的
 * 「读 undefined 的属性」也是 TypeError，被归成瞬时错误后，用户看到的是
 * 「网络错误」而不是「远端数据格式不正确」，这正是红线三要防的错分类。
 * 程序性错误按 Fatal 报出去，才有人去修。
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof DOMException && e.name === 'AbortError') return new AbortedError();
  return new InternalError(e instanceof Error ? e.message : String(e), { cause: e });
}
