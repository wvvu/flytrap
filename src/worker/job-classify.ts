import { ulid } from "ulid";
import { buildUserMessage, envelopeAddresses, readPrompt, recipientParts, type ClassifyFacts } from "../ai/prompt.js";
import type { Classifier } from "../ai/classifier.js";
import { finalizeAiResult, stripPrevious } from "../ai/types.js";
import { listMessageAttachments } from "../db/repos/attachments.js";
import { enqueueJob, hasOpenJob, type JobRow } from "../db/repos/jobs.js";
import { findMailboxHistory } from "../db/repos/mailbox-history.js";
import { getMessage, saveAiResult } from "../db/repos/messages.js";
import type { Db } from "../db/index.js";
import type { AppLog } from "../log.js";
import { authResultSchema } from "../mail/auth.js";
import { parsedSchema } from "../mail/parse.js";

export const PROMPT_ID = "classify-v1";

export interface ClassifyJobDeps {
  db: Db;
  promptsDir: string;
  classifier: Classifier;
  log: AppLog;
  now: () => number;
}

export async function runClassifyJob(deps: ClassifyJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("classify job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  if (!message.parsed) throw new Error("message is not parsed");
  const parsed = parsedSchema.parse(JSON.parse(message.parsed));
  const auth = message.auth_result ? authResultSchema.parse(JSON.parse(message.auth_result)) : null;
  const recipients = recipientParts(envelopeAddresses(message.envelope_to));
  const history: ClassifyFacts["history"] = [];
  const missingHistory: ClassifyFacts["missingHistory"] = [];
  for (const recipient of recipients) {
    const row = findMailboxHistory(deps.db, recipient.domain, recipient.localpart);
    if (!row) {
      missingHistory.push(recipient);
      continue;
    }
    history.push({
      domain: row.domain,
      localpart: row.localpart,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      notes: row.notes,
    });
  }
  const facts: ClassifyFacts = {
    spf: auth?.spf ?? "none",
    dkim: auth?.dkim ?? "none",
    dmarc: auth?.dmarc ?? "none",
    rdns: auth?.rdns.match ? "match" : "no-match",
    envelopeFrom: message.envelope_from ?? "",
    envelopeTo: envelopeAddresses(message.envelope_to),
    from: headerFrom(parsed.from, message.from_addr),
    subject: parsed.subject,
    messageId: message.message_id ?? "",
    text: parsed.text,
    urls: parsed.urls,
    history,
    missingHistory,
    attachments: listMessageAttachments(deps.db, message.id).map((row) => ({
      filename: row.filename ?? "",
      sha256: row.sha256,
      mime: row.mime,
      sizeBytes: row.size_bytes,
    })),
  };
  const produced = await deps.classifier.classify({
    promptId: PROMPT_ID,
    systemPrompt: readPrompt(deps.promptsDir, PROMPT_ID),
    userMessage: buildUserMessage(facts),
    facts,
  });
  const checked = finalizeAiResult(produced, previousOf(message.ai_result));
  const now = deps.now();
  saveAiResult(deps.db, message.id, JSON.stringify(checked), now);
  if (!hasOpenJob(deps.db, message.id, "notify")) {
    enqueueJob(deps.db, { id: ulid(), type: "notify", messageId: message.id, now });
  }
  deps.log.info({ messageId: message.id, label: checked.label, confidence: checked.confidence }, "classified");
}

function headerFrom(from: { name: string; address: string } | null, fallback: string | null): string {
  if (!from) return fallback ?? "";
  if (!from.name) return from.address;
  return `${from.name} <${from.address}>`;
}

function previousOf(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return stripPrevious(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
