PRAGMA foreign_keys = ON;

CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','decision','lesson','context')),
  tags TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memories_updated_idx ON memories(updated_at);
CREATE INDEX memories_kind_idx ON memories(kind, updated_at);

-- Authoritative demo corpus only. No derived chunks are seeded intentionally.
INSERT INTO memories (id,title,content,kind,tags,revision,content_hash,created_at,updated_at) VALUES
('demo-authority','Authority boundary','Memories are authoritative. Chunks and observations are derived projections that can be rebuilt.','decision','["authority","derived-data"]',1,'526baecdf04ebc02ef8497cf4d87e7b18674c9d7ea7cd46a90f36d3a08c0058e','2026-08-23T01:00:00.000Z','2026-08-23T01:00:00.000Z'),
('demo-fallback','Explicit hybrid fallback','Hybrid recall falls back to keyword only for embedding-provider failures, and the response discloses the fallback.','lesson','["search","fallback"]',1,'064e8e6aa8e55e6fc8fd25619e04ffc1fab6bb8092eaca0086761f3ebf613a8f','2026-08-23T01:01:00.000Z','2026-08-23T01:01:00.000Z'),
('demo-evidence','Evidence snapshots','Observations snapshot every source memory ID, revision, and content hash so evidence drift remains inspectable.','context','["observations","evidence"]',1,'4d0e99b234e2a202894930d35b803f21a613afdd0fa5ba12bc15e258da757612','2026-08-23T01:02:00.000Z','2026-08-23T01:02:00.000Z'),
('demo-preview','Preview-first mutation','Forget and index rebuild operations return a preview before any confirmed mutation.','note','["forget","rebuild"]',1,'6d3ddbd94337c6e345b0b19ae154cb371941b400212da6c539076626a4b12220','2026-08-23T01:03:00.000Z','2026-08-23T01:03:00.000Z');

CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  chunk_text TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  source_hash TEXT NOT NULL,
  embedding F32_BLOB(768) NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL CHECK(embedding_version >= 1),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_chunks_source_chunk_idx ON memory_chunks(memory_id, chunk_index);
CREATE INDEX memory_chunks_memory_idx ON memory_chunks(memory_id);

CREATE TABLE observations (
  id TEXT PRIMARY KEY NOT NULL,
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','retracted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX observations_status_idx ON observations(status, updated_at);

CREATE TABLE observation_sources (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(observation_id, memory_id)
);
CREATE INDEX observation_sources_memory_idx ON observation_sources(memory_id);

CREATE TABLE search_traces (
  id TEXT PRIMARY KEY NOT NULL,
  query_hash TEXT NOT NULL CHECK(length(query_hash) = 64),
  requested_mode TEXT NOT NULL CHECK(requested_mode IN ('keyword','semantic','hybrid')),
  effective_mode TEXT NOT NULL CHECK(effective_mode IN ('keyword','semantic','hybrid')),
  fallback_reason TEXT,
  kind TEXT CHECK(kind IS NULL OR kind IN ('note','decision','lesson','context')),
  requested_limit INTEGER NOT NULL CHECK(requested_limit BETWEEN 1 AND 50),
  result_count INTEGER,
  keyword_count INTEGER NOT NULL DEFAULT 0 CHECK(keyword_count >= 0),
  semantic_count INTEGER NOT NULL DEFAULT 0 CHECK(semantic_count >= 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  status TEXT NOT NULL CHECK(status IN ('completed','failed')),
  error_category TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX search_traces_created_idx ON search_traces(created_at);
