CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  github_user_id TEXT,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  result TEXT NOT NULL
);
