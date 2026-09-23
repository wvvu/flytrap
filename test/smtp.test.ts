import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsDir } from "../src/paths.js";
import { buildSmtpMeta } from "../src/smtp/session-meta.js";
import { startSmtp, type SmtpLog } from "../src/smtp/server.js";

const silent: SmtpLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

test("a missing reverse lookup is stored as null", () => {
  const meta = buildSmtpMeta({
    remoteIp: "::ffff:203.0.113.10",
    reverseDns: "203.0.113.10",
    helo: "mail.example.com",
    mailFrom: "",
    rcptTo: ["a@example.com"],
    secure: false,
    receivedAtMs: Date.UTC(2026, 8, 21),
    localIp: "192.0.2.10",
    localPort: 25,
  });
  assert.equal(meta.schema, 1);
  assert.equal(meta.remoteIp, "203.0.113.10");
  assert.equal(meta.reverseDns, null);
  assert.equal(meta.mailFrom, "");
  assert.equal(meta.receivedAt, "2026-09-21T00:00:00.000Z");
  assert.equal(meta.localIp, "192.0.2.10");
  assert.equal(meta.localPort, 25);
});

test("smtp accepts this domain, refuses relay, caps size, and retries on a failed write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-smtp-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const config = loadConfig({
    NODE_ENV: "test",
    ROLES: "smtp",
    MAIL_DATA_DIR: dir,
    ACCEPT_DOMAINS: "example.com",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "2525",
    SMTP_BANNER: "mx.test",
    SMTP_MAX_BYTES: "1024",
    SMTP_MAX_CONN_PER_IP: "2",
    SMTP_MAX_CONN_PER_MIN: "30",
    SMTP_MAX_DATA_PER_HOUR: "20",
    CLASSIFIER: "fake",
    COMPRESS: "gzip",
    LOG_LEVEL: "error",
  });
  const smtp = await startSmtp({ config, db, codec: gzipCodec(), log: silent, port: 0 });
  try {
    const body = ["Subject: hi", "", "hello flytrap", "."].join("\r\n");
    const accepted = await session(smtp.port, [
      "EHLO test.example\r\n",
      "MAIL FROM:<>\r\n",
      "RCPT TO:<sink@example.com>\r\n",
      "RCPT TO:<sink@evil.test>\r\n",
      "DATA\r\n",
      `${body}\r\n`,
    ]);
    assert.match(accepted[0] ?? "", /^220 /);
    assert.match(accepted[1] ?? "", /^250 /);
    assert.match(accepted[2] ?? "", /^250 /);
    assert.match(accepted[3] ?? "", /^250 /);
    assert.match(accepted[4] ?? "", /^550 /);
    assert.match(accepted[5] ?? "", /^354 /);
    assert.match(accepted[6] ?? "", /^250 /);

    const row = db.prepare("SELECT id, sha256, raw_path, envelope_from, envelope_to, smtp_meta, status FROM messages").get() as
      | {
          id: string;
          sha256: string;
          raw_path: string;
          envelope_from: string;
          envelope_to: string;
          smtp_meta: string;
          status: string;
        }
      | undefined;
    assert.ok(row);
    assert.equal(row.status, "received");
    assert.equal(row.envelope_from, "");
    assert.deepEqual(JSON.parse(row.envelope_to), ["sink@example.com"]);
    const meta = JSON.parse(row.smtp_meta) as { schema: number; mailFrom: string; rcptTo: string[]; helo: string };
    assert.equal(meta.schema, 1);
    assert.equal(meta.mailFrom, "");
    assert.deepEqual(meta.rcptTo, ["sink@example.com"]);
    assert.equal(meta.helo, "test.example");
    const raw = fs.readFileSync(path.join(dir, row.raw_path));
    const plain = gunzipSync(raw);
    assert.equal(createHash("sha256").update(plain).digest("hex"), row.sha256);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'auth'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n, 1);

    const again = await session(smtp.port, [
      "EHLO test.example\r\n",
      "MAIL FROM:<>\r\n",
      "RCPT TO:<sink@example.com>\r\n",
      "DATA\r\n",
      `${body}\r\n`,
    ]);
    assert.match(again.at(-1) ?? "", /^250 /);
    assert.equal(count(db, "messages"), 1);
    assert.equal(count(db, "deliveries"), 2);
    assert.equal(count(db, "jobs"), 1);
    assert.equal(walk(path.join(dir, "raw")).length, 1);

    const huge = await session(smtp.port, [
      "EHLO test.example\r\n",
      "MAIL FROM:<a@b.c>\r\n",
      "RCPT TO:<sink@example.com>\r\n",
      "DATA\r\n",
      `${"x".repeat(4000)}\r\n.\r\n`,
    ]);
    assert.match(huge.join("\n"), /^552 /m);
    assert.equal(count(db, "messages"), 1);

    const relay = await session(smtp.port, [
      "EHLO test.example\r\n",
      "MAIL FROM:<a@b.c>\r\n",
      "RCPT TO:<a@evil.test>\r\n",
    ]);
    assert.match(relay[3] ?? "", /^550 /);
  } finally {
    await smtp.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write is a 451 and leaves no message row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-smtp-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const config = loadConfig({
    NODE_ENV: "test",
    ROLES: "smtp",
    MAIL_DATA_DIR: dir,
    ACCEPT_DOMAINS: "example.com",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "2525",
    SMTP_MAX_BYTES: "200000",
    CLASSIFIER: "fake",
    COMPRESS: "gzip",
    LOG_LEVEL: "error",
  });
  const smtp = await startSmtp({
    config,
    db,
    codec: gzipCodec(),
    log: silent,
    port: 0,
    accept: async () => {
      throw new Error("disk full");
    },
  });
  try {
    const replies = await session(smtp.port, [
      "EHLO test.example\r\n",
      "MAIL FROM:<>\r\n",
      "RCPT TO:<sink@example.com>\r\n",
      "DATA\r\n",
      "Subject: x\r\n\r\nnope\r\n.\r\n",
    ]);
    assert.match(replies.at(-1) ?? "", /^451 /);
    assert.equal(count(db, "messages"), 0);
    assert.doesNotMatch(replies.join("\n"), /disk full|[/\\]tmp|mail\.db/);
  } finally {
    await smtp.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a second connection past the per-ip ceiling is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-smtp-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const config = loadConfig({
    NODE_ENV: "test",
    ROLES: "smtp",
    MAIL_DATA_DIR: dir,
    ACCEPT_DOMAINS: "example.com",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "2525",
    SMTP_MAX_CONN_PER_IP: "1",
    CLASSIFIER: "fake",
    COMPRESS: "gzip",
    LOG_LEVEL: "error",
  });
  const smtp = await startSmtp({ config, db, codec: gzipCodec(), log: silent, port: 0 });
  const first = openClient(smtp.port);
  try {
    assert.match(await first.next(), /^220 /);
    const second = openClient(smtp.port);
    try {
      assert.match(await second.next(), /^421 /);
    } finally {
      second.socket.destroy();
    }
  } finally {
    first.socket.destroy();
    await smtp.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function session(port: number, commands: string[]): Promise<string[]> {
  const client = openClient(port);
  try {
    const replies = [await client.next()];
    for (const command of commands) {
      client.socket.write(command);
      replies.push(await client.next());
    }
    return replies;
  } finally {
    client.socket.end();
  }
}

function openClient(port: number): { socket: net.Socket; next: () => Promise<string> } {
  const socket = net.connect({ host: "127.0.0.1", port });
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += chunk.toString("latin1");
    const lines = pending.split("\r\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!/^\d{3} /.test(line)) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    }
  });
  socket.on("error", (err: Error) => {
    const waiter = waiters.shift();
    if (waiter) waiter(`599 ${err.message}`);
  });
  return {
    socket,
    next: () => {
      const queued = queue.shift();
      if (queued) {
        if (queued.startsWith("599 ")) return Promise.reject(new Error(queued.slice(4)));
        return Promise.resolve(queued);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`smtp reply timed out, pending=${JSON.stringify(pending)}`));
        }, 4000);
        waiters.push((line) => {
          clearTimeout(timer);
          if (line.startsWith("599 ")) reject(new Error(line.slice(4)));
          else resolve(line);
        });
      });
    },
  };
}

function count(db: Db, table: "messages" | "deliveries" | "jobs"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
