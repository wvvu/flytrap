import path from "node:path";
import { z } from "zod";
import { defaultPromptsDir } from "./paths.js";

const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"] as const;
const ROLES = ["smtp", "worker", "api"] as const;

const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const draftSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]),
  roles: z.array(z.enum(ROLES)).min(1),
  mailDataDir: z.string().min(1),
  acceptDomains: z.array(z.string()).min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpBanner: z.string().min(1).max(200),
  smtpMaxBytes: z.number().int().min(1024).max(100 * 1024 * 1024),
  smtpTlsKeyFile: z.string().optional(),
  smtpTlsCertFile: z.string().optional(),
  smtpMaxConnPerIp: z.number().int().min(1).max(10_000),
  smtpMaxConnPerMin: z.number().int().min(1).max(100_000),
  smtpMaxDataPerHour: z.number().int().min(1).max(1_000_000),
  apiHost: z.string().min(1),
  apiPort: z.number().int().min(1).max(65535),
  apiUsername: z.string().min(1).max(128),
  apiPassword: z.string().optional(),
  sessionSecret: z.string().optional(),
  classifier: z.enum(["openai-compat", "fake", "gemini"]),
  openaiBaseUrl: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiModel: z.string().optional(),
  geminiApiKeys: z.array(z.string()).default([]),
  geminiModel: z.string().default("gemini-2.5-flash"),
  geminiBaseUrl: z.string().optional(),
  promptsDir: z.string().min(1),
  notifyWebhookUrl: z.string().optional(),
  notifyWebhookBearer: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  notifyLabels: z.array(z.enum(LABELS)).min(1),
  notifyMinConfidence: z.number().min(0).max(1),
  panelBaseUrl: z.string().optional(),
  compress: z.enum(["auto", "zstd", "gzip"]),
  diskAlertBytes: z.number().int().min(0),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  workerPollMs: z.number().int().min(50).max(60_000),
});

export type Config = z.infer<typeof draftSchema> & {
  acceptDomainSet: ReadonlySet<string>;
};

export function parseAcceptDomains(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/\.$/, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ConfigError("ACCEPT_DOMAINS is empty");
  }
  const seen = new Set<string>();
  for (const domain of parts) {
    if (domain.includes("*")) {
      throw new ConfigError(`ACCEPT_DOMAINS rejects wildcards (${domain})`);
    }
    if (!DOMAIN_RE.test(domain)) {
      throw new ConfigError(`ACCEPT_DOMAINS has an invalid domain (${domain})`);
    }
    seen.add(domain);
  }
  return [...seen];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let acceptDomains: string[];
  try {
    acceptDomains = parseAcceptDomains(required(env, "ACCEPT_DOMAINS"));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("ACCEPT_DOMAINS is empty");
  }

  const roles = parseRoles(pick(env, "ROLES", "smtp,worker,api"));
  const draft = {
    nodeEnv: pick(env, "NODE_ENV", "development"),
    roles,
    mailDataDir: path.resolve(pick(env, "MAIL_DATA_DIR", "/srv/mail/data")),
    acceptDomains,
    smtpHost: pick(env, "SMTP_HOST", "0.0.0.0"),
    smtpPort: pickInt(env, "SMTP_PORT", 25),
    smtpBanner: pick(env, "SMTP_BANNER", "mx"),
    smtpMaxBytes: pickInt(env, "SMTP_MAX_BYTES", 20 * 1024 * 1024),
    smtpTlsKeyFile: pickOpt(env, "SMTP_TLS_KEY_FILE"),
    smtpTlsCertFile: pickOpt(env, "SMTP_TLS_CERT_FILE"),
    smtpMaxConnPerIp: pickInt(env, "SMTP_MAX_CONN_PER_IP", 10),
    smtpMaxConnPerMin: pickInt(env, "SMTP_MAX_CONN_PER_MIN", 60),
    smtpMaxDataPerHour: pickInt(env, "SMTP_MAX_DATA_PER_HOUR", 120),
    apiHost: pick(env, "API_HOST", "127.0.0.1"),
    apiPort: pickInt(env, "API_PORT", 8080),
    apiUsername: pick(env, "API_USERNAME", "admin"),
    apiPassword: pickOpt(env, "API_PASSWORD"),
    sessionSecret: pickOpt(env, "SESSION_SECRET"),
    classifier: pick(env, "CLASSIFIER", "openai-compat"),
    openaiBaseUrl: pickOpt(env, "OPENAI_BASE_URL"),
    openaiApiKey: pickOpt(env, "OPENAI_API_KEY"),
    openaiModel: pickOpt(env, "OPENAI_MODEL"),
    geminiApiKeys: parseKeys(pickOpt(env, "GEMINI_API_KEYS") ?? pickOpt(env, "GEMINI_API_KEY") ?? ""),
    geminiModel: pickOpt(env, "GEMINI_MODEL") ?? "gemini-2.5-flash",
    geminiBaseUrl: pickOpt(env, "GEMINI_BASE_URL"),
    promptsDir: path.resolve(pickOpt(env, "PROMPTS_DIR") ?? defaultPromptsDir()),
    notifyWebhookUrl: pickOpt(env, "NOTIFY_WEBHOOK_URL"),
    notifyWebhookBearer: pickOpt(env, "NOTIFY_WEBHOOK_BEARER"),
    telegramBotToken: pickOpt(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: pickOpt(env, "TELEGRAM_CHAT_ID"),
    notifyLabels: parseLabels(pick(env, "NOTIFY_LABELS", "phish,malware")),
    notifyMinConfidence: pickFloat(env, "NOTIFY_MIN_CONFIDENCE", 0.6),
    panelBaseUrl: pickOpt(env, "PANEL_BASE_URL"),
    compress: pick(env, "COMPRESS", "auto"),
    diskAlertBytes: pickInt(env, "DISK_ALERT_BYTES", 0),
    logLevel: pick(env, "LOG_LEVEL", "info"),
    workerPollMs: pickInt(env, "WORKER_POLL_MS", 1000),
  };

  const parsed = draftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ConfigError(formatIssues(parsed.error.issues));
  }
  const config = parsed.data;
  assertRoleRequirements(config);
  return { ...config, acceptDomainSet: new Set(config.acceptDomains) };
}

export function parseKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function assertRoleRequirements(config: z.infer<typeof draftSchema>): void {
  const problems: string[] = [];
  const tlsKey = Boolean(config.smtpTlsKeyFile);
  const tlsCert = Boolean(config.smtpTlsCertFile);
  if (tlsKey !== tlsCert) {
    problems.push("SMTP_TLS_KEY_FILE and SMTP_TLS_CERT_FILE must both be set, or both be empty");
  }
  if (config.roles.includes("api")) {
    if (!config.apiPassword) problems.push("API_PASSWORD is required to start the api role");
    if (!config.sessionSecret) problems.push("SESSION_SECRET is required to start the api role");
    else if (Buffer.byteLength(config.sessionSecret, "utf8") < 32) {
      problems.push("SESSION_SECRET must be at least 32 bytes");
    }
  }
  if (config.roles.includes("worker") && config.classifier === "openai-compat") {
    if (!config.openaiBaseUrl) problems.push("OPENAI_BASE_URL is required for the openai-compat classifier");
    if (!config.openaiApiKey) problems.push("OPENAI_API_KEY is required for the openai-compat classifier");
    if (!config.openaiModel) problems.push("OPENAI_MODEL is required for the openai-compat classifier");
    if (config.openaiBaseUrl && !isHttpUrl(config.openaiBaseUrl)) {
      problems.push("OPENAI_BASE_URL must be an http(s) URL");
    }
  }
  if (config.roles.includes("worker") && config.classifier === "gemini") {
    if (config.geminiApiKeys.length === 0) {
      problems.push("GEMINI_API_KEYS (or GEMINI_API_KEY) is required for the gemini classifier");
    }
  }
  if (config.notifyWebhookUrl && !isHttpUrl(config.notifyWebhookUrl)) {
    problems.push("NOTIFY_WEBHOOK_URL must be an http(s) URL");
  }
  if (config.panelBaseUrl && !isHttpUrl(config.panelBaseUrl)) {
    problems.push("PANEL_BASE_URL must be an http(s) URL");
  }
  if ((config.telegramBotToken && !config.telegramChatId) || (!config.telegramBotToken && config.telegramChatId)) {
    problems.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set, or both be empty");
  }
  if (problems.length > 0) throw new ConfigError(problems.join("\n"));
}

function parseRoles(raw: string): Array<(typeof ROLES)[number]> {
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new ConfigError("ROLES is empty");
  const out: Array<(typeof ROLES)[number]> = [];
  for (const part of parts) {
    if (!ROLES.includes(part as (typeof ROLES)[number])) {
      throw new ConfigError(`ROLES has an unknown role (${part})`);
    }
    if (!out.includes(part as (typeof ROLES)[number])) out.push(part as (typeof ROLES)[number]);
  }
  return out;
}

function parseLabels(raw: string): Array<(typeof LABELS)[number]> {
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const out: Array<(typeof LABELS)[number]> = [];
  for (const part of parts) {
    if (!LABELS.includes(part as (typeof LABELS)[number])) {
      throw new ConfigError(`NOTIFY_LABELS has an unknown label (${part})`);
    }
    if (!out.includes(part as (typeof LABELS)[number])) out.push(part as (typeof LABELS)[number]);
  }
  if (out.length === 0) throw new ConfigError("NOTIFY_LABELS is empty");
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n");
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = pickOpt(env, key);
  if (!value) throw new ConfigError(`${key} is empty`);
  return value;
}

function pick(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return pickOpt(env, key) ?? fallback;
}

function pickOpt(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function pickInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = pickOpt(env, key);
  if (raw === undefined) return fallback;
  return Number(raw);
}

function pickFloat(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = pickOpt(env, key);
  if (raw === undefined) return fallback;
  return Number(raw);
}
