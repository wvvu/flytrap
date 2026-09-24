import { rm } from "node:fs/promises";
import { PathEscapeError, resolveInside } from "../paths.js";

/** Best-effort unlink. A path that escapes the data dir is reported, not followed. */
export async function removeStoredFiles(dataDir: string, relativePaths: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const relativePath of relativePaths) {
    if (!relativePath) continue;
    try {
      await rm(resolveInside(dataDir, relativePath), { force: true });
    } catch (err) {
      if (err instanceof PathEscapeError) {
        failed.push(relativePath);
        continue;
      }
      failed.push(relativePath);
    }
  }
  return failed;
}
