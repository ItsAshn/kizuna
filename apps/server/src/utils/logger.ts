type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = 'info';

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel]) return;

  const timestamp = formatTimestamp();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  fn(`[${timestamp}] [${prefix}] ${message}`, ...args);
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function createLogger(prefix: string) {
  return {
    debug: (message: string, ...args: unknown[]) => log('debug', prefix, message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', prefix, message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', prefix, message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', prefix, message, ...args),
  };
}

export const logger = createLogger('kizuna');
