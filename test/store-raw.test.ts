import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipCodec } from "../src/compress.js";
import { storeRaw } from "../src/ingest/store-raw.js";
import { PathEscapeError, resolveInside } from "../src/paths.js";

test("the same bytes land once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-raw-"));
  try {
    const codec = gzipCodec();
    const bytes = Buffer.from("Subject: hi\r\n\r\nhello\r\n");
    const first = await storeRaw({ dataDir: dir, bytes, receivedAtMs: Date.UTC(2026, 8, 21), codec });
    const second = await storeRaw({
      dataDir: dir,
      bytes,
      receivedAtMs: Date.UTC(2026, 9, 1),
      codec,
      existingRelativePath: first.relativePath,
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.sha256, second.sha256);
    assert.match(first.relativePath, /^raw\/2026\/09\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.eml\.gz$/);

    const monthDir = path.join(dir, "raw", "2026", "09");
    const files = await walk(monthDir);
    assert.equal(files.length, 1);

    const again = await storeRaw({ dataDir: dir, bytes, receivedAtMs: Date.UTC(2026, 8, 21), codec });
    assert.equal(again.duplicate, true);
    assert.equal((await walk(monthDir)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two different messages are two files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-raw-"));
  try {
    const codec = gzipCodec();
    const a = await storeRaw({
      dataDir: dir,
      bytes: Buffer.from("a"),
      receivedAtMs: Date.UTC(2026, 0, 2),
      codec,
    });
    const b = await storeRaw({
      dataDir: dir,
      bytes: Buffer.from("b"),
      receivedAtMs: Date.UTC(2026, 0, 2),
      codec,
    });
    assert.notEqual(a.sha256, b.sha256);
    assert.equal((await walk(path.join(dir, "raw"))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolved paths must stay inside the data directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flytrap-guard-"));
  try {
    const inside = path.join(dir, "raw", "note.eml.gz");
    assert.equal(resolveInside(dir, inside), path.resolve(inside));
    assert.throws(() => resolveInside(dir, path.join(dir, "..", "outside.txt")), PathEscapeError);
    assert.throws(() => resolveInside(dir, path.resolve(dir, "..", "..", "windows", "system.ini")), PathEscapeError);
    const sibling = dir + "-evil";
    assert.throws(() => resolveInside(dir, path.join(sibling, "x")), PathEscapeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}
