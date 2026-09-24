import type { Db } from "../index.js";

export type JobType = "auth" | "parse" | "classify" | "notify" | "rebuild";
export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface JobRow {
  id: string;
  type: JobType;
  message_id: string | null;
  payload: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_at: number | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EnqueueInput {
  id: string;
  type: JobType;
  messageId?: string | null;
  payload?: unknown;
  now: number;
  runAfter?: number;
  maxAttempts?: number;
}

const CLAIM_SQL = `
UPDATE jobs
SET status = 'running', locked_at = ?, locked_by = ?, updated_at = ?
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'queued' AND run_after <= ?
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *
`;

export function enqueueJob(db: Db, input: EnqueueInput): void {
  db.prepare(
    `INSERT INTO jobs (
      id, type, message_id, payload, status, attempts, max_attempts, run_after, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.type,
    input.messageId ?? null,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.maxAttempts ?? 5,
    input.runAfter ?? input.now,
    input.now,
    input.now,
  );
}

/** One statement. Two workers cannot receive the same row. */
export function claimJob(db: Db, workerId: string, now: number): JobRow | undefined {
  return db.prepare(CLAIM_SQL).get(now, workerId, now, now) as JobRow | undefined;
}

export function completeJob(db: Db, id: string, now: number): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(now, id);
}

export function failJob(db: Db, id: string, error: string, now: number): "queued" | "dead" {
  const current = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(id) as
    | { attempts: number; max_attempts: number }
    | undefined;
  if (!current) throw new Error("job not found");
  const attempts = current.attempts + 1;
  const dead = attempts >= current.max_attempts;
  db.prepare(
    `UPDATE jobs
     SET attempts = ?, status = ?, run_after = ?, locked_at = NULL, locked_by = NULL,
         last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(attempts, dead ? "dead" : "queued", dead ? now : now + backoffMs(attempts), error.slice(0, 500), now, id);
  return dead ? "dead" : "queued";
}

/** Startup crash recovery. Every running row is stale: this process has not claimed one yet. */
export function recoverRunning(db: Db, now: number): number {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = ?
       WHERE status = 'running'`,
    )
    .run(now);
  return result.changes;
}

export function requeueJob(db: Db, id: string, workerId: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
    )
    .run(now, id, workerId);
  return result.changes === 1;
}

export function hasOpenJob(db: Db, messageId: string, type: JobType): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM jobs
       WHERE message_id = ? AND type = ? AND status IN ('queued', 'running')
       LIMIT 1`,
    )
    .get(messageId, type);
  return Boolean(row);
}

export function backoffMs(attempts: number): number {
  const shift = Math.min(Math.max(attempts, 1), 10);
  return Math.min(1000 * 2 ** shift, 15 * 60 * 1000);
}

export function retryJob(db: Db, id: string, now: number): boolean {
  return db.transaction(() => {
    const job = db.prepare("SELECT id, message_id, status FROM jobs WHERE id = ?").get(id) as
      | { id: string; message_id: string | null; status: string }
      | undefined;
    if (!job) return false;
    const res = db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', attempts = 0, run_after = ?, locked_at = NULL, locked_by = NULL,
             last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
    if (res.changes === 1 && job.message_id) {
      db.prepare(
        `UPDATE messages
         SET status = 'received', error = NULL, updated_at = ?
         WHERE id = ? AND status = 'error'`,
      ).run(now, job.message_id);
    }
    return res.changes === 1;
  })();
}

export function retryAllDeadJobs(db: Db, now: number): number {
  return db.transaction(() => {
    const deadJobs = db
      .prepare(`SELECT id, message_id FROM jobs WHERE status IN ('dead', 'failed')`)
      .all() as Array<{ id: string; message_id: string | null }>;
    if (deadJobs.length === 0) return 0;

    const res = db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', attempts = 0, run_after = ?, locked_at = NULL, locked_by = NULL,
             last_error = NULL, updated_at = ?
         WHERE status IN ('dead', 'failed')`,
      )
      .run(now, now);

    const messageIds = [
      ...new Set(deadJobs.map((job) => job.message_id).filter((messageId): messageId is string => Boolean(messageId))),
    ];
    // Stay under SQLite's older 999-variable host parameter limit.
    const chunkSize = 400;
    for (let offset = 0; offset < messageIds.length; offset += chunkSize) {
      const slice = messageIds.slice(offset, offset + chunkSize);
      const placeholders = slice.map(() => "?").join(",");
      db.prepare(
        `UPDATE messages
         SET status = 'received', error = NULL, updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'error'`,
      ).run(now, ...slice);
    }

    return res.changes;
  })();
}

export interface ListJobsOptions {
  status?: string | null;
  limit?: number;
}

export interface JobDetailRow extends JobRow {
  message_subject: string | null;
}

export function countJobsByStatus(db: Db, status: JobStatus): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = ?").get(status) as { c: number };
  return row.c;
}

export function listJobsWithDetails(db: Db, options: ListJobsOptions = {}): JobDetailRow[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  if (options.status && options.status !== "all") {
    return db
      .prepare(
        `SELECT j.*, m.subject as message_subject
         FROM jobs j
         LEFT JOIN messages m ON j.message_id = m.id
         WHERE j.status = ?
         ORDER BY j.created_at DESC
         LIMIT ?`,
      )
      .all(options.status, limit) as JobDetailRow[];
  }
  return db
    .prepare(
      `SELECT j.*, m.subject as message_subject
       FROM jobs j
       LEFT JOIN messages m ON j.message_id = m.id
       ORDER BY j.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as JobDetailRow[];
}
