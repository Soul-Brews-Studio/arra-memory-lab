import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
export const EMBEDDING_VERSION = 1;
export const MEMORY_KINDS = ["note", "decision", "lesson", "context", "retrospective", "cheatsheet"] as const;
export const OBSERVATION_STATUSES = ["active", "stale", "retracted"] as const;
export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;

const float32Vector = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
  driverOutput: Uint8Array | ArrayBuffer | number[];
  config: { dimensions: number };
}>({
  dataType(config) {
    return `F32_BLOB(${config?.dimensions ?? EMBEDDING_DIMENSIONS})`;
  },
  fromDriver(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return Uint8Array.from(value);
  }
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  kind: text("kind", { enum: MEMORY_KINDS }).notNull().default("note"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  project: text("project"),
  sourcePath: text("source_path"),
  createdBy: text("created_by").notNull().default("manual"),
  supersedesMemoryId: text("supersedes_memory_id"),
  supersedesRevision: integer("supersedes_revision"),
  supersedesHash: text("supersedes_hash"),
  revision: integer("revision").notNull().default(1),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("memories_updated_idx").on(table.updatedAt),
  index("memories_kind_idx").on(table.kind, table.updatedAt),
  index("memories_project_idx").on(table.project, table.updatedAt),
  check("memories_revision_check", sql`${table.revision} >= 1`),
  check("memories_supersedes_revision_check", sql`${table.supersedesRevision} IS NULL OR ${table.supersedesRevision} >= 1`),
  check("memories_title_check", sql`length(${table.title}) BETWEEN 1 AND 160`),
  check("memories_content_check", sql`length(${table.content}) BETWEEN 1 AND 12000`)
]);

export const memoryChunks = sqliteTable("memory_chunks", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  chunkText: text("chunk_text").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  sourceHash: text("source_hash").notNull(),
  embedding: float32Vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  embeddingModel: text("embedding_model").notNull(),
  embeddingVersion: integer("embedding_version").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [
  uniqueIndex("memory_chunks_source_chunk_idx").on(table.memoryId, table.chunkIndex),
  index("memory_chunks_memory_idx").on(table.memoryId),
  check("memory_chunks_index_check", sql`${table.chunkIndex} >= 0`),
  check("memory_chunks_revision_check", sql`${table.sourceRevision} >= 1`),
  check("memory_chunks_embedding_version_check", sql`${table.embeddingVersion} >= 1`)
]);

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  statement: text("statement").notNull(),
  status: text("status", { enum: OBSERVATION_STATUSES }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [
  index("observations_status_idx").on(table.status, table.updatedAt),
  check("observations_statement_check", sql`length(${table.statement}) BETWEEN 1 AND 4000`)
]);

// Deliberately no FK to memories: evidence identity must survive source deletion.
export const observationSources = sqliteTable("observation_sources", {
  observationId: text("observation_id").notNull().references(() => observations.id, { onDelete: "cascade" }),
  memoryId: text("memory_id").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  sourceHash: text("source_hash").notNull()
}, (table) => [
  primaryKey({ columns: [table.observationId, table.memoryId] }),
  index("observation_sources_memory_idx").on(table.memoryId),
  check("observation_sources_revision_check", sql`${table.sourceRevision} >= 1`)
]);

export const searchTraces = sqliteTable("search_traces", {
  id: text("id").primaryKey(),
  queryHash: text("query_hash").notNull(),
  requestedMode: text("requested_mode", { enum: SEARCH_MODES }).notNull(),
  effectiveMode: text("effective_mode", { enum: SEARCH_MODES }).notNull(),
  fallbackReason: text("fallback_reason"),
  kind: text("kind", { enum: MEMORY_KINDS }),
  requestedLimit: integer("requested_limit").notNull(),
  resultCount: integer("result_count"),
  keywordCount: integer("keyword_count").notNull().default(0),
  semanticCount: integer("semantic_count").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  status: text("status", { enum: ["completed", "failed"] as const }).notNull(),
  errorCategory: text("error_category"),
  createdAt: text("created_at").notNull()
}, (table) => [
  index("search_traces_created_idx").on(table.createdAt),
  check("search_traces_limit_check", sql`${table.requestedLimit} BETWEEN 1 AND 50`),
  check("search_traces_query_hash_check", sql`length(${table.queryHash}) = 64`),
  check("search_traces_counts_check", sql`${table.keywordCount} >= 0 AND ${table.semanticCount} >= 0`),
  check("search_traces_duration_check", sql`${table.durationMs} >= 0`)
]);

// Deliberately no FK to memories: ranked retrieval evidence survives source deletion.
export const searchTraceResults = sqliteTable("search_trace_results", {
  traceId: text("trace_id").notNull().references(() => searchTraces.id, { onDelete: "cascade" }),
  memoryId: text("memory_id").notNull(),
  rank: integer("rank").notNull(),
  score: real("score").notNull(),
  keywordRank: integer("keyword_rank"),
  semanticRank: integer("semantic_rank"),
  semanticDistance: real("semantic_distance"),
  sourceRevision: integer("source_revision").notNull(),
  sourceHash: text("source_hash").notNull()
}, (table) => [
  primaryKey({ columns: [table.traceId, table.rank] }),
  uniqueIndex("search_trace_results_memory_idx").on(table.traceId, table.memoryId),
  check("search_trace_results_rank_check", sql`${table.rank} >= 1`),
  check("search_trace_results_source_revision_check", sql`${table.sourceRevision} >= 1`)
]);

export type LabSchema = typeof import("./schema");
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryChunkRow = typeof memoryChunks.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
export type ObservationSourceRow = typeof observationSources.$inferSelect;
export type SearchTraceRow = typeof searchTraces.$inferSelect;
export type SearchTraceResultRow = typeof searchTraceResults.$inferSelect;
