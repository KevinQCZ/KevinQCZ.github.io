ALTER TABLE admin_sessions
  ADD COLUMN github_login TEXT NOT NULL DEFAULT '';

ALTER TABLE admin_sessions
  ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;

UPDATE admin_sessions
SET last_used_at = created_at
WHERE last_used_at = 0;
