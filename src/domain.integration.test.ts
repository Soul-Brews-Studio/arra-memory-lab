import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  createMemory,
  createObservation,
  forgetMemory,
  ForgetPreviewConflictError,
  getLabState,
  indexMemory,
  updateMemory,
  type LabDatabase
} from "./domain";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, memories, memoryChunks, observations } from "./db/schema";
import { vectorToBlob, type EmbeddingProvider } from "./embedding";
import { BunD1Database, interceptNextBatch } from "./test-support/bun-d1";

const migrationSql = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
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
