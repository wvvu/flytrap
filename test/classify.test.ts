import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUserMessage, readPrompt } from "../src/ai/prompt.js";
import { createOpenAiClassifier } from "../src/ai/openai-compat.js";
import { finalizeAiResult, parseModelOutput } from "../src/ai/types.js";
import { gzipCodec } from "../src/compress.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { enqueueJob } from "../src/db/repos/jobs.js";
import { insertMessage, saveParsedMessage } from "../src/db/repos/messages.js";
import type { AppLog } from "../src/log.js";
import { createTelegramNotifier } from "../src/notify/telegram.js";
import { createWebhookNotifier } from "../src/notify/webhook.js";
import type { NotifyInput } from "../src/notify/types.js";
import { defaultPromptsDir, migrationsDir } from "../src/paths.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { processNext, type WorkerOptions } from "../src/worker/loop.js";

const silent: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
};

const valid = {
  label: "phish",
  confidence: 0.86,
  summary: "仿冒登录页",
  tags: ["credential-theft"],
  signals: [{ name: "dmarc", value: "fail" }],
};

test("model output with a missing field, an extra field, or a bad label is rejected", () => {
  assert.throws(() => parseModelOutput({ ...valid, confidence: undefined }));
  assert.throws(() => parseModelOutput({ ...valid, extra: true }));
  assert.throws(() => parseModelOutput({ ...valid, label: "phishing" }));
  const parsed = parseModelOutput("```json\n" + JSON.stringify(valid) + "\n```");
  assert.equal(parsed.label, "phish");
  assert.equal(readPrompt(defaultPromptsDir()).includes("unsolicited-admin"), true);
});

test("the classify prompt carries auth, history, and attachments", () => {
  const text = buildUserMessage({
    spf: "fail",
    dkim: "none",
    dmarc: "fail",
    rdns: "no-match",
    envelopeFrom: "",
    envelopeTo: ["admin@example.com", "new@example.com"],
    from: "IT <it@evil.example>",
    subject: "reset",
    messageId: "<a@evil.example>",
    text: "SECRET-BODY-NEEDLE",
    urls: ["https://evil.example/reset"],
    history: [
      {
        domain: "example.com",
        localpart: "admin",
        firstSeen: Date.UTC(2019, 0, 1),
        lastSeen: Date.UTC(2021, 5, 1),
        notes: "旧主机面板",
      },
    ],
    missingHistory: [{ domain: "example.com", localpart: "new" }],
    attachments: [{ filename: "invoice.pdf", sha256: "ab".repeat(32), mime: "application/pdf", sizeBytes: 220 * 1024 }],
  });
  assert.match(text, /AUTH: spf= fail dkim= none dmarc= fail rdns= no-match/);
  assert.match(text, /ENVELOPE: from=<> to=admin@example.com,new@example.com/);
  assert.match(text, /HISTORY: localpart "admin" on example.com first_seen=2019-01-01 last_seen=2021-06-01 notes="旧主机面板"/);
  assert.match(text, /HISTORY: localpart "new" on example.com no-record/);
  assert.match(text, /invoice.pdf sha256=abababababababababababababababababababababababababababababababab mime=application\/pdf size=220k/);
  assert.match(text, /SECRET-BODY-NEEDLE/);
});

test("openai-compat validates the completion and retries without response_format", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    if (body.response_format) return new Response("unsupported", { status: 400 });
    return Response.json({
      choices: [{ message: { content: JSON.stringify(valid) } }],
    });
  };
  const classifier = createOpenAiClassifier({
    baseUrl: "https://llm.example/v1/",
    apiKey: "sk-test",
    model: "gpt-test",
    fetchImpl,
    now: () => Date.UTC(2026, 8, 21),
  });
  const result = await classifier.classify({
    promptId: "classify-v1",
    systemPrompt: "system",
    userMessage: "SECRET-BODY-NEEDLE",
    facts: emptyFacts(),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.response_format, undefined);
  assert.equal(result.label, "phish");
  assert.equal(result.provider, "openai-compat");
  assert.equal(result.at, "2026-09-21T00:00:00.000Z");
  assert.equal(JSON.stringify(result).includes("sk-test"), false);
});

test("a bad model result is not stored, and a matching label is pushed without the body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-classify-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const sent: NotifyInput[] = [];
  try {
    const badId = await seedParsed(db, dir, "bad");
    const badOptions = options(db, dir, async () => ({ label: "nope" }) as never, sent);
    assert.equal(await processNext(badOptions, "worker-bad"), true);
    assert.equal((db.prepare("SELECT ai_result FROM messages WHERE id = ?").get(badId) as { ai_result: string | null }).ai_result, null);
    assert.equal((db.prepare("SELECT status FROM jobs WHERE message_id = ?").get(badId) as { status: string }).status, "queued");

    const goodId = await seedParsed(db, dir, "good");
    db.prepare(
      `INSERT INTO mailbox_history (id, domain, localpart, first_seen, last_seen, source, notes)
       VALUES ('h1', 'example.com', 'sink', ?, ?, 'import', '旧面板')`,
    ).run(Date.UTC(2019, 0, 2), Date.UTC(2021, 0, 2));
    let seen = "";
    const goodOptions = options(
      db,
      dir,
      async (input) => {
        seen = input.userMessage;
        return finalizeAiResult({
          schema: 1,
          prompt_id: "classify-v1",
          model: "test",
          provider: "test",
          at: "2026-09-21T00:00:00.000Z",
          ...valid,
        });
      },
      sent,
    );
    assert.equal(await processNext(goodOptions, "worker-good"), true);
    assert.equal(await processNext(goodOptions, "worker-good"), true);
    assert.match(seen, /HISTORY: localpart "sink" on example.com first_seen=2019-01-02/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.summary, "仿冒登录页");
    assert.equal(JSON.stringify(sent[0]).includes("SECRET-BODY-NEEDLE"), false);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id = ?").get(goodId) as { status: string }).status, "notified");

    const old = (db.prepare("SELECT ai_result FROM messages WHERE id = ?").get(goodId) as { ai_result: string }).ai_result;
    enqueueJob(db, { id: "classify_again", type: "classify", messageId: goodId, now: 1 });
    const again = options(
      db,
      dir,
      async () =>
        finalizeAiResult({
          schema: 1,
          prompt_id: "classify-v1",
          model: "test",
          provider: "test",
          at: "2026-09-21T01:00:00.000Z",
          label: "spam",
          confidence: 0.4,
          summary: "普通垃圾",
          tags: [],
          signals: [],
        }),
      sent,
    );
    assert.equal(await processNext(again, "worker-again"), true);
    const stored = JSON.parse((db.prepare("SELECT ai_result, status FROM messages WHERE id = ?").get(goodId) as { ai_result: string }).ai_result) as {
      label: string;
      previous?: { label?: string; previous?: unknown };
    };
    assert.equal(stored.label, "spam");
    assert.equal(stored.previous?.label, "phish");
    assert.equal(stored.previous?.previous, undefined);
    assert.equal(JSON.parse(old).label, "phish");
    assert.equal(await processNext(again, "worker-again"), true);
    assert.equal(sent.length, 1);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id = ?").get(goodId) as { status: string }).status, "notified");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a telegram failure does not reveal the bot token", async () => {
  const notifier = createTelegramNotifier({
    token: "secret-token",
    chatId: "1",
    fetchImpl: async () => {
      throw new Error("failed https://api.telegram.org/botsecret-token/sendMessage");
    },
  });
  await assert.rejects(
    () =>
      notifier.notify({
        messageId: "m",
        subject: "s",
        from: "a@b.c",
        label: "phish",
        confidence: 0.9,
        summary: "x",
        panelUrl: "http://127.0.0.1/#/m/m",
      }),
    (err: Error) => err.message === "telegram request failed" && !err.message.includes("secret-token"),
  );
});

function emptyFacts() {
  return {
    spf: "none",
    dkim: "none",
    dmarc: "none",
    rdns: "no-match" as const,
    envelopeFrom: "",
    envelopeTo: [],
    from: "",
    subject: "",
    messageId: "",
    text: "",
    urls: [],
    history: [],
    missingHistory: [],
    attachments: [],
  };
}

function options(
  db: ReturnType<typeof openDatabase>,
  dir: string,
  classify: WorkerOptions["classifier"]["classify"],
  sent: NotifyInput[],
): WorkerOptions {
  return {
    db,
    dataDir: dir,
    codec: gzipCodec(),
    banner: "mx.test",
    log: silent,
    authenticate: async () => {
      throw new Error("auth unused");
    },
    classifier: { id: "test", model: "test", classify },
    notifiers: [
      createWebhookNotifier({
        url: "https://hooks.example/flytrap",
        fetchImpl: async (_input, init) => {
          sent.push(JSON.parse(String(init?.body)) as NotifyInput);
          return new Response(null, { status: 204 });
        },
      }),
    ],
    notifyLabels: ["phish", "malware"],
    notifyMinConfidence: 0.6,
    promptsDir: defaultPromptsDir(),
    panelBaseUrl: "http://127.0.0.1:8080",
    now: () => 5_000,
  };
}

async function seedParsed(db: ReturnType<typeof openDatabase>, dir: string, name: string): Promise<string> {
  const bytes = Buffer.from(`Subject: ${name}\r\n\r\nSECRET-BODY-NEEDLE\r\n`);
  const stored = await storeRaw({ dataDir: dir, bytes, receivedAtMs: Date.UTC(2026, 8, 21), codec: gzipCodec() });
  const id = `msg_${name}_${stored.sha256.slice(0, 6)}`;
  insertMessage(db, {
    id,
    sha256: stored.sha256,
    rawPath: stored.relativePath,
    sizeBytes: stored.sizeBytes,
    receivedAt: 10,
    envelopeFrom: "",
    envelopeTo: ["sink@example.com"],
    domains: ["example.com"],
    smtpMeta: {
      schema: 1,
      remoteIp: "203.0.113.10",
      reverseDns: null,
      helo: "mail.example.com",
      mailFrom: "",
      rcptTo: ["sink@example.com"],
      secure: false,
      receivedAt: "2026-09-21T00:00:00.000Z",
      localIp: "127.0.0.1",
      localPort: 2525,
    },
    now: 10,
  });
  saveParsedMessage(db, {
    id,
    subject: "reset",
    fromAddr: "it@evil.example",
    toAddrs: ["sink@example.com"],
    messageId: `<${name}@evil.example>`,
    parsed: JSON.stringify({
      schema: 1,
      subject: "reset",
      from: { name: "IT", address: "it@evil.example" },
      replyTo: null,
      text: "SECRET-BODY-NEEDLE",
      htmlBytes: 0,
      urls: ["https://evil.example/reset"],
      attachmentCount: 0,
    }),
    now: 20,
  });
  enqueueJob(db, { id: `classify_${id}`, type: "classify", messageId: id, now: name === "bad" ? 10 : 100 });
  return id;
}
