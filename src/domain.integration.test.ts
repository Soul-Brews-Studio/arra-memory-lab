import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  createMemory,
  createObservation,
  forgetMemory,
  ForgetPreviewConflictError,
  getSearchTrace,
  getLabState,
  indexMemory,
  searchMemories,
  updateMemory,
  type LabDatabase
} from "./domain";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, memories, memoryChunks, observations } from "./db/schema";
import { vectorToBlob, type EmbeddingProvider } from "./embedding";
import { BunD1Database, interceptNextBatch } from "./test-support/bun-d1";

const migrationSql = ["0001_init.sql", "0002_memory_provenance.sql", "0003_trace_links_supersession.sql"]
  .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");
const vector = (axis = 0) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === axis ? 1 : 0);
const provider: EmbeddingProvider = { model: EMBEDDING_MODEL, embed: async (texts) => texts.map(() => vector()) };

describe("D1-compatible domain contracts", () => {
  let binding: BunD1Database;
  let db: LabDatabase;

  beforeEach(() => {
    binding = new BunD1Database(migrationSql);
    db = drizzle(binding);
  });

  afterEach(() => binding.close());

  test("stores RRR provenance without duplicating repository identity into tags", async () => {
    const created = await createMemory(db, null, {
      title: "RRR lesson",
      content: "A retrospective about keeping auth boundaries small.",
      kind: "retrospective",
      tags: ["oauth"],
      project: "https://github.com/Soul-Brews-Studio/claude-ai-mcp-poc/",
      sourcePath: "ψ/memory/retrospectives/2026-08/23/example.md",
      createdBy: "rrr",
      oracleName: "neo"
    });
    await createMemory(db, null, {
      content: "A different auth note.",
      project: "github.com/example/other"
    });

    expect(created.memory).toEqual(expect.objectContaining({
      kind: "retrospective",
      project: "github.com/soul-brews-studio/claude-ai-mcp-poc",
      sourcePath: "ψ/memory/retrospectives/2026-08/23/example.md",
      createdBy: "rrr"
    }));
    expect(created.memory.tags).toEqual(["oracle-neo", "oauth"]);
    expect(created.memory.tags).not.toContain("github.com/soul-brews-studio/claude-ai-mcp-poc");

    const search = await searchMemories(db, null, {
      query: "auth",
      mode: "keyword",
      project: "github.com/Soul-Brews-Studio/claude-ai-mcp-poc"
    });
    expect(search.results.map((result) => result.memory.id)).toEqual([created.memory.id]);
  });

  test("pins immutable supersession and preserves trace result evidence after forget", async () => {
    const source = await createMemory(db, null, { title: "old contract", content: "traceable authority" });
    const replacement = await createMemory(db, null, {
      title: "new contract",
      content: "replaces the old contract",
      supersedesMemoryId: source.memory.id
    });
    expect(replacement.memory).toEqual(expect.objectContaining({
      supersedesMemoryId: source.memory.id,
      supersedesRevision: source.memory.revision,
      supersedesHash: source.memory.contentHash
    }));

    const search = await searchMemories(db, null, { query: "traceable", mode: "keyword", limit: 1 });
    expect(search.traceId).toBeString();
    const traceId = search.traceId;
    if (!traceId) throw new Error("expected persisted trace ID");
    const trace = await getSearchTrace(db, traceId);
    expect(trace.results).toEqual([expect.objectContaining({
      memoryId: source.memory.id,
      rank: 1,
      sourceRevision: source.memory.revision,
      sourceHash: source.memory.contentHash
    })]);
    expect((await getLabState(db)).stats).toEqual(expect.objectContaining({ traces: 1, traceResults: 1 }));

    const preview = await forgetMemory(db, source.memory.id);
    await forgetMemory(db, source.memory.id, { confirm: true, ...preview });
    expect((await getSearchTrace(db, traceId)).results[0]?.memoryId).toBe(source.memory.id);
    expect((await getLabState(db)).memories.find((memory) => memory.id === replacement.memory.id)?.supersedesHash)
      .toBe(source.memory.contentHash);
  });

  test("returns no trace ID when fail-safe trace persistence fails", async () => {
    const source = await createMemory(db, null, { content: "search still succeeds" });
    const failingTraceBinding = {
      prepare: (query: string) => binding.prepare(query),
      batch: async () => { throw new Error("trace transport failed"); },
      exec: (query: string) => binding.exec(query),
      withSession: () => binding.withSession(),
      dump: () => binding.dump()
    } as D1Database;

    const search = await searchMemories(drizzle(failingTraceBinding), null, {
      query: "succeeds",
      mode: "keyword"
    });
    expect(search.results[0]?.memory.id).toBe(source.memory.id);
    expect(search.traceId).toBeNull();
  });

  test("revision update invalidates chunks and surfaces dependent evidence as stale", async () => {
    const created = await createMemory(db, provider, { content: "source revision one" });
    const evidence = await createObservation(db, "derived claim", [created.memory.id]);

    const updated = await updateMemory(db, created.memory.id, { content: "source revision two" });
    const state = await getLabState(db);

    expect(updated.revision).toBe(2);
    expect(state.stats.chunks).toBe(0);
    expect(state.observations.find((item) => item.id === evidence.observation.id)?.status).toBe("stale");
  });

  test("CAS conflict never acknowledges or overwrites a concurrent revision", async () => {
    const created = await createMemory(db, null, { content: "original" });
    const racingBinding = interceptNextBatch(binding, () => {
      binding.sqlite.query("UPDATE memories SET content = ?, revision = revision + 1 WHERE id = ?")
        .run("other writer", created.memory.id);
    });

    await expect(updateMemory(drizzle(racingBinding), created.memory.id, { content: "losing writer" }))
      .rejects.toThrow("memory update conflict");
    const [stored] = await db.select().from(memories).where(eq(memories.id, created.memory.id));
    expect(stored?.content).toBe("other writer");
    expect(stored?.revision).toBe(2);
  });

  test("observation creation removes a snapshot whose source changes before verification", async () => {
    const created = await createMemory(db, null, { content: "evidence revision one" });
    const racingBinding = interceptNextBatch(binding, () => {}, () => {
      binding.sqlite.query("UPDATE memories SET content = ?, revision = revision + 1 WHERE id = ?")
        .run("evidence revision two", created.memory.id);
    });

    await expect(createObservation(drizzle(racingBinding), "must not survive", [created.memory.id]))
      .rejects.toThrow("observation sources changed");
    expect(await db.select().from(observations)).toHaveLength(0);
  });

  test("an older indexing write cannot delete or replace a newer chunk generation", async () => {
    const created = await createMemory(db, null, { content: "old source" });
    const newerText = "new source";
    const newerHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(newerText))
      .then((value) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    const racingBinding = interceptNextBatch(binding, () => {
      binding.sqlite.query("UPDATE memories SET content = ?, revision = 2, content_hash = ? WHERE id = ?")
        .run(newerText, newerHash, created.memory.id);
      binding.sqlite.query(`INSERT INTO memory_chunks
        (id,memory_id,chunk_index,chunk_text,source_revision,source_hash,embedding,embedding_model,embedding_version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          "newer-chunk", created.memory.id, 0, newerText, 2, newerHash,
          vectorToBlob(vector(1)), EMBEDDING_MODEL, 1, new Date().toISOString()
        );
    });

    await expect(indexMemory(drizzle(racingBinding), provider, created.memory)).rejects.toThrow();
    const rows = await db.select().from(memoryChunks).where(eq(memoryChunks.memoryId, created.memory.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("newer-chunk");
    expect(rows[0]?.sourceRevision).toBe(2);
  });

  test("forget confirmation is bound to the exact preview and preserves evidence identity", async () => {
    const created = await createMemory(db, provider, { content: "previewed source" });
    const evidence = await createObservation(db, "previewed evidence", [created.memory.id]);
    const preview = await forgetMemory(db, created.memory.id);
    await updateMemory(db, created.memory.id, { content: "changed after preview" });

    await expect(forgetMemory(db, created.memory.id, { confirm: true, ...preview }))
      .rejects.toBeInstanceOf(ForgetPreviewConflictError);
    expect(await db.select().from(memories).where(eq(memories.id, created.memory.id))).toHaveLength(1);

    const fresh = await forgetMemory(db, created.memory.id);
    const result = await forgetMemory(db, created.memory.id, { confirm: true, ...fresh });
    expect(result.dryRun).toBeFalse();
    expect(await db.select().from(memories).where(eq(memories.id, created.memory.id))).toHaveLength(0);
    const [retained] = await db.select().from(observations).where(eq(observations.id, evidence.observation.id));
    expect(retained?.status).toBe("retracted");
    expect((await getLabState(db)).observations.find((item) => item.id === evidence.observation.id)?.sources[0]?.memoryId)
      .toBe(created.memory.id);
  });
});
