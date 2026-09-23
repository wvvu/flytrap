import type { Db } from "../db/index.js";
import type { JobRow } from "../db/repos/jobs.js";
import { getMessage, markMessageNotified } from "../db/repos/messages.js";
import type { AppLog } from "../log.js";
import { aiResultSchema } from "../ai/types.js";
import type { Notifier } from "../notify/types.js";

export interface NotifyJobDeps {
  db: Db;
  log: AppLog;
  now: () => number;
  notifiers: readonly Notifier[];
  notifyLabels: readonly string[];
  notifyMinConfidence: number;
  panelBaseUrl: string;
}

export async function runNotifyJob(deps: NotifyJobDeps, job: JobRow): Promise<void> {
  if (!job.message_id) throw new Error("notify job has no message");
  const message = getMessage(deps.db, job.message_id);
  if (!message) throw new Error("message missing");
  if (!message.ai_result) throw new Error("message has no ai result");
  const ai = aiResultSchema.parse(JSON.parse(message.ai_result));
  const wanted = deps.notifyLabels.includes(ai.label) && ai.confidence >= deps.notifyMinConfidence;
  if (wanted && deps.notifiers.length > 0) {
    const input = {
      messageId: message.id,
      subject: message.subject,
      from: message.from_addr,
      label: ai.label,
      confidence: ai.confidence,
      summary: ai.summary,
      panelUrl: `${deps.panelBaseUrl.replace(/\/$/, "")}/#/m/${message.id}`,
    };
    for (const notifier of deps.notifiers) {
      await notifier.notify(input);
      deps.log.info({ messageId: message.id, notifier: notifier.id, label: ai.label }, "notified");
    }
  } else {
    deps.log.info({ messageId: message.id, label: ai.label, confidence: ai.confidence }, "notify skipped");
  }
  markMessageNotified(deps.db, message.id, deps.now());
}
