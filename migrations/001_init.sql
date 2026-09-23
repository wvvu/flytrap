-- Pragmas are applied on every connection in src/db/index.ts.
-- They also run here, outside the migration transaction, so a fresh file
-- matches this document even before the application opens it.
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL,
  raw_path      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,
  envelope_from TEXT,
  envelope_to   TEXT NOT NULL,
  message_id    TEXT,
  subject       TEXT,
  from_addr     TEXT,
  to_addrs      TEXT,
  domains       TEXT NOT NULL,
  smtp_meta     TEXT NOT NULL,
  auth_result   TEXT,
  parsed        TEXT,
  ai_result     TEXT,
  status        TEXT NOT NULL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_messages_sha256 ON messages(sha256);
CREATE INDEX idx_messages_received ON messages(received_at DESC);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_from ON messages(from_addr);
CREATE INDEX idx_messages_msgid ON messages(message_id);

CREATE TABLE deliveries (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  received_at   INTEGER NOT NULL,
  smtp_meta     TEXT NOT NULL,
  UNIQUE(message_id, received_at, smtp_meta)
);

CREATE TABLE attachments (
  sha256        TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  mime          TEXT,
  size_bytes    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE message_attachments (
  message_id    TEXT NOT NULL REFERENCES messages(id),
  sha256        TEXT NOT NULL REFERENCES attachments(sha256),
  filename      TEXT,
  content_id    TEXT,
  PRIMARY KEY (message_id, sha256, filename)
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  message_id    TEXT,
  payload       TEXT,
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_after     INTEGER NOT NULL,
  locked_at     INTEGER,
  locked_by     TEXT,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_jobs_pick ON jobs(status, run_after);

CREATE TABLE mailbox_history (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  localpart     TEXT NOT NULL,
  first_seen    INTEGER,
  last_seen     INTEGER,
  source        TEXT,
  notes         TEXT,
  UNIQUE(domain, localpart)
);

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT
);
