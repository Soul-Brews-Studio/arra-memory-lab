import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./db/schema";

export interface WorkersAiBinding {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingProviderError extends Error {
  readonly name = "EmbeddingProviderError";
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

export const isEmbeddingProviderError = (error: unknown): error is EmbeddingProviderError =>
  error instanceof EmbeddingProviderError;

export function normalizeEmbeddingVector(vector: number[]): Float32Array {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new EmbeddingProviderError(`embedding vectors must contain ${EMBEDDING_DIMENSIONS} finite numbers`);
  }
  const normalized = new Float32Array(vector);
  for (const value of normalized) {
    if (!Number.isFinite(value)) throw new EmbeddingProviderError("embedding vector contains a value outside the Float32 range");
  }
  return normalized;
}

export function validateEmbeddings(value: unknown, expected: number): number[][] {
  const response = value as { data?: unknown; shape?: unknown };
  if (!response || !Array.isArray(response.data) || response.data.length !== expected) {
    throw new EmbeddingProviderError("Workers AI returned an invalid embedding count");
  }
  if (Array.isArray(response.shape) && (response.shape[0] !== expected || response.shape[1] !== EMBEDDING_DIMENSIONS)) {
    throw new EmbeddingProviderError("Workers AI returned an invalid embedding shape");
  }
  return response.data.map((vector) => {
    if (!Array.isArray(vector)) throw new EmbeddingProviderError("embedding vectors must be arrays");
    return Array.from(normalizeEmbeddingVector(vector));
  });
}

export function workersAiEmbeddingProvider(ai: WorkersAiBinding): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      if (texts.some((text) => !text.trim())) throw new EmbeddingProviderError("embedding text must not be empty");
      if (!texts.length) return [];
      try {
        return validateEmbeddings(await ai.run(EMBEDDING_MODEL, { text: texts }), texts.length);
      } catch (error) {
        if (isEmbeddingProviderError(error)) throw error;
        throw new EmbeddingProviderError("Workers AI embedding inference failed", { cause: error });
      }
    }
  };
}

export function vectorToBlob(vector: number[]): Uint8Array {
  return new Uint8Array(normalizeEmbeddingVector(vector).buffer);
}

export function blobToVector(blob: Uint8Array | ArrayBuffer): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength !== EMBEDDING_DIMENSIONS * 4) throw new Error("stored embedding has an invalid byte length");
  const vector = new Float32Array(bytes.slice().buffer);
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("stored embedding contains a non-finite Float32 value");
  }
  return vector;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) throw new Error("vectors must have equal non-zero dimensions");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

export const EMBEDDING_CHUNK_MAX_BYTES = 384;
export const EMBEDDING_CHUNK_OVERLAP_BYTES = 64;

export function chunkText(text: string, maxBytes = EMBEDDING_CHUNK_MAX_BYTES, overlapBytes = EMBEDDING_CHUNK_OVERLAP_BYTES): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  if (maxBytes < 1 || overlapBytes < 0 || overlapBytes >= maxBytes) throw new Error("invalid chunk byte bounds");
  const characters = Array.from(normalized);
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  for (let start = 0; start < characters.length;) {
    let end = start, bytes = 0;
    while (end < characters.length) {
      const size = encoder.encode(characters[end]!).byteLength;
      if (end > start && bytes + size > maxBytes) break;
      bytes += size; end += 1;
    }
    const chunk = characters.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    if (end === characters.length) break;
    let overlapStart = end, overlap = 0;
    while (overlapStart > start) {
      const size = encoder.encode(characters[overlapStart - 1]!).byteLength;
      if (overlap + size > overlapBytes) break;
      overlap += size; overlapStart -= 1;
    }
    start = overlapStart > start ? overlapStart : end;
  }
  return chunks;
}
