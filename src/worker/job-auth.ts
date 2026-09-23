import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import { enqueueJob, hasOpenJob, type JobRow } from "../db/repos/jobs.js";
import { getMessage, saveAuthResult } from "../db/repos/messages.js";
import type { Codec } from "../compress.js";
import { readRaw } from "../ingest/read-raw.js";
import {
  DNS_ATTEMPTS,
  dnsTempAuth,
  isDnsFailure,
  type AuthResult,
  type Authenticator,
} from "../mail/auth.js";
import type { AppLog } from "../log.js";
import type { SmtpMeta } from "../smtp/session-meta.js";

export interface AuthJobDeps {
  db: Db;
  dataDir: string;
  codec: Codec;
  banner: string;
  authenticate: Authenticator;
  log: AppLog;
  now: () => number;
}

export async function runAuthJob(deps: AuthJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("auth job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  const meta = readMeta(message.smtp_meta);
  const raw = await readRaw(deps.dataDir, message.raw_path, deps.codec, message.sha256);
  let auth: AuthResult;
  try {
    auth = await deps.authenticate({
      raw,
      ip: meta.remoteIp,
      helo: meta.helo,
      sender: meta.mailFrom,
      mta: deps.banner,
      ptr: meta.reverseDns,
    });
  } catch (err) {
    if (!isDnsFailure(err) || job.attempts + 1 < DNS_ATTEMPTS) throw err;
    auth = dnsTempAuth({ ptr: meta.reverseDns, helo: meta.helo });
    deps.log.warn({ messageId: message.id, attempts: job.attempts + 1 }, "auth dns gave up");
  }
  const now = deps.now();
  saveAuthResult(deps.db, message.id, JSON.stringify(auth), now);
  if (!hasOpenJob(deps.db, message.id, "parse")) {
    enqueueJob(deps.db, { id: ulid(), type: "parse", messageId: message.id, now });
  }
  deps.log.info(
    { messageId: message.id, spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, arc: auth.arc },
    "auth done",
  );
}

function readMeta(raw: string): SmtpMeta {
  const value = JSON.parse(raw) as Partial<SmtpMeta>;
  if (!value || value.schema !== 1 || typeof value.remoteIp !== "string") {
    throw new Error("smtp_meta is not schema 1");
  }
  return {
    schema: 1,
    remoteIp: value.remoteIp,
    reverseDns: typeof value.reverseDns === "string" ? value.reverseDns : null,
    helo: typeof value.helo === "string" ? value.helo : "",
    mailFrom: typeof value.mailFrom === "string" ? value.mailFrom : "",
    rcptTo: Array.isArray(value.rcptTo) ? value.rcptTo.filter((item): item is string => typeof item === "string") : [],
    secure: Boolean(value.secure),
    receivedAt: typeof value.receivedAt === "string" ? value.receivedAt : "",
    localIp: typeof value.localIp === "string" ? value.localIp : "",
    localPort: typeof value.localPort === "number" ? value.localPort : 0,
  };
}
