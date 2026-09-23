import { createHash } from "node:crypto";

/** SHA-256 of the bytes before compression. Hex, lowercase. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256FileParts(hex: string): { h0: string; h1: string } {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("sha256 must be 64 lowercase hex characters");
  }
  return { h0: hex.slice(0, 2), h1: hex.slice(2, 4) };
}
