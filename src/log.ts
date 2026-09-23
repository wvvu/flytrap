import pino, { type Logger } from "pino";

export interface AppLog {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
  trace(obj: object, msg?: string): void;
}

const REDACT_PATHS = [
  "password",
  "apiPassword",
  "sessionSecret",
  "authorization",
  "cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "NOTIFY_WEBHOOK_BEARER",
  "API_PASSWORD",
  "SESSION_SECRET",
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
