import { readFile } from "node:fs/promises";
import { decompressAuto, type Codec } from "../compress.js";
import { sha256 } from "../hash.js";
import { resolveInside } from "../paths.js";

/** Decompress a stored message and refuse it when the bytes no longer match the index. */
export async function readRaw(dataDir: string, relativePath: string, codec: Codec, expectedSha256: string): Promise<Buffer> {
  const abs = resolveInside(dataDir, relativePath);
  const compressed = await readFile(abs);
  const plain = Buffer.from(await decompressAuto(compressed, codec));
  if (sha256(plain) !== expectedSha256) {
    throw new Error("raw hash mismatch");
  }
  return plain;
}
