import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { enqueueJob, hasOpenJob, type JobRow } from "../db/repos/jobs.js";
import { getMessage, saveParsedMessage } from "../db/repos/messages.js";
import type { Codec } from "../compress.js";
import { readRaw } from "../ingest/read-raw.js";
import type { AppLog } from "../log.js";
import { parseMessage } from "../mail/parse.js";

export interface ParseJobDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  log: AppLog;
  now: () => number;
}

/** Parse always runs, including when authentication failed. Classification is queued after it. */
export async function runParseJob(deps: ParseJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("parse job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  const raw = await readRaw(deps.dataDir, message.raw_path, deps.codec, message.sha256);
  const result = await parseMessage(raw, {
    db: deps.db,
    dataDir: deps.dataDir,
    messageId: message.id,
    now: deps.now(),
  });
  saveParsedMessage(deps.db, {
    id: message.id,
    subject: result.parsed.subject || null,
    fromAddr: result.parsed.from?.address ?? null,
    toAddrs: result.toAddrs,
    messageId: result.messageId,
    parsed: JSON.stringify(result.parsed),
    now: deps.now(),
  });
  const now = deps.now();
  if (!hasOpenJob(deps.db, message.id, "classify")) {
    enqueueJob(deps.db, { id: ulid(), type: "classify", messageId: message.id, now });
  }
  deps.log.info(
    { messageId: message.id, attachments: result.parsed.attachmentCount, urls: result.parsed.urls.length },
    "parse done",
  );
}
