import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./db/schema";
import {
  queryCurrentSemanticRows,
  queryKeywordRanks,
  queryLabStateRows,
  querySearchTrace,
  querySearchTraces,
  tracePruneQuery,
  type LabDatabase,
  type MemoryKind
} from "./db/queries";
import {
  ForgetPreviewConflictError,
  isChunkManifestCurrent,
  limitFor,
  MAX_REBUILD_CHUNKS,
  MAX_REBUILD_MEMORIES,
  MAX_SEMANTIC_CHUNKS,
  newId,
  now,
  optionalText,
  projectText,
  provenanceTags,
  reciprocalRankFuse,
  required,
  safeIndexError,
  SemanticScanLimitError,
  titleFor,
  TRACE_RETENTION,
  type RankProvenance,
  type RankedMemoryResult
} from "./domain-utils";
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

export type { LabDatabase, MemoryKind } from "./db/queries";
export { tracePruneQuery } from "./db/queries";
export {
  ForgetPreviewConflictError,
  isChunkManifestCurrent,
  MAX_SEMANTIC_CHUNKS,
  reciprocalRankFuse,
  SemanticScanLimitError,
  TRACE_RETENTION
} from "./domain-utils";
export type { RankProvenance } from "./domain-utils";
export type SearchMode = (typeof schema.SEARCH_MODES)[number];
export type ObservationStatus = (typeof schema.OBSERVATION_STATUSES)[number];

export interface MemoryProvenanceInput {
  project?: string;
  sourcePath?: string;
  createdBy?: string;
  oracleName?: string;
}
export interface CreateMemoryInput extends MemoryProvenanceInput { title?: string; content: string; kind?: MemoryKind; tags?: string[]; supersedesMemoryId?: string; }
export interface UpdateMemoryInput extends MemoryProvenanceInput { title?: string; content?: string; kind?: MemoryKind; tags?: string[]; }
export interface SearchInput { query: string; mode: SearchMode; kind?: MemoryKind; project?: string; limit?: number; semanticMaxDistance?: number; }
export interface SearchResult {
  traceId: string | null;
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
  fallback: { used: boolean; reason: "embedding_provider_failure" | null };
  results: RankedMemoryResult[];
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
        id: newId(), memoryId: memory.id, chunkIndex, chunkText: chunk,
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
  const supersedesMemoryId = optionalText(input.supersedesMemoryId, "supersedesMemoryId", 128);
  const [superseded] = supersedesMemoryId
    ? await db.select().from(schema.memories).where(eq(schema.memories.id, supersedesMemoryId)).limit(1)
    : [];
  if (supersedesMemoryId && !superseded) throw new Error("superseded memory not found");
  const memory: typeof schema.memories.$inferInsert = {
    id: newId(), title: required(input.title ?? titleFor(content), "title", 160), content,
    kind: input.kind ?? "note", tags: provenanceTags(input.tags, input.oracleName),
    project: projectText(input.project),
    sourcePath: optionalText(input.sourcePath, "sourcePath", 500),
    createdBy: optionalText(input.createdBy, "createdBy", 80) ?? "manual",
    supersedesMemoryId: superseded?.id ?? null,
    supersedesRevision: superseded?.revision ?? null,
    supersedesHash: superseded?.contentHash ?? null,
    revision: 1,
    contentHash: await sha256Text(content), createdAt, updatedAt: createdAt
  };
  await db.insert(schema.memories).values(memory);
  if (superseded) {
    const [current] = await db.select({ revision: schema.memories.revision, contentHash: schema.memories.contentHash })
      .from(schema.memories).where(eq(schema.memories.id, superseded.id)).limit(1);
    if (!current || current.revision !== superseded.revision || current.contentHash !== superseded.contentHash) {
      await db.delete(schema.memories).where(eq(schema.memories.id, memory.id));
      throw new Error("superseded memory changed during creation");
    }
  }
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
    tags: patch.tags === undefined && patch.oracleName === undefined
      ? existing.tags
      : provenanceTags(patch.tags ?? existing.tags.filter((tag) => !tag.startsWith("oracle-")), patch.oracleName),
    project: patch.project === undefined ? existing.project : projectText(patch.project),
    sourcePath: patch.sourcePath === undefined ? existing.sourcePath : optionalText(patch.sourcePath, "sourcePath", 500),
    createdBy: patch.createdBy === undefined ? existing.createdBy : optionalText(patch.createdBy, "createdBy", 80) ?? "manual",
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
  const observation = { id: newId(), statement, status: "active" as const, createdAt: timestamp, updatedAt: timestamp };
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

async function semanticRanks(db: LabDatabase, provider: EmbeddingProvider | null, query: string, kind: MemoryKind | undefined, project: string | undefined, maxDistance: number): Promise<Array<{ memory: schema.MemoryRow; distance: number }>> {
  if (!provider) throw new EmbeddingProviderError("embedding provider is unavailable");
  const rows = await queryCurrentSemanticRows(db, kind, project);
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

async function writeTraceSafely(db: LabDatabase, trace: typeof schema.searchTraces.$inferInsert): Promise<void> {
  try {
    await db.batch([
      db.insert(schema.searchTraces).values(trace),
      tracePruneQuery(db)
    ]);
  } catch { /* Search traces are explicitly fail-safe and never affect the search result. */ }
}

type RankedResult = SearchResult["results"][number];

async function writeCompletedTraceSafely(
  db: LabDatabase,
  trace: typeof schema.searchTraces.$inferInsert,
  results: RankedResult[]
): Promise<boolean> {
  try {
    const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
      db.insert(schema.searchTraces).values(trace)
    ];
    if (results.length) statements.push(db.insert(schema.searchTraceResults).values(results.map((result, index) => ({
        traceId: trace.id,
        memoryId: result.memory.id,
        rank: index + 1,
        score: result.score,
        keywordRank: result.provenance.keywordRank,
        semanticRank: result.provenance.semanticRank,
        semanticDistance: result.provenance.semanticDistance,
        sourceRevision: result.memory.revision,
        sourceHash: result.memory.contentHash
      }))));
    statements.push(tracePruneQuery(db));
    await db.batch(statements);
    return true;
  } catch {
    /* Trace/link writes are fail-safe and never affect recall. */
    return false;
  }
}

export async function searchMemories(db: LabDatabase, provider: EmbeddingProvider | null, input: SearchInput): Promise<SearchResult> {
  const started = Date.now();
  const query = required(input.query, "query", 500);
  const queryHash = await sha256Text(query);
  const limit = limitFor(input.limit);
  const semanticMaxDistance = input.semanticMaxDistance ?? 0.7;
  if (!Number.isFinite(semanticMaxDistance) || semanticMaxDistance < 0 || semanticMaxDistance > 2) throw new Error("semanticMaxDistance must be from 0 to 2");
  let effectiveMode = input.mode;
  const traceId = newId();
  let fallbackReason: "embedding_provider_failure" | null = null;
  let keyword: schema.MemoryRow[] = [], semantic: schema.MemoryRow[] = [];
  try {
    const semanticDistances = new Map<string, number>();
    if (input.mode !== "semantic") keyword = await queryKeywordRanks(db, query, input.kind, input.project);
    if (input.mode !== "keyword") {
      try {
        const ranked = await semanticRanks(db, provider, query, input.kind, input.project, semanticMaxDistance);
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
    const tracePersisted = await writeCompletedTraceSafely(db, { id: traceId, queryHash, requestedMode: input.mode, effectiveMode, fallbackReason, kind: input.kind,
      requestedLimit: limit, resultCount: results.length, keywordCount: keyword.length, semanticCount: semantic.length,
      durationMs: Date.now() - started, status: "completed", errorCategory: null, createdAt: now() }, results);
    return {
      traceId: tracePersisted ? traceId : null,
      requestedMode: input.mode,
      effectiveMode,
      fallback: { used: fallbackReason !== null, reason: fallbackReason },
      results
    };
  } catch (error) {
    await writeTraceSafely(db, { id: traceId, queryHash, requestedMode: input.mode, effectiveMode, fallbackReason, kind: input.kind,
      requestedLimit: limit, resultCount: null, keywordCount: keyword.length, semanticCount: semantic.length, durationMs: Date.now() - started, status: "failed",
      errorCategory: isEmbeddingProviderError(error) ? "embedding_provider" : error instanceof SemanticScanLimitError ? error.code : "search", createdAt: now() });
    throw error;
  }
}

export async function listSearchTraces(db: LabDatabase, limit = 10) {
  return querySearchTraces(db, limit);
}

export async function getSearchTrace(db: LabDatabase, traceId: string) {
  const traceKey = required(traceId, "traceId", 128);
  const trace = await querySearchTrace(db, traceKey);
  if (!trace) throw new Error("trace not found");
  return trace;
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
  const { memories, observations, sources, traces, traceResults, chunks } = await queryLabStateRows(db);
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
  }), traces: traces.map((trace) => ({ ...trace, results: traceResults.filter((result) => result.traceId === trace.id) })),
    stats: { memories: memories.length, indexedMemories: memories.filter((memory) => isChunkManifestCurrent(memory, indexed.get(memory.id) ?? [])).length, chunks: chunks.length, observations: observations.length, traces: traces.length, traceResults: traceResults.length } };
}
