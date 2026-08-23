PRAGMA foreign_keys = ON;

ALTER TABLE memories ADD COLUMN supersedes_memory_id TEXT;
ALTER TABLE memories ADD COLUMN supersedes_revision INTEGER CHECK(supersedes_revision IS NULL OR supersedes_revision >= 1);
ALTER TABLE memories ADD COLUMN supersedes_hash TEXT;

CREATE TABLE search_trace_results (
  trace_id TEXT NOT NULL REFERENCES search_traces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank >= 1),
  score REAL NOT NULL,
  keyword_rank INTEGER,
  semantic_rank INTEGER,
  semantic_distance REAL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(trace_id, rank)
);
CREATE UNIQUE INDEX search_trace_results_memory_idx ON search_trace_results(trace_id, memory_id);
