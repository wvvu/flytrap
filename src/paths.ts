import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root for both `src/` (tsx) and `dist/` (node). */
export function appRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function migrationsDir(): string {
  return path.join(appRoot(), "migrations");
}

export function defaultPromptsDir(): string {
  return path.join(appRoot(), "prompts");
}

export function ensureDataDirs(mailDataDir: string): void {
  mkdirSync(path.join(mailDataDir, "db"), { recursive: true });
  mkdirSync(path.join(mailDataDir, "raw"), { recursive: true });
  mkdirSync(path.join(mailDataDir, "attachments"), { recursive: true });
}

/**
 * Physical boundary for anything read from SQLite paths.
 * The resolved file must sit strictly inside `root`.
 * On Windows the comparison is case-insensitive, because the filesystem is.
 */
export function resolveInside(root: string, candidate: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(
    path.isAbsolute(candidate) ? candidate : path.join(rootResolved, candidate),
  );
  const prefix = cmp(rootResolved).endsWith(path.sep)
    ? cmp(rootResolved)
    : cmp(rootResolved) + path.sep;
  if (!cmp(resolved).startsWith(prefix)) {
    throw new PathEscapeError();
  }
  return resolved;
}

function cmp(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class PathEscapeError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("not_found");
    this.name = "PathEscapeError";
  }
}
