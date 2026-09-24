import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolveInside } from "../paths.js";
import { splitAddress } from "../smtp/policy.js";

export interface HistoryFact {
  domain: string;
  localpart: string;
  firstSeen: number | null;
  lastSeen: number | null;
  notes: string | null;
}

export interface PromptAttachment {
  filename: string;
  sha256: string;
  mime: string | null;
  sizeBytes: number;
}

export interface ClassifyFacts {
  spf: string;
  dkim: string;
  dmarc: string;
  rdns: "match" | "no-match";
  envelopeFrom: string;
  envelopeTo: string[];
  from: string;
  subject: string;
  messageId: string;
  text: string;
  urls: string[];
  history: HistoryFact[];
  missingHistory: Array<{ domain: string; localpart: string }>;
  attachments: PromptAttachment[];
}

export function readPrompt(dir: string, id = "classify-v1"): string {
  let file: string;
  try {
    file = resolveInside(dir, `${id}.txt`);
  } catch {
    throw new Error(`prompt ${id} is outside the prompts directory`);
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`prompt ${id} is missing`);
  }
}

export function listPrompts(dir: string): Array<{ id: string; name: string }> {
  try {
    const files = readdirSync(dir);
    return files
      .filter((f) => f.endsWith(".txt"))
      .map((f) => {
        const id = f.replace(/\.txt$/, "");
        return { id, name: id };
      });
  } catch {
    return [{ id: "classify-v1", name: "classify-v1" }];
  }
}

export function savePrompt(dir: string, id: string, content: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("invalid prompt id");
  }
  const file = resolveInside(dir, `${id}.txt`);
  writeFileSync(file, content, "utf8");
}

export function buildUserMessage(facts: ClassifyFacts): string {
  const from = facts.envelopeFrom ? facts.envelopeFrom : "<>";
  const lines = [
    `AUTH: spf= ${facts.spf} dkim= ${facts.dkim} dmarc= ${facts.dmarc} rdns= ${facts.rdns}`,
    `ENVELOPE: from=${from} to=${facts.envelopeTo.join(",")}`,
    `HEADER: From=${oneLine(facts.from)} Subject=${oneLine(facts.subject)} Message-ID=${oneLine(facts.messageId)}`,
  ];
  if (facts.history.length === 0 && facts.missingHistory.length === 0) {
    lines.push("HISTORY: none");
  }
  for (const row of facts.history) {
    const notes = row.notes ? ` notes=${JSON.stringify(row.notes)}` : "";
    lines.push(
      `HISTORY: localpart "${row.localpart}" on ${row.domain} first_seen=${day(row.firstSeen)} last_seen=${day(row.lastSeen)}${notes}`,
    );
  }
  for (const row of facts.missingHistory) {
    lines.push(`HISTORY: localpart "${row.localpart}" on ${row.domain} no-record`);
  }
  lines.push("TEXT:", facts.text, "URLS:");
  if (facts.urls.length === 0) lines.push("-");
  for (const url of facts.urls) lines.push(`- ${url}`);
  lines.push("ATTACHMENTS:");
  if (facts.attachments.length === 0) lines.push("-");
  for (const attachment of facts.attachments) {
    const name = attachment.filename || "(unnamed)";
    const mime = attachment.mime || "application/octet-stream";
    lines.push(`- ${name} sha256=${attachment.sha256} mime=${mime} size=${formatSize(attachment.sizeBytes)}`);
  }
  return lines.join("\n");
}

export function envelopeAddresses(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

export function recipientParts(addresses: readonly string[]): Array<{ domain: string; localpart: string }> {
  const out: Array<{ domain: string; localpart: string }> = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const parts = splitAddress(address);
    if (!parts) continue;
    const key = `${parts.localpart.toLowerCase()}@${parts.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parts);
  }
  return out;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function day(ms: number | null): string {
  if (!ms) return "unknown";
  return new Date(ms).toISOString().slice(0, 10);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}m`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}k`;
  return `${bytes}b`;
}
