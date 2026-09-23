import { hostname } from "node:os";
import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { claimJob, completeJob, failJob, recoverRunning, requeueJob, type JobRow } from "../db/repos/jobs.js";
import { markMessageError } from "../db/repos/messages.js";
import type { Codec } from "../compress.js";
import type { Classifier } from "../ai/classifier.js";
import type { AppLog } from "../log.js";
import type { Authenticator } from "../mail/auth.js";
import type { Notifier } from "../notify/types.js";
import { runAuthJob } from "./job-auth.js";
import { runClassifyJob } from "./job-classify.js";
import { runNotifyJob } from "./job-notify.js";
import { runParseJob } from "./job-parse.js";

export interface WorkerOptions {
  db: Db;
  dataDir: string;
  codec: Codec;
  banner: string;
  log: AppLog;
  authenticate: Authenticator;
  classifier: Classifier;
  notifiers: readonly Notifier[];
  notifyLabels: readonly string[];
  notifyMinConfidence: number;
  promptsDir: string;
  panelBaseUrl: string;
  pollMs?: number;
  now?: () => number;
  shutdownWaitMs?: number;
  workerId?: string;
}

export interface RunningWorker {
  workerId: string;
  close: () => Promise<void>;
  /** Resolves when the loop has stopped claiming work. */
  settled: Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const workerId = options.workerId ?? `${hostname()}-${process.pid}-${ulid()}`;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1000;
  const shutdownWaitMs = options.shutdownWaitMs ?? 30_000;
  const recovered = recoverRunning(options.db, now());
  if (recovered > 0) options.log.warn({ recovered }, "requeued jobs left running");

  let stopped = false;
  let current: Promise<void> | null = null;
  let currentJob: JobRow | null = null;

  const loop = (async () => {
    while (!stopped) {
      const job = claimJob(options.db, workerId, now());
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      currentJob = job;
      current = runClaimed(options, job, now).finally(() => {
        current = null;
        currentJob = null;
      });
      await current;
    }
  })();

  return {
    workerId,
    settled: loop.then(
      () => undefined,
      () => undefined,
    ),
    async close() {
      stopped = true;
      const outcome = current
        ? await Promise.race([current.then(() => "done" as const), sleep(shutdownWaitMs).then(() => "timeout" as const)])
        : "done";
      if (outcome === "timeout" && currentJob) {
        const requeued = requeueJob(options.db, currentJob.id, workerId, now());
        if (requeued) options.log.warn({ jobId: currentJob.id }, "requeued job on shutdown");
      }
    },
  };
}

/** Claim and run a single job. Returns false when the queue is empty. */
export async function processNext(options: WorkerOptions, workerId: string): Promise<boolean> {
  const now = options.now ?? Date.now;
  const job = claimJob(options.db, workerId, now());
  if (!job) return false;
  await runClaimed(options, job, now);
  return true;
}

async function runClaimed(options: WorkerOptions, job: JobRow, now: () => number): Promise<void> {
  try {
    await dispatch(options, job, now);
    completeJob(options.db, job.id, now());
  } catch (err) {
    const message = err instanceof Error ? err.message : "job failed";
    options.log.error({ jobId: job.id, type: job.type, messageId: job.message_id, err: message }, "job failed");
    const outcome = failJob(options.db, job.id, message, now());
    if (outcome === "dead" && job.message_id) markMessageError(options.db, job.message_id, message, now());
  }
}

async function dispatch(options: WorkerOptions, job: JobRow, now: () => number): Promise<void> {
  if (job.type === "auth") {
    await runAuthJob(
      {
        db: options.db,
        dataDir: options.dataDir,
        codec: options.codec,
        banner: options.banner,
        authenticate: options.authenticate,
        log: options.log,
        now,
      },
      job,
    );
    return;
  }
  if (job.type === "parse") {
    await runParseJob(
      { db: options.db, dataDir: options.dataDir, codec: options.codec, log: options.log, now },
      job,
    );
    return;
  }
  if (job.type === "classify") {
    await runClassifyJob(
      { db: options.db, promptsDir: options.promptsDir, classifier: options.classifier, log: options.log, now },
      job,
    );
    return;
  }
  if (job.type === "notify") {
    await runNotifyJob(
      {
        db: options.db,
        log: options.log,
        now,
        notifiers: options.notifiers,
        notifyLabels: options.notifyLabels,
        notifyMinConfidence: options.notifyMinConfidence,
        panelBaseUrl: options.panelBaseUrl,
      },
      job,
    );
    return;
  }
  throw new Error(`unsupported job type ${job.type}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
