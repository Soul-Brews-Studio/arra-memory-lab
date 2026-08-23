import { and, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import {
  blobToVector,
  chunkText,
  cosineSimilarity,
  EmbeddingProviderError,
  isEmbeddingProviderError,
  normalizeEmbeddingVector,
  sha256Text,
  vectorToBlob,
  type EmbeddingProvider
} from "./embedding";

export type LabDatabase = DrizzleD1Database;
export type MemoryKind = (typeof schema.MEMORY_KINDS)[number];
export type SearchMode = (typeof schema.SEARCH_MODES)[number];
export type ObservationStatus = (typeof schema.OBSERVATION_STATUSES)[number];

export interface CreateMemoryInput { title?: string; content: string; kind?: MemoryKind; tags?: string[]; }
export interface UpdateMemoryInput { title?: string; content?: string; kind?: MemoryKind; tags?: string[]; }
export interface SearchInput { query: string; mode: SearchMode; kind?: MemoryKind; limit?: number; semanticMaxDistance?: number; }
export interface RankProvenance { keywordRank: number | null; semanticRank: number | null; semanticDistance: number | null; keywordRrf: number; semanticRrf: number; }
export interface SearchResult {
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
  fallback: { used: boolean; reason: "embedding_provider_failure" | null };
  results: Array<{ memory: schema.MemoryRow; score: number; provenance: RankProvenance }>;
}
export interface IndexOutcome { indexed: boolean; chunks: number; error?: string; }
export interface ForgetPreview {
  confirm?: false;
}
export interface ConfirmForgetInput {
  confirm: true;
  expectedRevision: number;
  expectedHash: string;
  expectedChunks: number;
  expectedObservationCount: number;
}
export type ForgetInput = ForgetPreview | ConfirmForgetInput;
export interface ForgetResult {
  dryRun: boolean;
  memoryId: string;
  chunks: number;
  observations: string[];
  expectedRevision: number;
  expectedHash: string;
  expectedChunks: number;
  expectedObservationCount: number;
}
export interface RebuildResult { dryRun: boolean; eligible: number; attempted: number; attemptedChunks: number; indexed: number; chunks: number; skippedChanged: number; failures: Array<{ memoryId: string; error: "embedding_provider_failure" | "index_write_failure" }>; }

const RRF_K = 60;
const MAX_REBUILD_MEMORIES = 10;
const MAX_REBUILD_CHUNKS = 256;
export const TRACE_RETENTION = 100;
export const MAX_SEMANTIC_CHUNKS = 1_000;

export class SemanticScanLimitError extends Error {
  readonly name = "SemanticScanLimitError";
  readonly code = "semantic_scan_limit";
  constructor() { super(`semantic search exceeds the ${MAX_SEMANTIC_CHUNKS}-chunk exact-scan boundary`); }
}

export class ForgetPreviewConflictError extends Error {
  readonly name = "ForgetPreviewConflictError";
  readonly code = "stale_preview";
  constructor() { super("forget preview is stale; request a new preview before confirming"); }
}

function now(): string { return new Date().toISOString(); }
function id(): string { return crypto.randomUUID(); }
function required(value: string, field: string, max: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return result;
}
function titleFor(content: string): string {
  const first = content.split(/\r?\n/, 1)[0]!.replace(/^#+\s*/, "").trim();
  return (first || "Untitled memory").slice(0, 160);
}
function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}
function limitFor(limit: number | undefined): number {
  return Math.max(1, Math.min(50, Math.trunc(limit ?? 10)));
}
function safeIndexError(error: unknown): "embedding_provider_failure" | "index_write_failure" {
  return isEmbeddingProviderError(error) ? "embedding_provider_failure" : "index_write_failure";
}

/** Replace derived chunks only if the authoritative revision/hash still match. */
export async function indexMemory(db: LabDatabase, provider: EmbeddingProvider, memory: schema.MemoryRow): Promise<IndexOutcome> {
  const texts = chunkText([memory.title, memory.content].join("\n\n"));
  const vectors = await provider.embed(texts);
  if (vectors.length !== texts.length) throw new EmbeddingProviderError("embedding provider returned the wrong vector count");

  const [current] = await db.select().from(schema.memories).where(eq(schema.memories.id, memory.id)).limit(1);
  if (!current || current.revision !== memory.revision || current.contentHash !== memory.contentHash) {
    return { indexed: false, chunks: 0, error: "source_changed" };
  }

  if (texts.length) {
    const createdAt = now();
    await db.batch([
      db.delete(schema.memoryChunks).where(and(
        eq(schema.memoryChunks.memoryId, memory.id),
        lte(schema.memoryChunks.sourceRevision, memory.revision)
      )),
      db.insert(schema.memoryChunks).values(texts.map((chunk, chunkIndex) => ({
        id: id(), memoryId: memory.id, chunkIndex, chunkText: chunk,
        sourceRevision: memory.revision, sourceHash: memory.contentHash,
        embedding: vectorToBlob(vectors[chunkIndex]!), embeddingModel: provider.model,
        embeddingVersion: schema.EMBEDDING_VERSION, createdAt
      })))
    ]);
  } else await db.delete(schema.memoryChunks).where(and(
    eq(schema.memoryChunks.memoryId, memory.id),
    lte(schema.memoryChunks.sourceRevision, memory.revision)
  ));
  // Close the select/write race. A concurrent source update invalidates these chunks.
  const [afterWrite] = await db.select({ revision: schema.memories.revision, contentHash: schema.memories.contentHash })
    .from(schema.memories).where(eq(schema.memories.id, memory.id)).limit(1);
  if (!afterWrite || afterWrite.revision !== memory.revision || afterWrite.contentHash !== memory.contentHash) {
    await db.delete(schema.memoryChunks).where(and(
      eq(schema.memoryChunks.memoryId, memory.id),
      eq(schema.memoryChunks.sourceRevision, memory.revision),
      eq(schema.memoryChunks.sourceHash, memory.contentHash)
    ));
    return { indexed: false, chunks: 0, error: "source_changed" };
  }
  return { indexed: true, chunks: texts.length };
}

/** Authoritative insert succeeds even if its best-effort derived indexing fails. */
export async function createMemory(db: LabDatabase, provider: EmbeddingProvider | null, input: CreateMemoryInput): Promise<{ memory: schema.MemoryRow; indexing: IndexOutcome }> {
  const content = required(input.content, "content", 12_000);
  const createdAt = now();
  const memory: typeof schema.memories.$inferInsert = {
    id: id(), title: required(input.title ?? titleFor(content), "title", 160), content,
    kind: input.kind ?? "note", tags: normalizeTags(input.tags), revision: 1,
    contentHash: await sha256Text(content), createdAt, updatedAt: createdAt
  };
  await db.insert(schema.memories).values(memory);
  const [stored] = await db.select().from(schema.memories).where(eq(schema.memories.id, memory.id)).limit(1);
  if (!stored) throw new Error("authoritative memory insert was not readable");
  if (!provider) return { memory: stored, indexing: { indexed: false, chunks: 0, error: "embedding_provider_unavailable" } };
  try { return { memory: stored, indexing: await indexMemory(db, provider, stored) }; }
  catch (error) { return { memory: stored, indexing: { indexed: false, chunks: 0, error: safeIndexError(error) } }; }
}

export async function updateMemory(db: LabDatabase, memoryId: string, patch: UpdateMemoryInput): Promise<schema.MemoryRow> {
  const [existing] = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  if (!existing) throw new Error("memory not found");
  const content = patch.content === undefined ? existing.content : required(patch.content, "content", 12_000);
  const dependentObservationIds = db.select({ id: schema.observationSources.observationId })
    .from(schema.observationSources).where(eq(schema.observationSources.memoryId, memoryId));
  const update = db.update(schema.memories).set({
    title: patch.title === undefined ? existing.title : required(patch.title, "title", 160),
    content, kind: patch.kind ?? existing.kind,
    tags: patch.tags === undefined ? existing.tags : normalizeTags(patch.tags),
    revision: existing.revision + 1, contentHash: await sha256Text(content), updatedAt: now()
  }).where(and(eq(schema.memories.id, memoryId), eq(schema.memories.revision, existing.revision)))
    .returning({ revision: schema.memories.revision });
  const batchResult = await db.batch([
    update,
    db.delete(schema.memoryChunks).where(and(eq(schema.memoryChunks.memoryId, memoryId), eq(schema.memoryChunks.sourceRevision, existing.revision))),
    db.update(schema.observations).set({ status: "stale", updatedAt: now() })
      .where(and(inArray(schema.observations.id, dependentObservationIds), eq(schema.observations.status, "active")))
  ]);
  const updatedRows = batchResult[0] as Array<{ revision: number }>;
  if (updatedRows.length !== 1 || updatedRows[0]!.revision !== existing.revision + 1) throw new Error("memory update conflict");
  const [updated] = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  if (!updated || updated.revision !== existing.revision + 1) throw new Error("memory update conflict");
  return updated!;
}

export async function createObservation(db: LabDatabase, statementInput: string, sourceMemoryIds: string[]): Promise<{ observation: schema.ObservationRow; sources: schema.ObservationSourceRow[] }> {
  const statement = required(statementInput, "statement", 4_000);
  const sourceIds = [...new Set(sourceMemoryIds)];
  if (sourceIds.length < 1 || sourceIds.length > 8) throw new Error("an observation requires 1 to 8 distinct source memories");
  const sources = await db.select().from(schema.memories).where(inArray(schema.memories.id, sourceIds));
  if (sources.length !== sourceIds.length) throw new Error("one or more source memories do not exist");
  const timestamp = now();
  const observation = { id: id(), statement, status: "active" as const, createdAt: timestamp, updatedAt: timestamp };
  await db.batch([
    db.insert(schema.observations).values(observation),
    db.insert(schema.observationSources).values(sources.map((source) => ({
      observationId: observation.id, memoryId: source.id, sourceRevision: source.revision, sourceHash: source.contentHash
    })))
  ]);
  const currentSources = await db.select({
    id: schema.memories.id,
    revision: schema.memories.revision,
    contentHash: schema.memories.contentHash
  }).from(schema.memories).where(inArray(schema.memories.id, sourceIds));
  const currentById = new Map(currentSources.map((source) => [source.id, source]));
  const changed = sources.some((source) => {
    const current = currentById.get(source.id);
    return !current || current.revision !== source.revision || current.contentHash !== source.contentHash;
  });
  if (changed) {
    await db.delete(schema.observations).where(eq(schema.observations.id, observation.id));
    throw new Error("observation sources changed during creation");
  }
  return { observation, sources: await db.select().from(schema.observationSources).where(eq(schema.observationSources.observationId, observation.id)) };
}

export async function forgetMemory(db: LabDatabase, memoryId: string, input: ForgetInput = {}): Promise<ForgetResult> {
  const [memory] = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  if (!memory) {
    if (input.confirm) throw new ForgetPreviewConflictError();
    throw new Error("memory not found");
  }
  const chunks = await db.select({ id: schema.memoryChunks.id }).from(schema.memoryChunks).where(eq(schema.memoryChunks.memoryId, memoryId));
  const sourceRows = await db.select({ id: schema.observationSources.observationId }).from(schema.observationSources).where(eq(schema.observationSources.memoryId, memoryId));
  const observationIds = [...new Set(sourceRows.map((row) => row.id))];
  const preview = {
    memoryId, chunks: chunks.length, observations: observationIds,
    expectedRevision: memory.revision, expectedHash: memory.contentHash,
    expectedChunks: chunks.length, expectedObservationCount: observationIds.length
  };
  if (!input.confirm) return { dryRun: true, ...preview };
  if (input.expectedRevision !== memory.revision || input.expectedHash !== memory.contentHash ||
      input.expectedChunks !== chunks.length || input.expectedObservationCount !== observationIds.length) {
    throw new ForgetPreviewConflictError();
  }
  const guard = sql<boolean>`EXISTS (
    SELECT 1 FROM memories guarded_memory
    WHERE guarded_memory.id = ${memoryId}
      AND guarded_memory.revision = ${input.expectedRevision}
      AND guarded_memory.content_hash = ${input.expectedHash}
      AND (SELECT COUNT(*) FROM memory_chunks guarded_chunks WHERE guarded_chunks.memory_id = ${memoryId}) = ${input.expectedChunks}
      AND (SELECT COUNT(DISTINCT guarded_sources.observation_id) FROM observation_sources guarded_sources WHERE guarded_sources.memory_id = ${memoryId}) = ${input.expectedObservationCount}
  )`;
  // observation_sources intentionally survive; memory_chunks cascade. D1 batch is atomic.
  let deleted: Array<{ id: string }>;
  if (observationIds.length) {
    const result = await db.batch([
      db.update(schema.observations).set({ status: "retracted", updatedAt: now() }).where(and(inArray(schema.observations.id, observationIds), guard)),
      db.delete(schema.memories).where(and(eq(schema.memories.id, memoryId), guard)).returning({ id: schema.memories.id })
    ]);
    deleted = result[1] as Array<{ id: string }>;
  } else {
    deleted = await db.delete(schema.memories).where(and(eq(schema.memories.id, memoryId), guard)).returning({ id: schema.memories.id });
  }
  if (deleted.length !== 1) throw new ForgetPreviewConflictError();
  return { dryRun: false, ...preview };
}

async function keywordRanks(db: LabDatabase, query: string, kind: MemoryKind | undefined): Promise<schema.MemoryRow[]> {
  const corpus = await db.select().from(schema.memories).where(kind ? eq(schema.memories.kind, kind) : undefined)
    .orderBy(desc(schema.memories.updatedAt)).limit(500);
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return corpus.map((memory) => {
    const title = memory.title.toLocaleLowerCase();
    const body = `${memory.content} ${memory.tags.join(" ")}`.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { memory, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, 100).map(({ memory }) => memory);
}

async function semanticRanks(db: LabDatabase, provider: EmbeddingProvider | null, query: string, kind: MemoryKind | undefined, maxDistance: number): Promise<Array<{ memory: schema.MemoryRow; distance: number }>> {
  if (!provider) throw new EmbeddingProviderError("embedding provider is unavailable");
  const current = and(
    eq(schema.memoryChunks.sourceRevision, schema.memories.revision),
    eq(schema.memoryChunks.sourceHash, schema.memories.contentHash),
    eq(schema.memoryChunks.embeddingModel, schema.EMBEDDING_MODEL),
    eq(schema.memoryChunks.embeddingVersion, schema.EMBEDDING_VERSION),
    kind ? eq(schema.memories.kind, kind) : undefined
  );
  const [size] = await db.select({ value: count() }).from(schema.memoryChunks)
    .innerJoin(schema.memories, eq(schema.memoryChunks.memoryId, schema.memories.id)).where(current);
  if (Number(size?.value ?? 0) > MAX_SEMANTIC_CHUNKS) throw new SemanticScanLimitError();
  const rows = await db.select({ chunk: schema.memoryChunks, memory: schema.memories })
    .from(schema.memoryChunks).innerJoin(schema.memories, eq(schema.memoryChunks.memoryId, schema.memories.id))
    .where(current).limit(MAX_SEMANTIC_CHUNKS + 1);
  if (rows.length > MAX_SEMANTIC_CHUNKS) throw new SemanticScanLimitError();
  const [queryVector] = await provider.embed([query]);
  if (!queryVector) throw new EmbeddingProviderError("embedding provider returned no query vector");
  const normalizedQueryVector = normalizeEmbeddingVector(queryVector);
  const scores = new Map<string, { memory: schema.MemoryRow; score: number }>();
  for (const row of rows) {
    // Parsing/corruption errors intentionally escape as database/vector errors, never AI fallback.
    const score = cosineSimilarity(normalizedQueryVector, blobToVector(row.chunk.embedding));
    const previous = scores.get(row.memory.id);
    if (!previous || score > previous.score) scores.set(row.memory.id, { memory: row.memory, score });
  }
  return [...scores.values()].map(({ memory, score }) => ({ memory, distance: 1 - score }))
    .filter(({ distance }) => distance <= maxDistance).sort((a, b) => a.distance - b.distance);
}

export function reciprocalRankFuse(keyword: schema.MemoryRow[], semantic: schema.MemoryRow[], limit: number, semanticDistances = new Map<string, number>()): SearchResult["results"] {
  const byId = new Map<string, { memory: schema.MemoryRow; keywordRank: number | null; semanticRank: number | null }>();
  keyword.forEach((memory, index) => byId.set(memory.id, { memory, keywordRank: index + 1, semanticRank: null }));
  semantic.forEach((memory, index) => {
    const existing = byId.get(memory.id);
    if (existing) existing.semanticRank = index + 1;
    else byId.set(memory.id, { memory, keywordRank: null, semanticRank: index + 1 });
  });
  return [...byId.values()].map(({ memory, keywordRank, semanticRank }) => {
    const keywordRrf = keywordRank ? 1 / (RRF_K + keywordRank) : 0;
    const semanticRrf = semanticRank ? 1 / (RRF_K + semanticRank) : 0;
    return { memory, score: keywordRrf + semanticRrf, provenance: { keywordRank, semanticRank, semanticDistance: semanticDistances.get(memory.id) ?? null, keywordRrf, semanticRrf } };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function isChunkManifestCurrent(memory: schema.MemoryRow, manifestInput: schema.MemoryChunkRow[]): boolean {
  const manifest = [...manifestInput].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const expected = chunkText([memory.title, memory.content].join("\n\n"));
  return manifest.length === expected.length && manifest.every((chunk, index) =>
    chunk.chunkIndex === index && chunk.sourceRevision === memory.revision && chunk.sourceHash === memory.contentHash &&
    chunk.chunkText === expected[index] && chunk.embeddingModel === schema.EMBEDDING_MODEL && chunk.embeddingVersion === schema.EMBEDDING_VERSION &&
    chunk.embedding.byteLength === schema.EMBEDDING_DIMENSIONS * 4
  );
}

export function tracePruneQuery(db: LabDatabase) {
  const overflow = db.select({ id: schema.searchTraces.id }).from(schema.searchTraces)
    .orderBy(desc(schema.searchTraces.createdAt), desc(schema.searchTraces.id))
    .limit(2_147_483_647).offset(TRACE_RETENTION);
  return db.delete(schema.searchTraces).where(inArray(schema.searchTraces.id, overflow));
}

async function writeTraceSafely(db: LabDatabase, trace: typeof schema.searchTraces.$inferInsert): Promise<void> {
  try {
    await db.batch([
      db.insert(schema.searchTraces).values(trace),
      tracePruneQuery(db)
    ]);
  } catch { /* Search traces are explicitly fail-safe and never affect the search result. */ }
}

export async function searchMemories(db: LabDatabase, provider: EmbeddingProvider | null, input: SearchInput): Promise<SearchResult> {
  const started = Date.now();
  const query = required(input.query, "query", 500);
  const queryHash = await sha256Text(query);
  const limit = limitFor(input.limit);
  const semanticMaxDistance = input.semanticMaxDistance ?? 0.7;
  if (!Number.isFinite(semanticMaxDistance) || semanticMaxDistance < 0 || semanticMaxDistance > 2) throw new Error("semanticMaxDistance must be from 0 to 2");
  let effectiveMode = input.mode;
  let fallbackReason: "embedding_provider_failure" | null = null;
  let keyword: schema.MemoryRow[] = [], semantic: schema.MemoryRow[] = [];
  try {
    const semanticDistances = new Map<string, number>();
    if (input.mode !== "semantic") keyword = await keywordRanks(db, query, input.kind);
    if (input.mode !== "keyword") {
      try {
        const ranked = await semanticRanks(db, provider, query, input.kind, semanticMaxDistance);
        semantic = ranked.map(({ memory }) => memory);
        ranked.forEach(({ memory, distance }) => semanticDistances.set(memory.id, distance));
      }
      catch (error) {
        if (input.mode === "hybrid" && isEmbeddingProviderError(error)) {
          effectiveMode = "keyword"; fallbackReason = "embedding_provider_failure";
        } else throw error;
      }
    }
    const results = reciprocalRankFuse(keyword, semantic, limit, semanticDistances);
    const response: SearchResult = { requestedMode: input.mode, effectiveMode, fallback: { used: fallbackReason !== null, reason: fallbackReason }, results };
    await writeTraceSafely(db, { id: id(), queryHash, requestedMode: input.mode, effectiveMode, fallbackReason, kind: input.kind,
      requestedLimit: limit, resultCount: results.length, keywordCount: keyword.length, semanticCount: semantic.length,
      durationMs: Date.now() - started, status: "completed", errorCategory: null, createdAt: now() });
    return response;
  } catch (error) {
    await writeTraceSafely(db, { id: id(), queryHash, requestedMode: input.mode, effectiveMode, fallbackReason, kind: input.kind,
      requestedLimit: limit, resultCount: null, keywordCount: keyword.length, semanticCount: semantic.length, durationMs: Date.now() - started, status: "failed",
      errorCategory: isEmbeddingProviderError(error) ? "embedding_provider" : error instanceof SemanticScanLimitError ? error.code : "search", createdAt: now() });
    throw error;
  }
}

export async function rebuildIndex(db: LabDatabase, provider: EmbeddingProvider | null, confirm = false): Promise<RebuildResult> {
  const all = await db.select().from(schema.memories).orderBy(desc(schema.memories.updatedAt));
  const chunks = await db.select().from(schema.memoryChunks);
  const indexed = new Map<string, schema.MemoryChunkRow[]>();
  for (const chunk of chunks) indexed.set(chunk.memoryId, [...(indexed.get(chunk.memoryId) ?? []), chunk]);
  const eligible = all.filter((memory) => !isChunkManifestCurrent(memory, indexed.get(memory.id) ?? []));
  const result: RebuildResult = { dryRun: !confirm, eligible: eligible.length, attempted: 0, attemptedChunks: 0, indexed: 0, chunks: 0, skippedChanged: 0, failures: [] };
  if (!confirm) return result;
  if (!provider) throw new EmbeddingProviderError("embedding provider is unavailable");
  for (const memory of eligible.slice(0, MAX_REBUILD_MEMORIES)) {
    const projectedChunks = chunkText([memory.title, memory.content].join("\n\n")).length;
    if (result.attemptedChunks + projectedChunks > MAX_REBUILD_CHUNKS) break;
    result.attempted += 1;
    result.attemptedChunks += projectedChunks;
    try {
      const outcome = await indexMemory(db, provider, memory);
      if (!outcome.indexed && outcome.error === "source_changed") result.skippedChanged += 1;
      else if (outcome.indexed) { result.indexed += 1; result.chunks += outcome.chunks; }
    } catch (error) { result.failures.push({ memoryId: memory.id, error: safeIndexError(error) }); }
  }
  return result;
}

export async function getLabState(db: LabDatabase) {
  const [memories, observations, sources, traces, chunks] = await Promise.all([
    db.select().from(schema.memories).orderBy(desc(schema.memories.updatedAt)),
    db.select().from(schema.observations).orderBy(desc(schema.observations.updatedAt)),
    db.select().from(schema.observationSources),
    db.select().from(schema.searchTraces).orderBy(desc(schema.searchTraces.createdAt)).limit(TRACE_RETENTION),
    db.select().from(schema.memoryChunks)
  ]);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const indexed = new Map<string, schema.MemoryChunkRow[]>();
  for (const chunk of chunks) indexed.set(chunk.memoryId, [...(indexed.get(chunk.memoryId) ?? []), chunk]);
  return { memories, observations: observations.map((observation) => {
    const evidence = sources.filter((source) => source.observationId === observation.id);
    const missing = evidence.some((source) => !memoryById.has(source.memoryId));
    const changed = evidence.some((source) => {
      const current = memoryById.get(source.memoryId);
      return current && (current.revision !== source.sourceRevision || current.contentHash !== source.sourceHash);
    });
    const status: ObservationStatus = observation.status === "retracted" || missing ? "retracted" : observation.status === "stale" || changed ? "stale" : "active";
    return { ...observation, status, sources: evidence };
  }), traces,
    stats: { memories: memories.length, indexedMemories: memories.filter((memory) => isChunkManifestCurrent(memory, indexed.get(memory.id) ?? [])).length, chunks: chunks.length, observations: observations.length } };
}
