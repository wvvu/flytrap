import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decompressAuto, type Codec } from "../compress.js";
import { sha256, sha256FileParts } from "../hash.js";
import { resolveInside } from "../paths.js";

export interface StoreRawInput {
  dataDir: string;
  bytes: Buffer;
  receivedAtMs: number;
  codec: Codec;
  /** Relative path already recorded for this hash. Skip the write when it still matches. */
  existingRelativePath?: string | null;
}

export interface StoreRawResult {
  sha256: string;
  relativePath: string;
  duplicate: boolean;
  sizeBytes: number;
}

export async function storeRaw(input: StoreRawInput): Promise<StoreRawResult> {
  const hash = sha256(input.bytes);
  const sizeBytes = input.bytes.length;
  if (input.existingRelativePath) {
    await assertStoredBytes(input.dataDir, input.existingRelativePath, input.codec, hash);
    return { sha256: hash, relativePath: toPosix(input.existingRelativePath), duplicate: true, sizeBytes };
  }

  const relativePath = rawRelativePath(hash, input.receivedAtMs, input.codec.rawExtension);
  const dest = resolveInside(input.dataDir, relativePath);
  try {
    const existing = await readFile(dest);
    await assertBytes(existing, input.codec, hash);
    return { sha256: hash, relativePath, duplicate: true, sizeBytes };
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${randomBytes(6).toString("hex")}`;
  const compressed = Buffer.from(await input.codec.compress(input.bytes));
  try {
    await writeFile(tmp, compressed, { flag: "wx" });
    const readBack = await readFile(tmp);
    await assertBytes(readBack, input.codec, hash);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { sha256: hash, relativePath, duplicate: false, sizeBytes };
}

export function rawRelativePath(hash: string, receivedAtMs: number, extension: string): string {
  const when = new Date(receivedAtMs);
  const yyyy = String(when.getUTCFullYear());
  const mm = String(when.getUTCMonth() + 1).padStart(2, "0");
  const { h0, h1 } = sha256FileParts(hash);
  return ["raw", yyyy, mm, h0, h1, `${hash}${extension}`].join("/");
}

export function attachmentRelativePath(hash: string): string {
  const { h0, h1 } = sha256FileParts(hash);
  return ["attachments", h0, h1, hash].join("/");
}

async function assertStoredBytes(dataDir: string, relativePath: string, codec: Codec, hash: string): Promise<void> {
  const abs = resolveInside(dataDir, relativePath);
  const bytes = await readFile(abs);
  await assertBytes(bytes, codec, hash);
}

async function assertBytes(compressed: Buffer, codec: Codec, hash: string): Promise<void> {
  const plain = Buffer.from(await decompressAuto(compressed, codec));
  if (sha256(plain) !== hash) {
    throw new Error("stored bytes do not match sha256");
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
