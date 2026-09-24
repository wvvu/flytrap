ALTER TABLE messages ADD COLUMN trashed_at INTEGER;
CREATE INDEX idx_messages_trashed ON messages(trashed_at, received_at DESC);
