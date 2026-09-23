import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipCodec } from "../src/compress.js";
import { dbFile, openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { enqueueJob } from "../src/db/repos/jobs.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { sha256 } from "../src/hash.js";
import { rebuildFromRaw } from "../src/ingest/rebuild.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { appRoot, migrationsDir } from "../src/paths.js";

test("deleting the database and rebuilding restores the raw sha256 set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-rebuild-"));
  const codec = gzipCodec();
  try {
    const first = Buffer.from("Subject: one\r\n\r\none\r\n");
    const second = Buffer.from("Subject: two\r\n\r\ntwo\r\n");
    const storedFirst = await storeRaw({ dataDir: dir, bytes: first, receivedAtMs: Date.UTC(2026, 0, 2), codec });
    const storedSecond = await storeRaw({ dataDir: dir, bytes: second, receivedAtMs: Date.UTC(2026, 0, 3), codec });
    const badDir = path.join(dir, "raw", "2026", "01", "ab", "cd");
    await mkdir(badDir, { recursive: true });
    const badName = "ab".repeat(32);
    await writeFile(path.join(badDir, `${badName}.eml.gz`), gzipSync(Buffer.from("not-the-named-bytes")));
    await writeFile(path.join(dir, "raw", "README.txt"), "ignore");

    const seeded = openDatabase(dbFile(dir));
    migrate(seeded, migrationsDir());
    insertMessage(seeded, {
      id: "phantom",
      sha256: "ff".repeat(32),
      rawPath: "raw/missing.eml.gz",
      sizeBytes: 1,
      receivedAt: 1,
      envelopeFrom: null,
      envelopeTo: [],
      domains: [],
      smtpMeta: { schema: 1 },
      now: 1,
    });
    seeded.pragma("wal_checkpoint(TRUNCATE)");
    seeded.close();
    removeDb(dir);

    const db = openDatabase(dbFile(dir));
    migrate(db, migrationsDir());
    const report = await rebuildFromRaw({ db, dataDir: dir, codec, now: Date.UTC(2026, 0, 4) });
    const expected = new Set([sha256(first), sha256(second)]);
    const names = await filenamesOnDisk(dir);
    assert.deepEqual(expected, new Set([storedFirst.sha256, storedSecond.sha256]));
    assert.equal(names.has(storedFirst.sha256), true);
    assert.equal(names.has(storedSecond.sha256), true);
    assert.equal(names.has(badName), true);
    assert.deepEqual(messageHashes(db), expected);
    assert.equal(messageHashes(db).has(badName), false);
    assert.equal(messageHashes(db).has("ff".repeat(32)), false);
    assert.equal(report.inserted, 2);
    assert.equal(report.mismatched, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.queued, 2);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuild queues only messages that still have no ai result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-rebuild-queue-"));
  const codec = gzipCodec();
  try {
    const plain = Buffer.from("Subject: keep\r\n\r\nkeep\r\n");
    const classified = Buffer.from("Subject: done\r\n\r\ndone\r\n");
    const runningBytes = Buffer.from("Subject: running\r\n\r\nrunning\r\n");
    const pending = await storeRaw({ dataDir: dir, bytes: plain, receivedAtMs: Date.UTC(2026, 2, 1), codec });
    const finished = await storeRaw({ dataDir: dir, bytes: classified, receivedAtMs: Date.UTC(2026, 2, 2), codec });
    const running = await storeRaw({ dataDir: dir, bytes: runningBytes, receivedAtMs: Date.UTC(2026, 2, 3), codec });
    const db = openDatabase(dbFile(dir));
    migrate(db, migrationsDir());
    insertMessage(db, message("msg_pending", pending.sha256, pending.relativePath, plain.length));
    insertMessage(db, message("msg_done", finished.sha256, finished.relativePath, classified.length));
    insertMessage(db, message("msg_running", running.sha256, running.relativePath, runningBytes.length));
    db.prepare("UPDATE messages SET ai_result = ? WHERE id = 'msg_done'").run(JSON.stringify({ label: "spam" }));
    enqueueJob(db, { id: "job_classify", type: "classify", messageId: "msg_running", now: 1 });

    const report = await rebuildFromRaw({ db, dataDir: dir, codec, now: 50 });
    assert.equal(report.inserted, 0);
    assert.equal(report.queued, 1);
    const jobs = db.prepare("SELECT message_id, type FROM jobs").all() as Array<{ message_id: string; type: string }>;
    assert.deepEqual(
      new Set(jobs.map((row) => `${row.message_id}:${row.type}`)),
      new Set(["msg_running:classify", "msg_pending:auth"]),
    );

    const again = await rebuildFromRaw({ db, dataDir: dir, codec, now: 60 });
    assert.equal(again.queued, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 2);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main --rebuild exits after the sha256 set matches raw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-rebuild-cli-"));
  const codec = gzipCodec();
  try {
    const bytes = [Buffer.from("alpha-message"), Buffer.from("beta-message")];
    const hashes: string[] = [];
    for (const [index, item] of bytes.entries()) {
      const stored = await storeRaw({ dataDir: dir, bytes: item, receivedAtMs: Date.UTC(2026, 4, index + 1), codec });
      hashes.push(stored.sha256);
      assert.equal(stored.sha256, sha256(item));
    }
    const seeded = openDatabase(dbFile(dir));
    migrate(seeded, migrationsDir());
    insertMessage(seeded, message("gone", "ee".repeat(32), "raw/gone.eml.gz", 1));
    seeded.pragma("wal_checkpoint(TRUNCATE)");
    seeded.close();
    removeDb(dir);

    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", "--rebuild"], {
      cwd: appRoot(),
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATHEXT: process.env.PATHEXT,
        COMSPEC: process.env.COMSPEC,
        NODE_ENV: "test",
        ROLES: "smtp",
        MAIL_DATA_DIR: dir,
        ACCEPT_DOMAINS: "example.com",
        CLASSIFIER: "fake",
        COMPRESS: "gzip",
        LOG_LEVEL: "info",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /rebuild complete/);

    const db = openDatabase(dbFile(dir));
    assert.deepEqual(messageHashes(db), new Set(hashes));
    assert.equal(messageHashes(db).has("ee".repeat(32)), false);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function message(id: string, hash: string, rawPath: string, size: number) {
  return {
    id,
    sha256: hash,
    rawPath,
    sizeBytes: size,
    receivedAt: 1,
    envelopeFrom: null,
    envelopeTo: [] as string[],
    domains: [] as string[],
    smtpMeta: { schema: 1, remoteIp: "203.0.113.10" },
    now: 1,
  };
}

function messageHashes(db: ReturnType<typeof openDatabase>): Set<string> {
  const rows = db.prepare("SELECT sha256 FROM messages").all() as Array<{ sha256: string }>;
  return new Set(rows.map((row) => row.sha256));
}

async function filenamesOnDisk(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  await walk(path.join(dir, "raw"), found);
  return found;
}

async function walk(dir: string, found: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, found);
      continue;
    }
    const match = /^([0-9a-f]{64})\.eml\.(?:gz|zst)$/.exec(entry.name);
    if (match?.[1]) found.add(match[1]);
  }
}

function removeDb(dir: string): void {
  const base = dbFile(dir);
  fs.rmSync(base, { force: true });
  fs.rmSync(`${base}-wal`, { force: true });
  fs.rmSync(`${base}-shm`, { force: true });
}
