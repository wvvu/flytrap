import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDatabase(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  applyPragmas(db);
  return db;
}

export function applyPragmas(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
}

export function dbFile(mailDataDir: string): string {
  return path.join(mailDataDir, "db", "mail.db");
}
