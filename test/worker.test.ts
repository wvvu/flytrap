import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dkimSign } from "mailauth";
import { gzipCodec } from "../src/compress.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { enqueueJob } from "../src/db/repos/jobs.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { fakeClassifier } from "../src/ai/classifier.js";
import type { AppLog } from "../src/log.js";
import { authResultSchema, authenticateMessage, DnsTimeoutError, type AuthResult } from "../src/mail/auth.js";
import { defaultPromptsDir, migrationsDir } from "../src/paths.js";
import { processNext, startWorker, type WorkerOptions } from "../src/worker/loop.js";

const silent: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

const meta = {
  schema: 1,
  remoteIp: "203.0.113.10",
  reverseDns: null,
  helo: "mail.example.com",
  mailFrom: "alice@example.com",
  rcptTo: ["sink@example.com"],
  secure: false,
  receivedAt: "2026-09-21T00:00:00.000Z",
  localIp: "127.0.0.1",
  localPort: 2525,
};

test("a signed fixture verifies with a stub resolver", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const p = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const message = [
    "From: Alice <alice@example.com>",
    "To: sink@example.com",
    "Subject: hi",
    "Message-ID: <signed@example.com>",
    "Date: Mon, 21 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello flytrap",
    "",
  ].join("\r\n");
  const signed = await dkimSign(Buffer.from(message), {
    signatureData: [{ signingDomain: "example.com", selector: "flytrap", privateKey: pem }],
  });
  const raw = Buffer.from(signed.signatures + message);
  const auth = await authenticateMessage(
    {
      raw,
      ip: "203.0.113.10",
      helo: "mail.example.com",
      sender: "alice@example.com",
      mta: "mx.test",
      ptr: "mail.example.com",
    },
    10_000,
    async (name, rrtype) => {
      if (rrtype === "TXT" && name.toLowerCase() === "flytrap._domainkey.example.com") {
        return [[`v=DKIM1; k=rsa; p=${p}`]];
      }
      return [];
    },
  );
  assert.equal(auth.dkim, "pass", JSON.stringify(auth));
  assert.equal(auth.schema, 1);
  assert.equal(auth.rdns.match, true);
  assert.match(auth.headers, /dkim=pass/i);
});

test("authentication failure still parses, and the same attachment is stored once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-worker-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  try {
    const raw = multipart();
    const messageId = await seed(db, dir, raw);
    const fixed = failedAuth();
    const options = workerOptions(db, dir, async () => fixed);
    assert.equal(await processNext(options, "worker-test"), true);
    assert.equal(await processNext(options, "worker-test"), true);

    const row = db.prepare("SELECT status, subject, from_addr, parsed, auth_result FROM messages WHERE id = ?").get(messageId) as {
      status: string;
      subject: string;
      from_addr: string;
      parsed: string;
      auth_result: string;
    };
    assert.equal(row.status, "parsed");
    assert.equal(row.subject, "invoice");
    assert.equal(row.from_addr, "alice@example.com");
    const auth = JSON.parse(row.auth_result) as AuthResult;
    assert.equal(auth.spf, "fail");
    const parsed = JSON.parse(row.parsed) as { text: string; urls: string[]; attachmentCount: number };
    assert.equal(parsed.text.includes("alert"), false);
    assert.equal(parsed.text.includes("<script"), false);
    assert.ok(parsed.urls.includes("https://evil.example/phish"));
    assert.ok(parsed.urls.includes("https://other.example/a"));
    assert.equal(parsed.attachmentCount, 1);
    assert.equal(attachmentFiles(dir).length, 1);

    enqueueJob(db, { id: "parse_again", type: "parse", messageId, now: 50 });
    assert.equal(await processNext(options, "worker-test"), true);
    assert.equal(attachmentFiles(dir).length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM message_attachments").get() as { n: number }).n, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dns failures stop after three tries and the body is still parsed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-dns-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  try {
    const messageId = await seed(db, dir, Buffer.from("Subject: plain\r\n\r\njust text\r\n"));
    let clock = 1_000_000;
    const options = workerOptions(db, dir, async () => {
      throw new DnsTimeoutError();
    }, () => clock);
    assert.equal(await processNext(options, "worker-dns"), true);
    assert.equal(jobStatus(db, "auth"), "queued");
    clock += 10_000;
    assert.equal(await processNext(options, "worker-dns"), true);
    assert.equal((db.prepare("SELECT attempts FROM jobs WHERE type = 'auth'").get() as { attempts: number }).attempts, 2);
    clock += 60_000;
    assert.equal(await processNext(options, "worker-dns"), true);
    const authJob = db.prepare("SELECT status FROM jobs WHERE type = 'auth'").get() as { status: string };
    assert.equal(authJob.status, "done");
    const auth = JSON.parse((db.prepare("SELECT auth_result FROM messages WHERE id = ?").get(messageId) as { auth_result: string }).auth_result) as AuthResult;
    assert.equal(auth.error, "dns_timeout");
    assert.equal(auth.spf, "temperror");
    assert.equal(await processNext(options, "worker-dns"), true);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id = ?").get(messageId) as { status: string }).status, "parsed");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown requeues the job it could not finish", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-stop-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await seed(db, dir, Buffer.from("Subject: x\r\n\r\nbody\r\n"));
    const worker = await startWorker({
      ...workerOptions(db, dir, async () => {
        await gate;
        return failedAuth();
      }),
      pollMs: 15,
      shutdownWaitMs: 40,
    });
    await waitFor(() => jobStatus(db, "auth") === "running");
    await worker.close();
    assert.equal(jobStatus(db, "auth"), "queued");
    release?.();
    await worker.settled;
  } finally {
    release?.();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function failedAuth(): AuthResult {
  return authResultSchema.parse({
    schema: 1,
    spf: "fail",
    dkim: "none",
    dmarc: "fail",
    arc: "none",
    rdns: { ptr: null, match: false },
    headers: "",
  });
}

function workerOptions(db: Db, dir: string, authenticate: WorkerOptions["authenticate"], now = () => Date.now()): WorkerOptions {
  return {
    db,
    dataDir: dir,
    codec: gzipCodec(),
    banner: "mx.test",
    log: silent,
    authenticate,
    classifier: fakeClassifier(now),
    notifiers: [],
    notifyLabels: ["phish", "malware"],
    notifyMinConfidence: 0.6,
    promptsDir: defaultPromptsDir(),
    panelBaseUrl: "http://127.0.0.1:8080",
    now,
  };
}

async function seed(db: Db, dir: string, bytes: Buffer): Promise<string> {
  const stored = await storeRaw({ dataDir: dir, bytes, receivedAtMs: Date.UTC(2026, 8, 21), codec: gzipCodec() });
  const id = `msg_${stored.sha256.slice(0, 8)}`;
  insertMessage(db, {
    id,
    sha256: stored.sha256,
    rawPath: stored.relativePath,
    sizeBytes: stored.sizeBytes,
    receivedAt: 10,
    envelopeFrom: "alice@example.com",
    envelopeTo: ["sink@example.com"],
    domains: ["example.com"],
    smtpMeta: meta,
    now: 10,
  });
  enqueueJob(db, { id: `auth_${id}`, type: "auth", messageId: id, now: 10 });
  return id;
}

function jobStatus(db: Db, type: string): string {
  return (db.prepare("SELECT status FROM jobs WHERE type = ?").get(type) as { status: string }).status;
}

function attachmentFiles(dir: string): string[] {
  const root = path.join(dir, "attachments");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function multipart(): Buffer {
  const boundary = "----flytrap";
  const pdf = Buffer.from("%PDF-1.4 flytrap").toString("base64");
  return Buffer.from(
    [
      "From: Alice <alice@example.com>",
      "To: sink@example.com",
      "Subject: invoice",
      "Message-ID: <inv@example.com>",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See https://evil.example/phish",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><style>x{}</style><script>alert(1)</script><p>Hello</p><a href="https://other.example/a">x</a></html>',
      "",
      `--${boundary}`,
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdf,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
