/**
 * shared/logger.ts —— 环形缓冲日志（NFR-9）。
 *
 * 内存中保留最近 LOG_CAPACITY 条，批量 flush 到 storage，可在设置页导出。
 * 凭据与 URL query 串一律脱敏（方案第 11 节「日志规范」，有单测）。
 */

import { LOG_CAPACITY } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  /** 把整个环形缓冲写入持久层。实现方需自行容错。 */
  persist(lines: string[]): void | Promise<void>;
}

/** 需要整体抹掉值的字段名（大小写不敏感）。 */
const SECRET_KEYS = [
  'password',
  'passwd',
  'pass',
  'secret',
  'secretkey',
  'secretaccesskey',
  'accesskey',
  'accesskeyid',
  'token',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'signature',
  'x-amz-signature',
  'sig',
  'apikey',
  'api_key',
];

const SECRET_KEY_RE = new RegExp(
  // 覆盖四种写法：
  //   key=value        请求参数与手写日志
  //   key: value       yaml 风格
  //   key="value"      带引号
  //   "key": "value"   JSON.stringify 的产物 —— 键名自带闭引号，
  //                    少了下面那个 `"?` 就会整条漏过去
  `\\b(${SECRET_KEYS.join('|')})\\b"?\\s*[:=]\\s*("[^"]*"|'[^']*'|[^\\s,;&)}\\]]+)`,
  'gi',
);

const BASIC_AUTH_RE = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/g;
/** URL 中的 userinfo：scheme://user:pass@host */
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^/\s@]*)?@/gi;
/** URL 的 query 串整体脱敏（可能含预签名参数）。 */
const URL_QUERY_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s"'）)]*/gi;

/** 对任意文本做凭据脱敏。纯函数，供单测直接调用。 */
export function redact(text: string): string {
  return text
    .replace(URL_USERINFO_RE, (_m, scheme: string, user: string) => `${scheme}${user}:***@`)
    .replace(URL_QUERY_RE, (_m, base: string) => `${base}?***`)
    .replace(BASIC_AUTH_RE, (_m, scheme: string) => `${scheme} ***`)
    .replace(SECRET_KEY_RE, (_m, key: string) => `${key}=***`);
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (a === undefined) return 'undefined';
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

export class Logger {
  private buf: string[] = [];
  private sink: LogSink | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private runId = '-';
  private phase = '-';
  private mirrorToConsole = true;

  constructor(private capacity: number = LOG_CAPACITY) {}

  setSink(sink: LogSink | undefined): void {
    this.sink = sink;
  }

  setConsoleMirror(on: boolean): void {
    this.mirrorToConsole = on;
  }

  /** 同步运行上下文：每条日志带 runId 与 phase 前缀，便于导出后定位。 */
  setContext(ctx: { runId?: string; phase?: string }): void {
    if (ctx.runId !== undefined) this.runId = ctx.runId;
    if (ctx.phase !== undefined) this.phase = ctx.phase;
  }

  clearContext(): void {
    this.runId = '-';
    this.phase = '-';
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write('debug', msg, args);
  }
  info(msg: string, ...args: unknown[]): void {
    this.write('info', msg, args);
  }
  warn(msg: string, ...args: unknown[]): void {
    this.write('warn', msg, args);
  }
  error(msg: string, ...args: unknown[]): void {
    this.write('error', msg, args);
  }

  private write(level: LogLevel, msg: string, args: unknown[]): void {
    const parts = args.length > 0 ? `${msg} ${args.map(stringifyArg).join(' ')}` : msg;
    const line = redact(
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.runId}][${this.phase}] ${parts}`,
    );
    this.buf.push(line);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    this.dirty = true;
    if (this.mirrorToConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(line);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.sink === undefined || this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 1000);
  }

  /** 立即落盘。同步流程的每个阶段边界都应调用一次。 */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty || this.sink === undefined) return;
    this.dirty = false;
    try {
      await this.sink.persist([...this.buf]);
    } catch {
      // 日志落盘失败不得影响任何业务流程。
    }
  }

  lines(): string[] {
    return [...this.buf];
  }

  /** 从持久层恢复（worker 重启后仍能导出上次的日志）。 */
  hydrate(lines: string[]): void {
    if (this.buf.length > 0) return;
    this.buf = lines.slice(-this.capacity);
  }

  clear(): void {
    this.buf = [];
    this.dirty = true;
  }

  export(): string {
    return this.buf.join('\n');
  }
}

/** 全局单例。UI 与后台各自持有独立实例（不同 JS 上下文）。 */
export const log = new Logger();
