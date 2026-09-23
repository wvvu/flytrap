import { loadCodec } from "./compress.js";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { dbFile, openDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { createLogger } from "./log.js";
import { ensureDataDirs, migrationsDir } from "./paths.js";
import { fakeClassifier } from "./ai/classifier.js";
import { createOpenAiClassifier } from "./ai/openai-compat.js";
import { readPrompt } from "./ai/prompt.js";
import { createMailauthAuthenticator } from "./mail/auth.js";
import { createTelegramNotifier } from "./notify/telegram.js";
import { createWebhookNotifier } from "./notify/webhook.js";
import type { Notifier } from "./notify/types.js";
import { startApi } from "./api/app.js";
import { startSmtp, type RunningSmtp } from "./smtp/server.js";
import { startWorker } from "./worker/loop.js";

// `--check` validates the environment, migrates, and exits.

const bootLog = createLogger(process.env.LOG_LEVEL?.trim() || "info");

const config: Config = (() => {
  try {
    return loadConfig(process.env);
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : "invalid configuration";
    bootLog.fatal({ err: message }, "refusing to start");
    process.exit(1);
  }
})();

const log = createLogger(config.logLevel);

if (process.argv.includes("--rebuild") || process.argv.includes("--import-history")) {
  log.error("that command is not implemented yet");
  process.exit(1);
}

ensureDataDirs(config.mailDataDir);
const db = openDatabase(dbFile(config.mailDataDir));
const applied = migrate(db, migrationsDir());
log.info({ applied, roles: config.roles }, "database ready");

if (process.argv.includes("--check")) {
  db.close();
  process.exit(0);
}

const stops: Array<() => Promise<void>> = [];
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  for (const stop of stops) {
    try {
      await stop();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : "stop failed" }, "shutdown step failed");
    }
  }
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function boot(): Promise<void> {
  const needsCodec = config.roles.includes("smtp") || config.roles.includes("worker") || config.roles.includes("api");
  const codec = needsCodec ? await loadCodec(config.compress, log) : undefined;
  if (config.roles.includes("smtp")) {
    const smtp: RunningSmtp = await startSmtp({ config, db, codec: codec!, log });
    stops.push(() => smtp.close());
  }
  if (config.roles.includes("worker")) {
    readPrompt(config.promptsDir);
    if (config.classifier === "fake" && config.nodeEnv === "production") {
      log.warn("CLASSIFIER=fake is running in production");
    }
    const classifier =
      config.classifier === "fake"
        ? fakeClassifier()
        : createOpenAiClassifier({
            baseUrl: config.openaiBaseUrl ?? "",
            apiKey: config.openaiApiKey ?? "",
            model: config.openaiModel ?? "",
          });
    const notifiers: Notifier[] = [];
    if (config.notifyWebhookUrl) {
      notifiers.push(createWebhookNotifier({ url: config.notifyWebhookUrl, bearer: config.notifyWebhookBearer }));
    }
    if (config.telegramBotToken && config.telegramChatId) {
      notifiers.push(createTelegramNotifier({ token: config.telegramBotToken, chatId: config.telegramChatId }));
    }
    const worker = await startWorker({
      db,
      dataDir: config.mailDataDir,
      codec: codec!,
      banner: config.smtpBanner,
      log,
      authenticate: createMailauthAuthenticator(),
      classifier,
      notifiers,
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      promptsDir: config.promptsDir,
      panelBaseUrl: config.panelBaseUrl ?? `http://127.0.0.1:${config.apiPort}`,
      pollMs: config.workerPollMs,
    });
    stops.push(() => worker.close());
    log.info({ workerId: worker.workerId, classifier: classifier.id, notifiers: notifiers.map((item) => item.id) }, "worker started");
  }
  if (config.roles.includes("api")) {
    const api = await startApi({ config, db, codec: codec!, log });
    stops.push(() => api.close());
    log.info({ host: config.apiHost, port: api.port }, "api listening");
  }
  const pending = config.roles.filter((role) => role !== "smtp" && role !== "worker" && role !== "api");
  if (pending.length > 0) log.info({ pending }, "roles not started yet");
  if (stops.length === 0) {
    db.close();
  }
}

boot().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : "boot failed" }, "refusing to start");
  try {
    db.close();
  } catch {
    // already closed
  }
  process.exit(1);
});
