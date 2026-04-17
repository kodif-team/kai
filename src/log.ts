export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => never;
};

const MAX_FIELD_LENGTH = 400;
const MAX_MESSAGE_LENGTH = 1200;

function truncate(value: unknown, limit = MAX_FIELD_LENGTH): unknown {
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => truncate(item, limit));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncate(item, limit);
    }
    return out;
  }
  return value;
}

function encode(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>): string {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component,
    message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
    ...(meta ? { meta: truncate(meta) } : {}),
  };
  return JSON.stringify(payload);
}

export function errorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  return { errorValue: String(error) };
}

export function createLogger(component: string, level: LogLevel): Logger {
  const enabled = {
    [LogLevel.Debug]: level === LogLevel.Debug,
    [LogLevel.Info]: level === LogLevel.Debug || level === LogLevel.Info,
    [LogLevel.Warn]: true,
    [LogLevel.Error]: true,
  };

  const outputFor = {
    [LogLevel.Debug]: console.log,
    [LogLevel.Info]: console.log,
    [LogLevel.Warn]: console.log,
    [LogLevel.Error]: console.error,
  };

  const write = (lvl: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (!enabled[lvl]) return;
    outputFor[lvl](encode(lvl, component, message, meta));
  };

  return {
    debug: (message, meta) => write(LogLevel.Debug, message, meta),
    info: (message, meta) => write(LogLevel.Info, message, meta),
    warn: (message, meta) => write(LogLevel.Warn, message, meta),
    error: (message, meta) => write(LogLevel.Error, message, meta),
    fatal: (message, meta): never => {
      write(LogLevel.Error, message, meta);
      throw new Error(message);
    },
  };
}

export function parseLogLevel(raw: string): LogLevel {
  const level = raw.trim().toLowerCase();
  if (level === LogLevel.Debug) return LogLevel.Debug;
  if (level === LogLevel.Info) return LogLevel.Info;
  if (level === LogLevel.Warn) return LogLevel.Warn;
  if (level === LogLevel.Error) return LogLevel.Error;
  throw new Error(`Invalid log level: ${raw}`);
}
