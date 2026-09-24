import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import type { Codec } from "../compress.js";
import { decompressAuto } from "../compress.js";
import type { Db } from "../db/index.js";
import { enqueueJob, hasOpenJob, type JobType } from "../db/repos/jobs.js";
import { findMessageBySha, insertMessage } from "../db/repos/messages.js";
import { sha256 } from "../hash.js";
import { PathEscapeError, resolveInside } from "../paths.js";

const RAW_FILE = /^([0-9a-f]{64})\.eml\.(?:gz|zst)$/;
const PIPELINE: readonly JobType[] = ["auth", "parse", "classify"];

export interface RebuildReport {
  scanned: number;
  inserted: number;
  queued: number;
  skipped: number;
  mismatched: number;
}

/**
 * raw/ is the source of truth. Missing hashes become messages.
 * Anything still without ai_result is queued at auth so the pipeline can rerun.
 * Rows that already exist are left in place.
 */
export async function rebuildFromRaw(input: {
  db: Db;
  dataDir: string;
  codec: Codec;
  now?: number;
}): Promise<RebuildReport> {
  const now = input.now ?? Date.now();
  const report: RebuildReport = { scanned: 0, inserted: 0, queued: 0, skipped: 0, mismatched: 0 };
  const purged = input.db.prepare("SELECT 1 AS ok FROM purged_messages WHERE sha256 = ?");
  const files = await walkFiles(path.join(input.dataDir, "raw"));

  for (const abs of files) {
    const match = RAW_FILE.exec(path.basename(abs));
    const expected = match?.[1];
    if (!expected) {
      report.skipped += 1;
      continue;
    }
    report.scanned += 1;
    if (purged.get(expected)) {
      report.skipped += 1;
      continue;
    }

    let relative: string;
    let plain: Buffer;
    try {
      const resolved = resolveInside(input.dataDir, abs);
      relative = toPosix(path.relative(input.dataDir, resolved));
      plain = Buffer.from(await decompressAuto(await readFile(resolved), input.codec));
    } catch (err) {
      if (err instanceof PathEscapeError) {
        report.skipped += 1;
        continue;
      }
      report.mismatched += 1;
      continue;
    }
    if (sha256(plain) !== expected) {
      report.mismatched += 1;
      continue;
    }

    const existing = findMessageBySha(input.db, expected);
    if (!existing) {
      const info = await stat(abs);
      const receivedAt = Number.isFinite(info.mtimeMs) && info.mtimeMs > 0 ? Math.round(info.mtimeMs) : now;
      const id = ulid();
      input.db.transaction(() => {
        insertMessage(input.db, {
          id,
          sha256: expected,
          rawPath: relative,
          sizeBytes: plain.length,
          receivedAt,
          envelopeFrom: null,
          envelopeTo: [],
          domains: [],
          smtpMeta: rebuildMeta(receivedAt),
          now,
        });
        enqueueJob(input.db, {
          id: ulid(),
          type: "auth",
          messageId: id,
          payload: { source: "rebuild" },
          now,
        });
      })();
      report.inserted += 1;
      report.queued += 1;
      continue;
    }

    if (existing.ai_result === null && !pipelineOpen(input.db, existing.id)) {
      enqueueJob(input.db, {
        id: ulid(),
        type: "auth",
        messageId: existing.id,
        payload: { source: "rebuild" },
        now,
      });
      report.queued += 1;
    }
  }

  return report;
}

function pipelineOpen(db: Db, messageId: string): boolean {
  return PIPELINE.some((type) => hasOpenJob(db, messageId, type));
}

function rebuildMeta(receivedAt: number) {
  return {
    schema: 1,
    remoteIp: "0.0.0.0",
    reverseDns: null,
    helo: "",
    mailFrom: "",
    rcptTo: [] as string[],
    secure: false,
    receivedAt: new Date(receivedAt).toISOString(),
    localIp: "0.0.0.0",
    localPort: 0,
  };
}

async function walkFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\\")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
