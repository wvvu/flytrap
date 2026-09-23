import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type CompressMode = "auto" | "zstd" | "gzip";

export interface Codec {
  name: "zstd" | "gzip";
  /** Suffix including the dot, e.g. `.eml.zst`. The hash never includes this. */
  rawExtension: string;
  compress(input: Buffer): Promise<Buffer>;
  decompress(input: Buffer): Promise<Buffer>;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export async function loadCodec(mode: CompressMode, log?: { warn: (obj: object, msg: string) => void }): Promise<Codec> {
  if (mode === "gzip") return gzipCodec();
  try {
    const mod = await import("@mongodb-js/zstd");
    const compress = mod.compress ?? mod.default?.compress;
    const decompress = mod.decompress ?? mod.default?.decompress;
    if (typeof compress !== "function" || typeof decompress !== "function") {
      throw new Error("@mongodb-js/zstd did not export compress/decompress");
    }
    return {
      name: "zstd",
      rawExtension: ".eml.zst",
      compress: (input) => Promise.resolve(compress(input)),
      decompress: (input) => Promise.resolve(decompress(input)),
    };
  } catch (err) {
    if (mode === "zstd") {
      const message = err instanceof Error ? err.message : "zstd failed to load";
      throw new Error(`COMPRESS=zstd but the native addon did not load: ${message}`);
    }
    log?.warn({ err: err instanceof Error ? err.message : "zstd unavailable" }, "falling back to gzip");
    return gzipCodec();
  }
}

export function gzipCodec(): Codec {
  return {
    name: "gzip",
    rawExtension: ".eml.gz",
    compress: (input) => gzipAsync(input),
    decompress: (input) => gunzipAsync(input),
  };
}

/** Pick a decompressor from the magic bytes so a codec switch can still read old files. */
export async function decompressAuto(bytes: Buffer, preferred: Codec): Promise<Buffer> {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    if (preferred.name === "zstd") return preferred.decompress(bytes);
    const zstd = await loadCodec("zstd");
    return zstd.decompress(bytes);
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC)) {
    return gunzipAsync(bytes);
  }
  throw new Error("unknown compression magic");
}
