import { describe, expect, test } from "bun:test";
import {
  EmbeddingProviderError,
  blobToVector,
  chunkText,
  cosineSimilarity,
  normalizeEmbeddingVector,
  validateEmbeddings,
  vectorToBlob,
  workersAiEmbeddingProvider
} from "./embedding";
import { EMBEDDING_DIMENSIONS } from "./db/schema";

describe("embedding boundary", () => {
  test("round trips a D1 F32_BLOB vector", () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 10);
    expect(Array.from(blobToVector(vectorToBlob(vector)))).toEqual(vector.map(Math.fround));
  });

  test("rejects Float32 overflow and stored non-finite values", () => {
    const overflow = Array(EMBEDDING_DIMENSIONS).fill(0) as number[];
    overflow[0] = Number.MAX_VALUE;
    expect(() => vectorToBlob(overflow)).toThrow("Float32 range");
    expect(() => normalizeEmbeddingVector(overflow)).toThrow(EmbeddingProviderError);
    expect(() => validateEmbeddings({ data: [overflow], shape: [1, EMBEDDING_DIMENSIONS] }, 1)).toThrow(EmbeddingProviderError);
    const corrupt = new Float32Array(EMBEDDING_DIMENSIONS);
    corrupt[0] = Number.NaN;
    expect(() => blobToVector(corrupt.buffer)).toThrow("non-finite Float32");
  });

  test("rejects malformed provider output with a branded provider error", () => {
    expect(() => validateEmbeddings({ data: [[1]], shape: [1, 1] }, 1)).toThrow(EmbeddingProviderError);
  });

  test("normalizes provider vectors to the same Float32 precision used by D1", () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 7);
    const [validated] = validateEmbeddings({ data: [vector], shape: [1, EMBEDDING_DIMENSIONS] }, 1);
    expect(validated).toEqual(vector.map(Math.fround));
  });

  test("wraps inference failures so only genuine provider failures may trigger fallback", async () => {
    const provider = workersAiEmbeddingProvider({ run: async () => { throw new Error("quota"); } });
    await expect(provider.embed(["query"])).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  test("chunks deterministically without losing text", () => {
    const text = `${"ไทย alpha ".repeat(200)}omega`;
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toEqual(chunkText(text, 100));
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 100)).toBeTrue();
    expect(chunks.at(-1)).toEndWith("omega");
  });

  test("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
});
