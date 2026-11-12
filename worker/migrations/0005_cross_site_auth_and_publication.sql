ALTER TABLE oauth_transactions
  ADD COLUMN return_to TEXT NOT NULL DEFAULT '/admin/';

CREATE TABLE oauth_handoffs (
  code_hash TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_handoffs_expiry ON oauth_handoffs(expires_at);

ALTER TABLE article_drafts ADD COLUMN publication_branch TEXT;
ALTER TABLE article_drafts ADD COLUMN pull_request_number INTEGER;
ALTER TABLE article_drafts ADD COLUMN pull_request_url TEXT;
ALTER TABLE article_drafts
  ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'
  CHECK (publication_state IN ('NOT_SUBMITTED', 'OPEN', 'CLOSED', 'MERGED'));
ALTER TABLE article_drafts ADD COLUMN published_sha TEXT;
ALTER TABLE article_drafts ADD COLUMN submitted_revision INTEGER;
ALTER TABLE article_drafts ADD COLUMN publication_lock TEXT;
ALTER TABLE article_drafts ADD COLUMN publication_lock_expires_at INTEGER;

CREATE UNIQUE INDEX article_drafts_publication_branch
  ON article_drafts(publication_branch)
  WHERE publication_branch IS NOT NULL;
CREATE UNIQUE INDEX article_drafts_pull_request_number
  ON article_drafts(pull_request_number)
  WHERE pull_request_number IS NOT NULL;
