import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { enqueueJob } from "../db/repos/jobs.js";
import { findMessageBySha, insertDelivery, insertMessage } from "../db/repos/messages.js";
import { sha256 } from "../hash.js";
import type { Codec } from "../compress.js";
import { storeRaw } from "./store-raw.js";
import type { SmtpMeta } from "../smtp/session-meta.js";

export interface AcceptInput {
  bytes: Buffer;
  meta: SmtpMeta;
  receivedAtMs: number;
}

export interface AcceptDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  /** Test seam. Production uses the real writer. */
  writeRaw?: typeof storeRaw;
}

export interface AcceptResult {
  id: string;
  sha256: string;
  duplicate: boolean;
  sizeBytes: number;
}

/**
 * Write the raw bytes first. The database row is inserted only after the
 * file is in place and the hash of the bytes we just stored matches.
 * A second delivery of the same hash adds a delivery and does not requeue AI.
 */
export async function acceptMessage(deps: AcceptDeps, input: AcceptInput): Promise<AcceptResult> {
  const hash = sha256(input.bytes);
  const existing = findMessageBySha(deps.db, hash);
  const writeRaw = deps.writeRaw ?? storeRaw;
  const stored = await writeRaw({
    dataDir: deps.dataDir,
    bytes: input.bytes,
    receivedAtMs: input.receivedAtMs,
    codec: deps.codec,
    existingRelativePath: existing?.raw_path ?? null,
  });

  try {
    const recorded = deps.db.transaction(() => record(deps.db, stored.sha256, stored.relativePath, input))();
    return { ...recorded, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
  } catch (err) {
    if (!isUnique(err)) throw err;
    const winner = findMessageBySha(deps.db, stored.sha256);
    if (!winner) throw err;
    insertDeliverySoft(deps.db, winner.id, input);
    return { id: winner.id, sha256: stored.sha256, duplicate: true, sizeBytes: stored.sizeBytes };
  }
}

function record(db: Db, hash: string, rawPath: string, input: AcceptInput): { id: string; duplicate: boolean } {
  const current = findMessageBySha(db, hash);
  if (current) {
    insertDeliverySoft(db, current.id, input);
    return { id: current.id, duplicate: true };
  }
  const id = ulid();
  const domains = uniqueDomains(input.meta.rcptTo);
  insertMessage(db, {
    id,
    sha256: hash,
    rawPath,
    sizeBytes: input.bytes.length,
    receivedAt: input.receivedAtMs,
    envelopeFrom: input.meta.mailFrom,
    envelopeTo: input.meta.rcptTo,
    domains,
    smtpMeta: input.meta,
    now: input.receivedAtMs,
  });
  insertDelivery(db, {
    id: ulid(),
    messageId: id,
    receivedAt: input.receivedAtMs,
    smtpMeta: input.meta,
  });
  enqueueJob(db, {
    id: ulid(),
    type: "auth",
    messageId: id,
    payload: { source: "smtp" },
    now: input.receivedAtMs,
  });
  return { id, duplicate: false };
}

function insertDeliverySoft(db: Db, messageId: string, input: AcceptInput): void {
  try {
    insertDelivery(db, {
      id: ulid(),
      messageId,
      receivedAt: input.receivedAtMs,
      smtpMeta: input.meta,
    });
  } catch (err) {
    if (!isUnique(err)) throw err;
  }
}

function uniqueDomains(rcptTo: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const address of rcptTo) {
    const at = address.lastIndexOf("@");
    if (at > 0) domains.add(address.slice(at + 1).trim().toLowerCase().replace(/\.$/, ""));
  }
  return [...domains];
}

function isUnique(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = String(err.code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}
