import type { Db } from "../index.js";

export type MessageStatus =
  | "received"
  | "authed"
  | "parsed"
  | "classified"
  | "notified"
  | "error";

export interface NewMessage {
  id: string;
  sha256: string;
  rawPath: string;
  sizeBytes: number;
  receivedAt: number;
  envelopeFrom: string | null;
  envelopeTo: string[];
  domains: string[];
  smtpMeta: unknown;
  now: number;
}

export interface NewDelivery {
  id: string;
  messageId: string;
  receivedAt: number;
  smtpMeta: unknown;
}

export interface MessageRow {
  id: string;
  sha256: string;
  raw_path: string;
  size_bytes: number;
  received_at: number;
  status: string;
  ai_result: string | null;
}

export function insertMessage(db: Db, row: NewMessage): void {
  db.prepare(
    `INSERT INTO messages (
      id, sha256, raw_path, size_bytes, received_at, envelope_from, envelope_to,
      domains, smtp_meta, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
  ).run(
    row.id,
    row.sha256,
    row.rawPath,
    row.sizeBytes,
    row.receivedAt,
    row.envelopeFrom,
    JSON.stringify(row.envelopeTo),
    JSON.stringify(row.domains),
    JSON.stringify(row.smtpMeta),
    row.now,
    row.now,
  );
}

export function findMessageBySha(db: Db, sha256: string): MessageRow | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, status, ai_result
       FROM messages WHERE sha256 = ?`,
    )
    .get(sha256) as MessageRow | undefined;
}

export function insertDelivery(db: Db, row: NewDelivery): void {
  db.prepare(
    `INSERT INTO deliveries (id, message_id, received_at, smtp_meta) VALUES (?, ?, ?, ?)`,
  ).run(row.id, row.messageId, row.receivedAt, JSON.stringify(row.smtpMeta));
}

export function markMessageError(db: Db, id: string, error: string, now: number): void {
  db.prepare(
    `UPDATE messages SET status = 'error', error = ?, updated_at = ? WHERE id = ?`,
  ).run(error.slice(0, 500), now, id);
}

export interface StoredMessage {
  id: string;
  sha256: string;
  raw_path: string;
  size_bytes: number;
  received_at: number;
  envelope_from: string | null;
  envelope_to: string;
  domains: string;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  smtp_meta: string;
  auth_result: string | null;
  parsed: string | null;
  ai_result: string | null;
  status: string;
  error: string | null;
  trashed_at: number | null;
}

export function getMessage(db: Db, id: string): StoredMessage | undefined {
  return db
    .prepare(
      `SELECT id, sha256, raw_path, size_bytes, received_at, envelope_from, envelope_to, domains,
              message_id, subject, from_addr, to_addrs, smtp_meta, auth_result, parsed, ai_result,
              status, error, trashed_at
       FROM messages WHERE id = ?`,
    )
    .get(id) as StoredMessage | undefined;
}

export function saveAuthResult(db: Db, id: string, authResult: string, now: number): void {
  db.prepare(
    `UPDATE messages
     SET auth_result = ?, status = 'authed', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(authResult, now, id);
}

export function saveParsedMessage(
  db: Db,
  row: {
    id: string;
    subject: string | null;
    fromAddr: string | null;
    toAddrs: string[] | null;
    messageId: string | null;
    parsed: string;
    now: number;
  },
): void {
  db.prepare(
    `UPDATE messages
     SET subject = ?, from_addr = ?, to_addrs = ?, message_id = ?, parsed = ?,
         status = 'parsed', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    row.subject,
    row.fromAddr,
    row.toAddrs ? JSON.stringify(row.toAddrs) : null,
    row.messageId,
    row.parsed,
    row.now,
    row.id,
  );
}

export function saveAiResult(db: Db, id: string, aiResult: string, now: number): void {
  db.prepare(
    `UPDATE messages
     SET ai_result = ?, status = 'classified', error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(aiResult, now, id);
}

export interface MessageListQuery {
  label?: string;
  status?: string;
  trashed?: boolean | "all";
  q?: string;
  from?: string;
  domain?: string;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
}

export interface MessageListRow {
  id: string;
  sha256: string;
  received_at: number;
  size_bytes: number;
  envelope_from: string | null;
  envelope_to: string;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  domains: string;
  status: string;
  ai_result: string | null;
  trashed_at: number | null;
}

export function listMessages(db: Db, query: MessageListQuery): MessageListRow[] {
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: query.limit };
  if (query.trashed === true) {
    where.push("trashed_at IS NOT NULL");
  } else if (query.trashed === "all") {
    // no filter on trashed_at
  } else {
    where.push("trashed_at IS NULL");
  }
  if (query.status) {
    where.push("status = :status");
    params.status = query.status;
  }
  if (query.label) {
    where.push("json_extract(ai_result, '$.label') = :label");
    params.label = query.label;
  }
  if (query.from) {
    where.push("lower(from_addr) = lower(:fromAddr)");
    params.fromAddr = query.from;
  }
  if (query.domain) {
    where.push("EXISTS (SELECT 1 FROM json_each(domains) WHERE lower(json_each.value) = lower(:domain))");
    params.domain = query.domain;
  }
  if (query.q) {
    where.push(`(
      IFNULL(subject, '') LIKE :q ESCAPE '\\' OR
      IFNULL(from_addr, '') LIKE :q ESCAPE '\\' OR
      IFNULL(message_id, '') LIKE :q ESCAPE '\\'
    )`);
    params.q = likeContains(query.q);
  }
  if (query.since !== undefined) {
    where.push("received_at >= :since");
    params.since = query.since;
  }
  if (query.until !== undefined) {
    where.push("received_at <= :until");
    params.until = query.until;
  }
  if (query.cursorAt !== undefined && query.cursorId) {
    where.push("(received_at < :cursorAt OR (received_at = :cursorAt AND id < :cursorId))");
    params.cursorAt = query.cursorAt;
    params.cursorId = query.cursorId;
  }
  const sql = `SELECT id, sha256, received_at, size_bytes, envelope_from, envelope_to, message_id,
                      subject, from_addr, domains, status, ai_result, trashed_at
               FROM messages
               ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY received_at DESC, id DESC
               LIMIT :limit`;
  return db.prepare(sql).all(params) as MessageListRow[];
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function markMessageNotified(db: Db, id: string, now: number): void {
  db.prepare(
    `UPDATE messages SET status = 'notified', error = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function trashMessage(db: Db, id: string, now: number): void {
  db.prepare("UPDATE messages SET trashed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

export function restoreMessage(db: Db, id: string, now: number): void {
  db.prepare("UPDATE messages SET trashed_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
}

export interface PurgedFiles {
  count: number;
  paths: string[];
}

export function deleteMessage(db: Db, id: string, purgedAt: number): PurgedFiles | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT sha256, raw_path FROM messages WHERE id = ?").get(id) as
      | { sha256: string; raw_path: string }
      | undefined;
    if (!row) return null;
    const paths = [row.raw_path, ...orphanAttachmentPaths(db, "message", id)];
    rememberPurged(db, [row.sha256], purgedAt);
    db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(id);
    deleteUnlinkedAttachments(db);
    db.prepare("DELETE FROM deliveries WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM jobs WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return { count: 1, paths };
  })();
}

export function emptyTrash(db: Db, purgedAt: number): PurgedFiles {
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT sha256, raw_path FROM messages WHERE trashed_at IS NOT NULL")
      .all() as Array<{ sha256: string; raw_path: string }>;
    if (rows.length === 0) return { count: 0, paths: [] };
    const paths = [...rows.map((row) => row.raw_path), ...orphanAttachmentPaths(db, "trash")];
    rememberPurged(
      db,
      rows.map((row) => row.sha256),
      purgedAt,
    );
    db.prepare(
      `DELETE FROM message_attachments
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    deleteUnlinkedAttachments(db);
    db.prepare(
      `DELETE FROM deliveries
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    db.prepare(
      `DELETE FROM jobs
       WHERE message_id IN (SELECT id FROM messages WHERE trashed_at IS NOT NULL)`,
    ).run();
    const result = db.prepare("DELETE FROM messages WHERE trashed_at IS NOT NULL").run();
    return { count: result.changes, paths };
  })();
}

function rememberPurged(db: Db, hashes: string[], purgedAt: number): void {
  const insert = db.prepare(
    `INSERT INTO purged_messages (sha256, purged_at) VALUES (?, ?)
     ON CONFLICT(sha256) DO UPDATE SET purged_at = excluded.purged_at`,
  );
  for (const hash of hashes) insert.run(hash, purgedAt);
}

function orphanAttachmentPaths(db: Db, scope: "message" | "trash", messageId?: string): string[] {
  const rows =
    scope === "message"
      ? (db
          .prepare(
            `SELECT a.path AS path
             FROM attachments a
             WHERE a.sha256 IN (SELECT sha256 FROM message_attachments WHERE message_id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM message_attachments other
                 WHERE other.sha256 = a.sha256 AND other.message_id != ?
               )`,
          )
          .all(messageId, messageId) as Array<{ path: string }>)
      : (db
          .prepare(
            `SELECT a.path AS path
             FROM attachments a
             WHERE EXISTS (
               SELECT 1 FROM message_attachments ma
               JOIN messages m ON m.id = ma.message_id
               WHERE ma.sha256 = a.sha256 AND m.trashed_at IS NOT NULL
             )
               AND NOT EXISTS (
                 SELECT 1 FROM message_attachments ma
                 JOIN messages m ON m.id = ma.message_id
                 WHERE ma.sha256 = a.sha256 AND m.trashed_at IS NULL
               )`,
          )
          .all() as Array<{ path: string }>);
  return rows.map((row) => row.path);
}

function deleteUnlinkedAttachments(db: Db): void {
  db.prepare(
    `DELETE FROM attachments
     WHERE NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.sha256 = attachments.sha256)`,
  ).run();
}

export function countTrash(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE trashed_at IS NOT NULL").get() as { c: number };
  return row ? row.c : 0;
}
