import { ulid } from "ulid";
import type { Db } from "../index.js";

export interface MailboxHistoryRow {
  domain: string;
  localpart: string;
  first_seen: number | null;
  last_seen: number | null;
  source: string | null;
  notes: string | null;
}

export function findMailboxHistory(db: Db, domain: string, localpart: string): MailboxHistoryRow | undefined {
  return db
    .prepare(
      `SELECT domain, localpart, first_seen, last_seen, source, notes
       FROM mailbox_history
       WHERE lower(domain) = lower(?) AND lower(localpart) = lower(?)`,
    )
    .get(domain, localpart) as MailboxHistoryRow | undefined;
}

export function listMailboxHistory(
  db: Db,
  filter: { domain?: string; localpart?: string },
): MailboxHistoryRow[] {
  return db
    .prepare(
      `SELECT domain, localpart, first_seen, last_seen, source, notes
       FROM mailbox_history
       WHERE (:domain IS NULL OR lower(domain) = lower(:domain))
         AND (:localpart IS NULL OR lower(localpart) = lower(:localpart))
       ORDER BY domain, localpart
       LIMIT 500`,
    )
    .all({ domain: filter.domain ?? null, localpart: filter.localpart ?? null }) as MailboxHistoryRow[];
}

export function upsertMailboxHistory(
  db: Db,
  row: {
    domain: string;
    localpart: string;
    firstSeen: number | null;
    lastSeen: number | null;
    source: string | null;
    notes: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO mailbox_history (id, domain, localpart, first_seen, last_seen, source, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, localpart) DO UPDATE SET
       first_seen = COALESCE(excluded.first_seen, mailbox_history.first_seen),
       last_seen = COALESCE(excluded.last_seen, mailbox_history.last_seen),
       source = COALESCE(excluded.source, mailbox_history.source),
       notes = COALESCE(excluded.notes, mailbox_history.notes)`,
  ).run(ulid(), row.domain, row.localpart, row.firstSeen, row.lastSeen, row.source, row.notes);
}
