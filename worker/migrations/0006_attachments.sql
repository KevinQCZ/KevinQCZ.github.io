CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  display_filename TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  detected_mime_type TEXT NOT NULL,
  declared_mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  r2_object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('uploading', 'active', 'failed', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'published')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX attachments_status_created ON attachments(upload_status, created_at DESC);
CREATE INDEX attachments_extension ON attachments(file_extension, upload_status);
CREATE INDEX attachments_uploaded_by ON attachments(uploaded_by, created_at DESC);

CREATE TABLE article_attachments (
  article_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  display_order INTEGER NOT NULL DEFAULT 0,
  position INTEGER,
  inserted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, attachment_id)
);

CREATE INDEX article_attachments_attachment ON article_attachments(attachment_id, article_id);

CREATE TABLE attachment_revisions (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  previous_object_key TEXT NOT NULL,
  new_object_key TEXT NOT NULL,
  previous_checksum TEXT NOT NULL,
  new_checksum TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE INDEX attachment_revisions_attachment ON attachment_revisions(attachment_id, changed_at DESC);

ALTER TABLE audit_logs ADD COLUMN article_id TEXT;
