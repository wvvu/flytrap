import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import PostalMime, { type Address, type Attachment } from "postal-mime";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { linkAttachment, upsertAttachment } from "../db/repos/attachments.js";
import { sha256 } from "../hash.js";
import { attachmentRelativePath } from "../ingest/store-raw.js";
import { resolveInside } from "../paths.js";
import { extractUrls, htmlToText, truncateUtf8 } from "./text.js";

export const PARSED_TEXT_MAX_BYTES = 20 * 1024;

const mailboxSchema = z.object({ name: z.string(), address: z.string() }).strict();

export const parsedSchema = z
  .object({
    schema: z.literal(1),
    subject: z.string(),
    from: mailboxSchema.nullable(),
    replyTo: mailboxSchema.nullable(),
    text: z.string(),
    htmlBytes: z.number().int().nonnegative(),
    urls: z.array(z.string()).max(50),
    attachmentCount: z.number().int().nonnegative(),
  })
  .strict();

export type ParsedMail = z.infer<typeof parsedSchema>;

export interface ParsedMessage {
  parsed: ParsedMail;
  toAddrs: string[];
  messageId: string | null;
}

export async function parseMessage(raw: Buffer, stored: { db: Db; dataDir: string; messageId: string; now: number }): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw);
  const attachments = await storeAttachments(email.attachments, stored);
  const html = email.html ?? "";
  const plain = (email.text ?? "").trim();
  const text = truncateUtf8(plain || htmlToText(html), PARSED_TEXT_MAX_BYTES);
  const parsed = parsedSchema.parse({
    schema: 1,
    subject: (email.subject ?? "").slice(0, 2000),
    from: mailboxOf(email.from),
    replyTo: mailboxOf(email.replyTo?.[0]),
    text,
    htmlBytes: Buffer.byteLength(html),
    urls: extractUrls([email.text ?? "", html]),
    attachmentCount: attachments,
  });
  return { parsed, toAddrs: addressList(email.to), messageId: email.messageId ?? null };
}

export function addressList(value: Address[] | undefined): string[] {
  const out: string[] = [];
  for (const item of value ?? []) {
    const box = mailboxOf(item);
    if (box?.address) out.push(box.address);
  }
  return out;
}

async function storeAttachments(
  attachments: readonly Attachment[],
  stored: { db: Db; dataDir: string; messageId: string; now: number },
): Promise<number> {
  let count = 0;
  for (const attachment of attachments) {
    const bytes = attachmentBytes(attachment);
    if (!bytes || bytes.length === 0) continue;
    const hash = sha256(bytes);
    const relativePath = attachmentRelativePath(hash);
    const dest = resolveInside(stored.dataDir, relativePath);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await writeFile(dest, bytes, { flag: "wx" });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    const filename = safeFilename(attachment.filename);
    stored.db.transaction(() => {
      upsertAttachment(stored.db, {
        sha256: hash,
        path: relativePath,
        mime: attachment.mimeType || null,
        sizeBytes: bytes.length,
        now: stored.now,
      });
      linkAttachment(stored.db, {
        messageId: stored.messageId,
        sha256: hash,
        filename,
        contentId: attachment.contentId ?? null,
      });
    })();
    count += 1;
  }
  return count;
}

function attachmentBytes(attachment: Attachment): Buffer | null {
  if (typeof attachment.content === "string") {
    if (attachment.encoding === "base64") return Buffer.from(attachment.content, "base64");
    return Buffer.from(attachment.content);
  }
  if (attachment.content instanceof Uint8Array) return Buffer.from(attachment.content);
  return Buffer.from(new Uint8Array(attachment.content));
}

function mailboxOf(address: Address | undefined): { name: string; address: string } | null {
  if (!address) return null;
  if ("group" in address && address.group) {
    return mailboxOf(address.group[0]);
  }
  if (!address.address) return null;
  return { name: address.name ?? "", address: address.address };
}

function safeFilename(name: string | null): string {
  if (!name) return "";
  const base = name.split(/[/\\]/).pop() ?? "";
  return base.slice(0, 200);
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}
