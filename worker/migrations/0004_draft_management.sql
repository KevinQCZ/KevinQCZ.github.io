ALTER TABLE article_drafts ADD COLUMN id TEXT;
UPDATE article_drafts SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX article_drafts_id ON article_drafts(id);

ALTER TABLE article_drafts ADD COLUMN article_path TEXT;
ALTER TABLE article_drafts ADD COLUMN base_sha TEXT;
ALTER TABLE article_drafts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'
  CHECK (status IN ('DRAFT', 'PENDING_PUBLICATION', 'PUBLISHED', 'UNPUBLISHED'));
ALTER TABLE article_drafts ADD COLUMN created_by TEXT;
ALTER TABLE article_drafts ADD COLUMN updated_by TEXT;

CREATE UNIQUE INDEX article_drafts_article_path
  ON article_drafts(article_path)
  WHERE article_path IS NOT NULL;
CREATE INDEX article_drafts_status_updated_at
  ON article_drafts(status, updated_at DESC);

ALTER TABLE audit_logs ADD COLUMN resource_type TEXT;
ALTER TABLE audit_logs ADD COLUMN resource_id TEXT;
CREATE INDEX audit_logs_resource
  ON audit_logs(resource_type, resource_id, created_at);
