import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { claimJob, completeJob, enqueueJob, failJob, recoverRunning } from "../src/db/repos/jobs.js";
import { findMessageBySha, insertDelivery, insertMessage } from "../src/db/repos/messages.js";
import { migrationsDir } from "../src/paths.js";

test("migration is idempotent and jobs are claimed atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-db-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  try {
    const first = migrate(db, migrationsDir(), () => 1);
    const second = migrate(db, migrationsDir(), () => 2);
    assert.deepEqual(first, ["001_init"]);
    assert.deepEqual(second, []);
    const journal = db.pragma("journal_mode", { simple: true });
    assert.equal(String(journal).toLowerCase(), "wal");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    for (const required of ["messages", "deliveries", "attachments", "jobs", "mailbox_history", "audit_log"]) {
      assert.ok(names.includes(required), required);
    }

    insertMessage(db, {
      id: "msg_1",
      sha256: "ab".repeat(32),
      rawPath: "raw/2026/09/ab/cd/" + "ab".repeat(32) + ".eml.gz",
      sizeBytes: 12,
      receivedAt: 10,
      envelopeFrom: "",
      envelopeTo: ["a@example.com"],
      domains: ["example.com"],
      smtpMeta: { schema: 1, remoteIp: "203.0.113.10" },
      now: 10,
    });
    insertDelivery(db, {
      id: "del_1",
      messageId: "msg_1",
      receivedAt: 10,
      smtpMeta: { schema: 1 },
    });
    assert.equal(findMessageBySha(db, "ab".repeat(32))?.id, "msg_1");

    enqueueJob(db, { id: "job_b", type: "parse", messageId: "msg_1", now: 20 });
    enqueueJob(db, { id: "job_a", type: "auth", messageId: "msg_1", now: 10 });
    const claimed = claimJob(db, "worker-1", 30);
    assert.equal(claimed?.id, "job_a");
    assert.equal(claimJob(db, "worker-2", 30)?.id, "job_b");
    assert.equal(claimJob(db, "worker-3", 30), undefined);

    db.prepare("UPDATE jobs SET status = 'running', locked_at = 1, locked_by = 'dead' WHERE id = 'job_a'").run();
    assert.equal(recoverRunning(db, 40), 2);
    const again = claimJob(db, "worker-4", 40);
    assert.equal(again?.id, "job_a");
    completeJob(db, "job_a", 50);
    const other = claimJob(db, "worker-4", 50);
    assert.equal(other?.id, "job_b");
    completeJob(db, "job_b", 55);
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job_a'").get() as { status: string }).status, "done");

    enqueueJob(db, { id: "job_c", type: "classify", messageId: "msg_1", now: 60, maxAttempts: 2 });
    const running = claimJob(db, "worker-5", 60);
    assert.equal(running?.id, "job_c");
    assert.equal(failJob(db, "job_c", "dns timeout", 70), "queued");
    const retried = claimJob(db, "worker-5", 70 + 60_000);
    assert.equal(retried?.id, "job_c");
    assert.equal(failJob(db, "job_c", "dns timeout", 80), "dead");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
