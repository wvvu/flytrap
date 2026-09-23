import { readFile } from "node:fs/promises";
import { ulid } from "ulid";
import cookie from "@fastify/cookie";
import csrf from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { LABELS } from "../ai/types.js";
import type { Config } from "../config.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { findAttachment, listMessageAttachments } from "../db/repos/attachments.js";
import { writeAudit } from "../db/repos/audit.js";
import { enqueueJob, hasOpenJob } from "../db/repos/jobs.js";
import { listMailboxHistory, upsertMailboxHistory } from "../db/repos/mailbox-history.js";
import { getMessage, listMessages } from "../db/repos/messages.js";
import { sha256 } from "../hash.js";
import { readRaw } from "../ingest/read-raw.js";
import { PathEscapeError, resolveInside } from "../paths.js";
import { actorName, decodeCursor, encodeCursor, errorName, HttpError, iso, parseJson, publicError, safeMime } from "./http.js";
import { credentialsMatch } from "./password.js";

declare module "fastify" {
  interface Session {
    user?: string;
  }
}

const STATUSES = ["received", "authed", "parsed", "classified", "notified", "error"] as const;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const loginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

const historyBody = z.object({
  domain: z.string().min(1).max(253),
  localpart: z.string().min(1).max(64),
  firstSeen: z.union([z.string(), z.number(), z.null()]).optional(),
  lastSeen: z.union([z.string(), z.number(), z.null()]).optional(),
  source: z.string().max(32).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
}).strict();

export interface ApiOptions {
  config: Config;
  db: Db;
  codec: Codec;
  log?: FastifyServerOptions["logger"];
  now?: () => number;
}

export interface RunningApi {
  port: number;
  close: () => Promise<void>;
}

export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger: options.log ?? false,
    trustProxy: false,
  });
  const { config, db, codec } = options;

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret ?? "",
    cookieName: "flytrap.sid",
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  await app.register(csrf, { sessionPlugin: "@fastify/session" });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new HttpError(429, "rate_limited"),
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });
  app.setErrorHandler((err: unknown, request, reply) => {
    const error = err instanceof Error ? err : new Error("request failed");
    const statusCode = typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const status = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error.name }, "request failed");
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: errorName(status) });
  });

  app.addHook("onRequest", (request, reply, done) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      done();
      return;
    }
    app.csrfProtection(request, reply, done);
  });
  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent || isPublic(request.url)) return;
    if (!request.session.user) return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/healthz", async () => {
    db.prepare("SELECT 1").get();
    return { ok: true, roles: config.roles, db: "ok" };
  });

  app.get("/v1/csrf", async (request, reply) => {
    return { token: reply.generateCsrf() };
  });

  app.post("/v1/login", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const ok = credentialsMatch(body.data.username, body.data.password, config.apiUsername, config.apiPassword ?? "");
    const actor = actorName(body.data.username);
    if (!ok) {
      writeAudit(db, { id: ulid(), at: now(), actor, action: "login_failed" });
      throw new HttpError(401, "unauthorized");
    }
    await request.session.regenerate();
    request.session.user = config.apiUsername;
    writeAudit(db, { id: ulid(), at: now(), actor: config.apiUsername, action: "login" });
    return reply.send({ user: config.apiUsername });
  });

  app.post("/v1/logout", async (request, reply) => {
    const actor = request.session.user ?? "unknown";
    writeAudit(db, { id: ulid(), at: now(), actor, action: "logout" });
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/v1/me", async (request) => ({ user: request.session.user }));

  app.get("/v1/messages", async (request) => {
    const query = readListQuery(request.query);
    const rows = listMessages(db, { ...query, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.received_at, last.id) : null,
    };
  });

  app.get("/v1/messages/:id", async (request) => toDetail(db, messageId(request)));

  app.get("/v1/messages/:id/text", async (request) => {
    const message = requireMessage(db, messageId(request));
    const parsed = parseJson(message.parsed);
    const text = parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string" ? parsed.text : null;
    if (text === null) throw new HttpError(404, "not_found");
    return { text };
  });

  app.get("/v1/messages/:id/raw", async (request, reply) => {
    const message = requireMessage(db, messageId(request));
    let bytes: Buffer;
    try {
      bytes = await readRaw(config.mailDataDir, message.raw_path, codec, message.sha256);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    return reply
      .header("content-type", "message/rfc822")
      .header("content-disposition", `attachment; filename="${message.sha256}.eml"`)
      .send(bytes);
  });

  app.post("/v1/messages/:id/reclassify", async (request, reply) => {
    const id = messageId(request);
    requireMessage(db, id);
    const at = now();
    if (!hasOpenJob(db, id, "classify")) {
      enqueueJob(db, { id: ulid(), type: "classify", messageId: id, now: at });
    }
    writeAudit(db, { id: ulid(), at, actor: request.session.user ?? "unknown", action: "reclassify", target: id });
    return reply.code(202).send({ queued: true });
  });

  app.get("/v1/attachments/:sha256", async (request, reply) => {
    const sha = attachmentId(request);
    const row = findAttachment(db, sha);
    if (!row) throw new HttpError(404, "not_found");
    let abs: string;
    try {
      abs = resolveInside(config.mailDataDir, row.path);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    const bytes = await readFile(abs).catch(() => {
      throw new HttpError(404, "not_found");
    });
    if (sha256(bytes) !== sha) throw new HttpError(404, "not_found");
    return reply
      .header("content-type", safeMime(row.mime))
      .header("content-disposition", `attachment; filename="${sha}"`)
      .send(bytes);
  });

  app.get("/v1/jobs", async () => {
    const rows = db
      .prepare(
        `SELECT id, type, message_id, status, attempts, max_attempts, run_after, last_error, created_at
         FROM jobs ORDER BY created_at DESC LIMIT 200`,
      )
      .all() as Array<{
      id: string;
      type: string;
      message_id: string | null;
      status: string;
      attempts: number;
      max_attempts: number;
      run_after: number;
      last_error: string | null;
      created_at: number;
    }>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        messageId: row.message_id,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        runAfter: iso(row.run_after),
        lastError: publicError(row.last_error),
        createdAt: iso(row.created_at),
      })),
    };
  });

  app.get("/v1/stats", async () => {
    const start = utcDayStart(now());
    return { today: countLabels(db, start), total: countLabels(db, null) };
  });

  app.get("/v1/mailbox-history", async (request) => {
    const query = request.query as Record<string, unknown>;
    const domain = optionalString(query.domain);
    const localpart = optionalString(query.localpart);
    return {
      items: listMailboxHistory(db, {
        domain: domain?.toLowerCase(),
        localpart: localpart?.toLowerCase(),
      }).map(toHistory),
    };
  });

  app.post("/v1/mailbox-history", async (request, reply) => {
    const body = historyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const domain = body.data.domain.trim().toLowerCase().replace(/\.$/, "");
    const localpart = body.data.localpart.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
      throw new HttpError(400);
    }
    upsertMailboxHistory(db, {
      domain,
      localpart,
      firstSeen: optionalTime(body.data.firstSeen),
      lastSeen: optionalTime(body.data.lastSeen),
      source: body.data.source ?? null,
      notes: body.data.notes ?? null,
    });
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "mailbox_history_upsert",
      target: `${localpart}@${domain}`,
    });
    return reply.code(201).send({ ok: true });
  });

  return app;
}

export async function startApi(options: ApiOptions): Promise<RunningApi> {
  const app = await buildApi(options);
  await app.listen({ host: options.config.apiHost, port: options.config.apiPort });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : options.config.apiPort;
  return { port, close: () => app.close() };
}

function isPublic(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path === "/healthz" || path === "/v1/login" || path === "/v1/csrf";
}

function messageId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new HttpError(404, "not_found");
  return id;
}

function attachmentId(request: FastifyRequest): string {
  const sha = (request.params as { sha256?: unknown }).sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(404, "not_found");
  return sha;
}

function requireMessage(db: Db, id: string) {
  const message = getMessage(db, id);
  if (!message) throw new HttpError(404, "not_found");
  return message;
}

function readListQuery(query: unknown): {
  label?: string;
  status?: string;
  q?: string;
  from?: string;
  domain?: string;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
} {
  const source = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const label = optionalString(source.label);
  const status = optionalString(source.status);
  const q = optionalString(source.q);
  const from = optionalString(source.from);
  const domain = optionalString(source.domain);
  const since = optionalString(source.since);
  const until = optionalString(source.until);
  const limitRaw = optionalString(source.limit);
  const cursor = optionalString(source.cursor);
  if (label && !LABELS.includes(label as (typeof LABELS)[number])) throw new HttpError(400);
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400);
  if (q && q.length > 200) throw new HttpError(400);
  let limit = 50;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
    limit = Number(limitRaw);
    if (limit < 1 || limit > 200) throw new HttpError(400);
  }
  let cursorAt: number | undefined;
  let cursorId: string | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw new HttpError(400);
    cursorAt = decoded.receivedAt;
    cursorId = decoded.id;
  }
  return {
    label,
    status,
    q,
    from,
    domain,
    since: since === undefined ? undefined : parseTime(since),
    until: until === undefined ? undefined : parseTime(until),
    limit,
    cursorAt,
    cursorId,
  };
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400);
  return value;
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400);
  return ms;
}

function optionalTime(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") return parseTime(value);
  throw new HttpError(400);
}

function toListItem(row: ReturnType<typeof listMessages>[number]) {
  const ai = aiSummary(row.ai_result);
  return {
    id: row.id,
    sha256: row.sha256,
    receivedAt: iso(row.received_at),
    sizeBytes: row.size_bytes,
    envelopeFrom: row.envelope_from,
    envelopeTo: parseJson(row.envelope_to),
    messageId: row.message_id,
    subject: row.subject,
    from: row.from_addr,
    domains: parseJson(row.domains),
    status: row.status,
    label: ai.label,
    confidence: ai.confidence,
    summary: ai.summary,
    tags: ai.tags,
  };
}

function toDetail(db: Db, id: string) {
  const message = requireMessage(db, id);
  return {
    id: message.id,
    sha256: message.sha256,
    receivedAt: iso(message.received_at),
    sizeBytes: message.size_bytes,
    status: message.status,
    error: publicError(message.error),
    envelopeFrom: message.envelope_from,
    envelopeTo: parseJson(message.envelope_to),
    messageId: message.message_id,
    subject: message.subject,
    from: message.from_addr,
    to: parseJson(message.to_addrs),
    domains: parseJson(message.domains),
    smtpMeta: parseJson(message.smtp_meta),
    authResult: parseJson(message.auth_result),
    parsed: parseJson(message.parsed),
    aiResult: parseJson(message.ai_result),
    attachments: listMessageAttachments(db, id).map((row) => ({
      sha256: row.sha256,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.size_bytes,
    })),
  };
}

function aiSummary(raw: string | null): { label: string | null; confidence: number | null; summary: string | null; tags: string[] } {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return { label: null, confidence: null, summary: null, tags: [] };
  const record = value as Record<string, unknown>;
  return {
    label: typeof record.label === "string" ? record.label : null,
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    summary: typeof record.summary === "string" ? record.summary : null,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

function countLabels(db: Db, since: number | null): Record<string, number> {
  const rows = (
    since === null
      ? db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages GROUP BY 1").all()
      : db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages WHERE received_at >= ? GROUP BY 1").all(since)
  ) as Array<{ label: string | null; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.label ?? "unlabeled"] = row.n;
  return out;
}

function toHistory(row: { domain: string; localpart: string; first_seen: number | null; last_seen: number | null; source: string | null; notes: string | null }) {
  return {
    domain: row.domain,
    localpart: row.localpart,
    firstSeen: row.first_seen === null ? null : iso(row.first_seen),
    lastSeen: row.last_seen === null ? null : iso(row.last_seen),
    source: row.source,
    notes: row.notes,
  };
}

function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
