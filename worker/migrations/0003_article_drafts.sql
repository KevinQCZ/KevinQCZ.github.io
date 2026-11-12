CREATE TABLE article_drafts (
  permalink TEXT PRIMARY KEY NOT NULL,
  source_format TEXT NOT NULL CHECK (source_format IN ('md', 'mdx')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  published_at TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  cover_url TEXT,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX article_drafts_updated_at ON article_drafts(updated_at);
