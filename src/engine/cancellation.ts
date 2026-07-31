/**
 * engine/cancellation.ts —— 取消的作用域闸门（方案 4 要点 4 / 审计 M-1）。
 *
 * 方案第 4 节写明：★ PUT bookmarks 成功之后忽略取消请求，必须走完到终态。
 * commit.ts 确实把 abortIfRequested() 全部停在 ★ 之前了，但那只管住了引擎自己
 * 的检查点 —— transport 拿到的是同一个 AbortSignal，platform/http.ts 在每次尝试
 * 开始时都查 signal.aborted，于是用户在 PUT 已成功、VERIFY 未完成时点取消，
 * 校验的 GET 会抛 AbortedError，它既不是 ConflictError 也不是 VerificationError，
 * runCommit 不重试，WRITE_BASELINE 直接被跳过。
 *
 * 后果不是丢数据（下一轮落在「仅本地改动」分支会重走一遍完整提交并收敛），而是
 * INV-1 最危险的那个窗口 ——「远端已提交、基线未写」—— 被人为延长，PUT_INDEX 也
 * 会被同一个信号打断。
 *
 * 因此把「用户取消」与「传给 HTTP 的取消」分成两个信号，中间加一道闸门：
 * ★ 之后 seal()，此后用户再点取消也不再传导到网络层。超时不受影响 —— 它在
 * http.ts 里是另一个 AbortController，本来就与用户取消分开。
 */

export interface CancellationGate {
  /** 交给 engine 的信号。★ 之前的 abortIfRequested() 看它。 */
  readonly userSignal: AbortSignal;
  /** 交给 transport 的信号。seal() 之后不再随用户取消而中止。 */
  readonly httpSignal: AbortSignal;
  /** 用户点了取消。 */
  cancel(): void;
  /** ★ 已成功：此后取消不再传导到网络层。可重复调用。 */
  seal(): void;
  readonly sealed: boolean;
  readonly cancelled: boolean;
}

export function createCancellationGate(): CancellationGate {
  const user = new AbortController();
  const http = new AbortController();
  let sealed = false;

  // once: true 就够了 —— AbortSignal 只会 abort 一次。
  user.signal.addEventListener(
    'abort',
    () => {
      if (!sealed) http.abort();
    },
    { once: true },
  );

  return {
    userSignal: user.signal,
    httpSignal: http.signal,
    cancel: () => user.abort(),
    seal: () => {
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
    get cancelled() {
      return user.signal.aborted;
    },
  };
}
