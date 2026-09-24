import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipCodec } from "../src/compress.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { listMailboxHistory, upsertMailboxHistory } from "../src/db/repos/mailbox-history.js";
import { deleteMessage, emptyTrash, insertMessage, trashMessage } from "../src/db/repos/messages.js";
import { rebuildFromRaw } from "../src/ingest/rebuild.js";
import { removeStoredFiles } from "../src/ingest/remove-stored.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { migrationsDir, resolveInside } from "../src/paths.js";

test("a purged sha is not rebuilt, and empty trash keeps shared attachments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-purge-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const codec = gzipCodec();
  try {
    const first = await storeRaw({
      dataDir: dir,
      bytes: Buffer.from("Subject: one\r\n\r\nfirst\r\n"),
      receivedAtMs: 1_700_000_000_000,
      codec,
    });
    const second = await storeRaw({
      dataDir: dir,
      bytes: Buffer.from("Subject: two\r\n\r\nsecond\r\n"),
      receivedAtMs: 1_700_000_100_000,
      codec,
    });
    insertMessage(db, message("msg_one", first, 1));
    insertMessage(db, message("msg_two", second, 2));

    const shared = "ab".repeat(32);
    const only = "cd".repeat(32);
    const sharedRel = "attachments/shared.bin";
    const onlyRel = "attachments/only.bin";
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, sharedRel), "shared");
    fs.writeFileSync(path.join(dir, onlyRel), "only");
    const insertAttachment = db.prepare(
      "INSERT INTO attachments (sha256, path, mime, size_bytes, created_at) VALUES (?, ?, 'text/plain', 4, 1)",
    );
    insertAttachment.run(shared, sharedRel);
    insertAttachment.run(only, onlyRel);
    const link = db.prepare(
      "INSERT INTO message_attachments (message_id, sha256, filename, content_id) VALUES (?, ?, ?, NULL)",
    );
    link.run("msg_one", shared, "shared.txt");
    link.run("msg_two", shared, "shared.txt");
    link.run("msg_one", only, "only.txt");

    const purged = deleteMessage(db, "msg_one", 10);
    assert.equal(purged?.count, 1);
    assert.ok(purged?.paths.includes(first.relativePath));
    assert.ok(purged?.paths.includes(onlyRel));
    assert.equal(purged?.paths.includes(sharedRel), false);

    const whilePresent = await rebuildFromRaw({ db, dataDir: dir, codec, now: 20 });
    assert.equal(whilePresent.inserted, 0);
    assert.ok(whilePresent.skipped >= 1);
    assert.equal(fs.existsSync(resolveInside(dir, first.relativePath)), true);

    const failed = await removeStoredFiles(dir, purged?.paths ?? []);
    assert.deepEqual(failed, []);
    assert.equal(fs.existsSync(resolveInside(dir, first.relativePath)), false);
    assert.equal(fs.existsSync(resolveInside(dir, onlyRel)), false);
    assert.equal(fs.existsSync(resolveInside(dir, sharedRel)), true);

    trashMessage(db, "msg_two", 30);
    const emptied = emptyTrash(db, 40);
    assert.equal(emptied.count, 1);
    assert.ok(emptied.paths.includes(sharedRel));
    await removeStoredFiles(dir, emptied.paths);
    assert.equal(fs.existsSync(resolveInside(dir, sharedRel)), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mailbox names that differ only by case stay one row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-mailbox-"));
  const db = openDatabase(path.join(dir, "mail.db"));
  migrate(db, migrationsDir());
  try {
    upsertMailboxHistory(db, {
      domain: "Example.com",
      localpart: "Admin",
      firstSeen: 1,
      lastSeen: 1,
      source: "panel",
      notes: "first",
    });
    upsertMailboxHistory(db, {
      domain: "example.com",
      localpart: "admin",
      firstSeen: null,
      lastSeen: 2,
      source: null,
      notes: "second",
    });
    const rows = listMailboxHistory(db, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.domain, "example.com");
    assert.equal(rows[0]?.localpart, "admin");
    assert.equal(rows[0]?.notes, "second");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function message(
  id: string,
  stored: { sha256: string; relativePath: string },
  receivedAt: number,
) {
  return {
    id,
    sha256: stored.sha256,
    rawPath: stored.relativePath,
    sizeBytes: 12,
    receivedAt,
    envelopeFrom: "alice@example.com",
    envelopeTo: ["sink@example.com"],
    domains: ["example.com"],
    smtpMeta: { schema: 1 },
    now: receivedAt,
  };
}
