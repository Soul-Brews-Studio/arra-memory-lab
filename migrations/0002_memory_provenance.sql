PRAGMA foreign_keys = OFF;

CREATE TABLE memories_next (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','decision','lesson','context','retrospective','cheatsheet')),
  tags TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  source_path TEXT,
  created_by TEXT NOT NULL DEFAULT 'manual',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO memories_next (
  id,title,content,kind,tags,project,source_path,created_by,revision,content_hash,created_at,updated_at
)
SELECT
  id,title,content,kind,tags,NULL,NULL,'manual',revision,content_hash,created_at,updated_at
FROM memories;

DROP TABLE memories;
ALTER TABLE memories_next RENAME TO memories;

CREATE INDEX memories_updated_idx ON memories(updated_at);
CREATE INDEX memories_kind_idx ON memories(kind, updated_at);
CREATE INDEX memories_project_idx ON memories(project, updated_at);

PRAGMA foreign_keys = ON;
