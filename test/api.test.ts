import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { insertMessage } from "../src/db/repos/messages.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { migrationsDir } from "../src/paths.js";

const password = "test-password-value";
const secret = "0123456789abcdef0123456789abcdef";

test("the api requires a session, hides paths, and pages the list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-api-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const outside = path.join(dir, "..", "outside.txt");
  fs.writeFileSync(outside, "secret-outside");
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_USERNAME: "admin",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
      API_HOST: "127.0.0.1",
      API_PORT: "8080",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => Date.UTC(2026, 8, 21, 12),
  });
  const client = cookieJar();
  try {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, roles: ["api"], db: "ok" });
    assert.equal(JSON.stringify(health.json()).includes(dir), false);

    const closed = await app.inject({ method: "GET", url: "/v1/messages" });
    assert.equal(closed.statusCode, 401);
    assert.deepEqual(closed.json(), { error: "unauthorized" });

    const noToken = await app.inject({
      method: "POST",
      url: "/v1/login",
      headers: { "content-type": "application/json" },
      payload: { username: "admin", password },
    });
    assert.equal(noToken.statusCode, 403);

    await client.csrf(app);
    const bad = await client.post(app, "/v1/login", { username: "admin", password: "nope" });
    assert.equal(bad.statusCode, 401);
    assert.equal((db.prepare("SELECT action FROM audit_log WHERE action = 'login_failed'").get() as { action: string }).action, "login_failed");

    const login = await client.post(app, "/v1/login", { username: "admin", password });
    assert.equal(login.statusCode, 200);
    assert.deepEqual(login.json(), { user: "admin" });

    const bytes = Buffer.from("Subject: invoice\r\n\r\nSECRET-BODY-NEEDLE\r\n");
    const stored = await storeRaw({ dataDir: dir, bytes, receivedAtMs: Date.UTC(2026, 8, 21, 1), codec: gzipCodec() });
    insertMessage(db, {
      id: "msg_visible",
      sha256: stored.sha256,
      rawPath: stored.relativePath,
      sizeBytes: bytes.length,
      receivedAt: Date.UTC(2026, 8, 21, 1),
      envelopeFrom: "alice@evil.example",
      envelopeTo: ["sink@example.com"],
      domains: ["example.com"],
      smtpMeta: { schema: 1, remoteIp: "203.0.113.10" },
      now: Date.UTC(2026, 8, 21, 1),
    });
    db.prepare(
      `UPDATE messages
       SET subject = 'invoice', from_addr = 'alice@evil.example', message_id = '<inv@evil.example>',
           parsed = ?, ai_result = ?, status = 'classified'
       WHERE id = 'msg_visible'`,
    ).run(
      JSON.stringify({ schema: 1, text: "SECRET-BODY-NEEDLE", urls: ["https://evil.example/a"] }),
      JSON.stringify({ schema: 1, label: "phish", confidence: 0.9, summary: "仿冒", tags: ["lookalike"], raw: { secret: true } }),
    );
    insertMessage(db, {
      id: "msg_hidden",
      sha256: "cd".repeat(32),
      rawPath: outside,
      sizeBytes: 4,
      receivedAt: Date.UTC(2026, 8, 20),
      envelopeFrom: "",
      envelopeTo: ["other@example.com"],
      domains: ["example.com"],
      smtpMeta: { schema: 1 },
      now: Date.UTC(2026, 8, 20),
    });
    db.prepare("UPDATE messages SET subject = 'older', status = 'received' WHERE id = 'msg_hidden'").run();
    db.prepare(
      `INSERT INTO attachments (sha256, path, mime, size_bytes, created_at) VALUES (?, ?, 'text/plain', 4, 1)`,
    ).run("ab".repeat(32), outside);

    const list = await client.get(app, "/v1/messages");
    assert.equal(list.statusCode, 200);
    const listed = list.json() as { items: Array<{ id: string; label: string | null; summary: string | null }>; nextCursor: string | null };
    assert.equal(listed.items[0]?.id, "msg_visible");
    assert.equal(listed.items[0]?.label, "phish");
    assert.equal(JSON.stringify(listed).includes("SECRET-BODY-NEEDLE"), false);
    assert.equal(JSON.stringify(listed).includes("rawPath"), false);
    assert.equal(listed.nextCursor, null);

    const page = await client.get(app, "/v1/messages?limit=1");
    const paged = page.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(paged.items.length, 1);
    assert.equal(paged.items[0]?.id, "msg_visible");
    assert.ok(paged.nextCursor);
    const next = await client.get(app, `/v1/messages?limit=1&cursor=${encodeURIComponent(paged.nextCursor ?? "")}`);
    assert.equal((next.json() as { items: Array<{ id: string }> }).items[0]?.id, "msg_hidden");

    const needle = await client.get(app, "/v1/messages?q=SECRET-BODY-NEEDLE");
    assert.equal((needle.json() as { items: unknown[] }).items.length, 0);
    const bySubject = await client.get(app, "/v1/messages?q=invoice&label=phish");
    assert.equal((bySubject.json() as { items: Array<{ id: string }> }).items[0]?.id, "msg_visible");

    const detail = await client.get(app, "/v1/messages/msg_visible");
    const body = detail.json() as { parsed: { text: string }; aiResult: { raw: { secret: boolean } }; rawPath?: string };
    assert.equal(detail.statusCode, 200);
    assert.equal(body.parsed.text, "SECRET-BODY-NEEDLE");
    assert.equal(body.aiResult.raw.secret, true);
    assert.equal(body.rawPath, undefined);
    assert.equal(JSON.stringify(body).includes(stored.relativePath), false);

    const raw = await client.get(app, "/v1/messages/msg_visible/raw");
    assert.equal(raw.statusCode, 200);
    assert.match(raw.headers["content-type"] ?? "", /message\/rfc822/);
    assert.equal(raw.body, bytes.toString("utf8"));

    const escaped = await client.get(app, "/v1/messages/msg_hidden/raw");
    assert.equal(escaped.statusCode, 404);
    assert.equal(JSON.stringify(escaped.json()).includes("outside"), false);
    assert.equal(JSON.stringify(escaped.json()).includes("secret-outside"), false);

    const attachment = await client.get(app, `/v1/attachments/${"ab".repeat(32)}`);
    assert.equal(attachment.statusCode, 404);
    assert.equal(JSON.stringify(attachment.json()).includes("outside"), false);

    const text = await client.get(app, "/v1/messages/msg_visible/text");
    assert.equal(text.json().text, "SECRET-BODY-NEEDLE");

    const htmlRes = await client.get(app, "/v1/messages/msg_visible/html");
    assert.equal(htmlRes.statusCode, 200);
    assert.equal(typeof htmlRes.json().html, "string");
    assert.equal(htmlRes.json().subject, "invoice");

    await client.csrf(app);
    const reclassify = await client.post(app, "/v1/messages/msg_visible/reclassify", {});
    assert.equal(reclassify.statusCode, 202);
    assert.equal((db.prepare("SELECT type FROM jobs WHERE message_id = 'msg_visible'").get() as { type: string }).type, "classify");
    assert.equal((db.prepare("SELECT action FROM audit_log WHERE action = 'reclassify'").get() as { action: string }).action, "reclassify");

    const stats = await client.get(app, "/v1/stats");
    assert.equal(stats.json().total.phish, 1);
    assert.equal(stats.json().total.unlabeled, 1);

    const saved = await client.post(app, "/v1/mailbox-history", {
      domain: "Example.com",
      localpart: "Admin",
      firstSeen: "2019-01-01T00:00:00.000Z",
      notes: "旧面板",
    });
    assert.equal(saved.statusCode, 201);
    const history = await client.get(app, "/v1/mailbox-history?domain=example.com");
    const items = history.json().items as Array<{ localpart: string; notes: string; firstSeen: string }>;
    assert.equal(items[0]?.localpart, "admin");
    assert.equal(items[0]?.notes, "旧面板");
    assert.equal(items[0]?.firstSeen, "2019-01-01T00:00:00.000Z");

    const patchRes = await client.patch(app, "/v1/messages/msg_visible/label", { label: "legit" });
    assert.equal(patchRes.statusCode, 200);
    assert.deepEqual(patchRes.json(), {
      ok: true,
      id: "msg_visible",
      label: "legit",
      originalLabel: "phish",
      originalConfidence: 0.9,
    });
    const updatedDetail = await client.get(app, "/v1/messages/msg_visible");
    assert.equal(updatedDetail.json().aiResult.label, "legit");
    assert.equal(updatedDetail.json().aiResult.originalLabel, "phish");
    assert.equal(updatedDetail.json().aiResult.manualOverride, true);
    assert.equal(
      (db.prepare("SELECT action FROM audit_log WHERE action = 'override_label'").get() as { action: string }).action,
      "override_label",
    );

    const odd = await client.get(app, "/v1/messages/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    assert.equal(odd.statusCode, 404);
    assert.equal(JSON.stringify(odd.json()).includes("passwd"), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("login is limited to five attempts in five minutes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-api-limit-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  const client = cookieJar();
  try {
    await client.csrf(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await client.post(app, "/v1/login", { username: "admin", password: "nope" });
      assert.equal(response.statusCode, 401);
    }
    const blocked = await client.post(app, "/v1/login", { username: "admin", password: "nope" });
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.json(), { error: "rate_limited" });
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dlq endpoints list, retry single and retry all dead jobs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-dlq-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const now = Date.UTC(2026, 8, 21, 12);
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: password,
      SESSION_SECRET: secret,
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
    now: () => now,
  });
  const client = cookieJar();
  try {
    await client.csrf(app);
    const login = await client.post(app, "/v1/login", { username: "admin", password });
    assert.equal(login.statusCode, 200);

    // Insert dead jobs
    db.prepare(
      `INSERT INTO jobs (id, type, message_id, status, attempts, max_attempts, run_after, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", "classify", "msg-1", "dead", 5, 5, now, "openai 503 Service Unavailable", now, now);

    db.prepare(
      `INSERT INTO jobs (id, type, message_id, status, attempts, max_attempts, run_after, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("job-2", "parse", "msg-2", "dead", 5, 5, now, "corrupt body", now, now);

    // List dead jobs
    const listRes = await client.get(app, "/v1/jobs?status=dead");
    assert.equal(listRes.statusCode, 200);
    const list = listRes.json();
    assert.equal(list.items.length, 2);
    assert.equal(list.items[0].lastError, "openai 503 Service Unavailable");

    // Retry single job
    await client.csrf(app);
    const retryOne = await client.post(app, "/v1/jobs/job-1/retry", {});
    assert.equal(retryOne.statusCode, 200);
    assert.deepEqual(retryOne.json(), { ok: true, retried: "job-1" });

    const job1 = db.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = 'job-1'").get() as any;
    assert.equal(job1.status, "queued");
    assert.equal(job1.attempts, 0);
    assert.equal(job1.last_error, null);

    // Retry all dead jobs
    const retryAll = await client.post(app, "/v1/jobs/retry-all", {});
    assert.equal(retryAll.statusCode, 200);
    assert.deepEqual(retryAll.json(), { ok: true, count: 1 });

    const job2 = db.prepare("SELECT status, attempts FROM jobs WHERE id = 'job-2'").get() as any;
    assert.equal(job2.status, "queued");
    assert.equal(job2.attempts, 0);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


function cookieJar() {
  let cookie = "";
  let token = "";
  return {
    async csrf(app: Awaited<ReturnType<typeof buildApi>>) {
      const response = await app.inject({ method: "GET", url: "/v1/csrf", headers: cookie ? { cookie } : {} });
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      token = response.json().token as string;
      assert.equal(response.statusCode, 200);
      assert.equal(typeof token, "string");
    },
    async get(app: Awaited<ReturnType<typeof buildApi>>, url: string) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async post(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: unknown) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
    async patch(app: Awaited<ReturnType<typeof buildApi>>, url: string, payload: unknown) {
      const response = await app.inject({
        method: "PATCH",
        url,
        headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
        payload,
      });
      cookie = mergeCookie(cookie, response.headers["set-cookie"]);
      return response;
    },
  };
}

function mergeCookie(current: string, setCookie: string | string[] | undefined): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const pair = (line.split(";")[0] ?? "").trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}
