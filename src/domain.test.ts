import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/d1";
import { ForgetPreviewConflictError, isChunkManifestCurrent, reciprocalRankFuse, TRACE_RETENTION, tracePruneQuery } from "./domain";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, memoryChunks, searchTraces, type MemoryChunkRow, type MemoryRow } from "./db/schema";

function memory(id: string): MemoryRow {
  return {
    id, title: id, content: id, kind: "note", tags: [], project: null, sourcePath: null, createdBy: "manual",
    supersedesMemoryId: null, supersedesRevision: null, supersedesHash: null, revision: 1,
    contentHash: id.padEnd(64, "0"), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("hybrid reciprocal-rank fusion", () => {
  test("retains per-ranker provenance and rewards agreement", () => {
    const a = memory("a"), b = memory("b"), c = memory("c");
    const results = reciprocalRankFuse([a, b], [a, c], 10);
    expect(results.map((result) => result.memory.id)).toEqual(["a", "b", "c"]);
    expect(results[0]!.provenance).toEqual({
      keywordRank: 1, semanticRank: 1, semanticDistance: null, keywordRrf: 1 / 61, semanticRrf: 1 / 61
    });
    expect(results[1]!.provenance.semanticRank).toBeNull();
    expect(results[2]!.provenance.keywordRank).toBeNull();
  });

  test("honors the result limit", () => {
    expect(reciprocalRankFuse([memory("a"), memory("b")], [], 1)).toHaveLength(1);
  });
});

describe("derived chunk manifests", () => {
  const source = memory("source");
  const chunk: MemoryChunkRow = {
    id: "chunk", memoryId: source.id, chunkIndex: 0, chunkText: `${source.title}\n\n${source.content}`,
    sourceRevision: source.revision, sourceHash: source.contentHash,
    embedding: new Uint8Array(EMBEDDING_DIMENSIONS * 4), embeddingModel: EMBEDDING_MODEL, embeddingVersion: 1,
    createdAt: source.createdAt
  };

  test("rejects missing and corrupt manifests", () => {
    expect(isChunkManifestCurrent(source, [])).toBeFalse();
    expect(isChunkManifestCurrent(source, [{ ...chunk, embedding: new Uint8Array(4) }])).toBeFalse();
    expect(isChunkManifestCurrent(source, [{ ...chunk, sourceRevision: 2 }])).toBeFalse();
    expect(isChunkManifestCurrent(source, [{ ...chunk, chunkText: "corrupt" }])).toBeFalse();
  });

  test("accepts a complete current manifest", () => {
    expect(isChunkManifestCurrent(source, [chunk])).toBeTrue();
  });

  test("normalizes D1 BLOB arrays before manifest validation", () => {
    const selected = memoryChunks.embedding.mapFromDriverValue(
      Array.from({ length: EMBEDDING_DIMENSIONS * 4 }, () => 0)
    );
    expect(selected).toBeInstanceOf(Uint8Array);
    expect(selected.byteLength).toBe(EMBEDDING_DIMENSIONS * 4);
    expect(isChunkManifestCurrent(source, [{ ...chunk, embedding: selected }])).toBeTrue();
  });
});

test("forget conflicts expose only the stable stale-preview code", () => {
  const error = new ForgetPreviewConflictError();
  expect(error.code).toBe("stale_preview");
  expect(error.name).toBe("ForgetPreviewConflictError");
});

test("trace pruning keeps the newest bounded window and cascades result links", () => {
  const queryDb = drizzle({} as D1Database);
  const compiled = tracePruneQuery(queryDb).toSQL();
  expect(compiled.sql).toContain("limit ? offset ?");
  expect(compiled.params).toEqual([2_147_483_647, TRACE_RETENTION]);

  const sqlite = new Database(":memory:");
  try {
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.run("CREATE TABLE search_traces (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    sqlite.run("CREATE TABLE search_trace_results (trace_id TEXT NOT NULL REFERENCES search_traces(id) ON DELETE CASCADE, rank INTEGER NOT NULL, PRIMARY KEY(trace_id, rank))");
    const insert = sqlite.prepare("INSERT INTO search_traces (id, created_at) VALUES (?, ?)");
    const insertResult = sqlite.prepare("INSERT INTO search_trace_results (trace_id, rank) VALUES (?, 1)");
    for (let index = 0; index < TRACE_RETENTION + 20; index += 1) {
      const traceId = index.toString().padStart(3, "0");
      insert.run(traceId, new Date(index * 1_000).toISOString());
      insertResult.run(traceId);
    }
    sqlite.query(compiled.sql).run(...(compiled.params as number[]));
    const [{ count }] = sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_traces").all();
    expect(count).toBe(TRACE_RETENTION);
    expect(sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_trace_results").get()?.count).toBe(TRACE_RETENTION);
    expect(sqlite.query<{ id: string }, []>("SELECT id FROM search_traces ORDER BY created_at ASC LIMIT 1").get()?.id).toBe("020");
  } finally {
    sqlite.close();
  }
});
