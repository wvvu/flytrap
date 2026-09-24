-- Expression and queue indexes, case-folded mailbox identity, and a purge tombstone.
-- raw/ stays the rebuild source of truth; a deleted sha must not come back if the
-- file unlink happens late or fails.

CREATE TABLE purged_messages (
  sha256    TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL
);

DROP INDEX IF EXISTS idx_messages_from;
CREATE INDEX idx_messages_from_lower ON messages(lower(from_addr));
CREATE INDEX idx_messages_label ON messages(json_extract(ai_result, '$.label'));

CREATE INDEX idx_jobs_message_id ON jobs(message_id);
CREATE INDEX idx_jobs_queued_created ON jobs(created_at, run_after) WHERE status = 'queued';
CREATE INDEX idx_jobs_status_created ON jobs(status, created_at DESC);

DELETE FROM mailbox_history
WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid,
           ROW_NUMBER() OVER (
             PARTITION BY lower(domain), lower(localpart)
             ORDER BY COALESCE(first_seen, 9223372036854775807), rowid
           ) AS rn
    FROM mailbox_history
  )
  WHERE rn = 1
);

UPDATE mailbox_history
SET domain = lower(domain),
    localpart = lower(localpart);

CREATE UNIQUE INDEX idx_mailbox_history_lower
  ON mailbox_history(lower(domain), lower(localpart));
