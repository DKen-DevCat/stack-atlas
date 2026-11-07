import type { Logger } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** console に出すロガー。debug / info は stdout、warn / error は stderr */
export function createConsoleLogger(opts: { level?: LogLevel } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const emit = (level: LogLevel, write: (m: string) => void, prefix: string) => (msg: string) => {
    if (ORDER[level] >= min) write(`${prefix}${msg}`);
  };
  return {
    debug: emit('debug', console.log, '  '),
    info: emit('info', console.log, ''),
    warn: emit('warn', console.warn, '⚠ '),
    error: emit('error', console.error, '✗ '),
  };
}

export interface LogRecord {
  level: LogLevel;
  msg: string;
}

/** メモリに貯めるロガー（テスト用） */
export function createMemoryLogger(): Logger & {
  records: LogRecord[];
  of(level: LogLevel): string[];
} {
  const records: LogRecord[] = [];
  const push = (level: LogLevel) => (msg: string) => {
    records.push({ level, msg });
  };
  return {
    records,
    of: (level) => records.filter((r) => r.level === level).map((r) => r.msg),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

/** 何も出さないロガー */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
