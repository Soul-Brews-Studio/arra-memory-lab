import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import {
  limitFor,
  MAX_SEMANTIC_CHUNKS,
  projectText,
  queryTerms,
  SemanticScanLimitError,
  TRACE_RETENTION
} from "../domain-utils";

export type LabDatabase = DrizzleD1Database;
export type MemoryKind = (typeof schema.MEMORY_KINDS)[number];

export async function queryKeywordRanks(
  db: LabDatabase,
  query: string,
  kind: MemoryKind | undefined,
  project: string | undefined
): Promise<schema.MemoryRow[]> {
  const projectScope = projectText(project);
  const corpus = await db.select().from(schema.memories).where(and(
    kind ? eq(schema.memories.kind, kind) : undefined,
    projectScope ? eq(schema.memories.project, projectScope) : undefined
  ))
    .orderBy(desc(schema.memories.updatedAt)).limit(500);
  const terms = queryTerms(query);
  return corpus.map((memory) => {
    const title = memory.title.toLocaleLowerCase();
    const body = `${memory.content} ${memory.tags.join(" ")} ${memory.project ?? ""} ${memory.sourcePath ?? ""} ${memory.createdBy}`.toLocaleLowerCase();
    const score = terms.reduce((total, term) =>
      total + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { memory, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, 100)
    .map(({ memory }) => memory);
}

export async function queryCurrentSemanticRows(
  db: LabDatabase,
  kind: MemoryKind | undefined,
  project: string | undefined
) {
  const projectScope = projectText(project);
  const current = and(
    eq(schema.memoryChunks.embeddingModel, schema.EMBEDDING_MODEL),
    eq(schema.memoryChunks.embeddingVersion, schema.EMBEDDING_VERSION),
    eq(schema.memoryChunks.sourceRevision, schema.memories.revision),
    eq(schema.memoryChunks.sourceHash, schema.memories.contentHash),
    kind ? eq(schema.memories.kind, kind) : undefined,
    projectScope ? eq(schema.memories.project, projectScope) : undefined
  );
  const [size] = await db.select({ value: count() }).from(schema.memoryChunks)
    .innerJoin(schema.memories, eq(schema.memoryChunks.memoryId, schema.memories.id))
    .where(current);
  if (Number(size?.value ?? 0) > MAX_SEMANTIC_CHUNKS) {
    throw new SemanticScanLimitError();
  }
  const rows = await db.select({ chunk: schema.memoryChunks, memory: schema.memories })
    .from(schema.memoryChunks)
    .innerJoin(schema.memories, eq(schema.memoryChunks.memoryId, schema.memories.id))
    .where(current)
    .limit(MAX_SEMANTIC_CHUNKS + 1);
  if (rows.length > MAX_SEMANTIC_CHUNKS) throw new SemanticScanLimitError();
  return rows;
}

export function tracePruneQuery(db: LabDatabase) {
  const overflow = db.select({ id: schema.searchTraces.id })
    .from(schema.searchTraces)
    .orderBy(desc(schema.searchTraces.createdAt), desc(schema.searchTraces.id))
    .limit(2_147_483_647)
    .offset(TRACE_RETENTION);
  return db.delete(schema.searchTraces).where(inArray(schema.searchTraces.id, overflow));
}

export async function querySearchTraces(db: LabDatabase, limit = 10) {
  const traces = await db.select().from(schema.searchTraces)
    .orderBy(desc(schema.searchTraces.createdAt), desc(schema.searchTraces.id))
    .limit(limitFor(limit));
  if (!traces.length) return [];
  const links = await db.select().from(schema.searchTraceResults)
    .where(inArray(schema.searchTraceResults.traceId, traces.map((trace) => trace.id)))
    .orderBy(schema.searchTraceResults.traceId, schema.searchTraceResults.rank);
  return traces.map((trace) => ({
    ...trace,
    results: links.filter((link) => link.traceId === trace.id)
  }));
}

export async function querySearchTrace(db: LabDatabase, traceId: string) {
  const [trace] = await db.select().from(schema.searchTraces)
    .where(eq(schema.searchTraces.id, traceId)).limit(1);
  if (!trace) return null;
  const results = await db.select().from(schema.searchTraceResults)
    .where(eq(schema.searchTraceResults.traceId, trace.id))
    .orderBy(schema.searchTraceResults.rank);
  return { ...trace, results };
}

export async function queryLabStateRows(db: LabDatabase) {
  const [memories, observations, sources, traces, traceResults, chunks] = await Promise.all([
    db.select().from(schema.memories).orderBy(desc(schema.memories.updatedAt)),
    db.select().from(schema.observations).orderBy(desc(schema.observations.updatedAt)),
    db.select().from(schema.observationSources),
    db.select().from(schema.searchTraces)
      .orderBy(desc(schema.searchTraces.createdAt)).limit(TRACE_RETENTION),
    db.select().from(schema.searchTraceResults),
    db.select().from(schema.memoryChunks)
  ]);
  return { memories, observations, sources, traces, traceResults, chunks };
}
