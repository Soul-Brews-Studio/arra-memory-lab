import * as schema from "./db/schema";
import { chunkText, isEmbeddingProviderError } from "./embedding";

export const RRF_K = 60;
export const MAX_REBUILD_MEMORIES = 10;
export const MAX_REBUILD_CHUNKS = 256;
export const TRACE_RETENTION = 100;
export const MAX_SEMANTIC_CHUNKS = 1_000;

export interface RankProvenance {
  keywordRank: number | null;
  semanticRank: number | null;
  semanticDistance: number | null;
  keywordRrf: number;
  semanticRrf: number;
}

export interface RankedMemoryResult {
  memory: schema.MemoryRow;
  score: number;
  provenance: RankProvenance;
}

export class SemanticScanLimitError extends Error {
  readonly name = "SemanticScanLimitError";
  readonly code = "semantic_scan_limit";
  constructor() {
    super(`semantic search exceeds the ${MAX_SEMANTIC_CHUNKS}-chunk exact-scan boundary`);
  }
}

export class ForgetPreviewConflictError extends Error {
  readonly name = "ForgetPreviewConflictError";
  readonly code = "stale_preview";
  constructor() {
    super("forget preview is stale; request a new preview before confirming");
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function required(value: string, field: string, max: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return result;
}

export function titleFor(content: string): string {
  const first = content.split(/\r?\n/, 1)[0]!.replace(/^#+\s*/, "").trim();
  return (first || "Untitled memory").slice(0, 160);
}

export function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

export function optionalText(value: string | undefined, field: string, max: number): string | null {
  if (value === undefined) return null;
  const result = value.trim();
  if (!result) return null;
  if (result.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return result;
}

export function projectText(value: string | undefined): string | null {
  const project = optionalText(value, "project", 240);
  return project
    ? project.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()
    : null;
}

export function provenanceTags(tags: string[] | undefined, oracleName: string | undefined): string[] {
  const oracle = optionalText(oracleName, "oracleName", 80);
  if (!oracle) return normalizeTags(tags);
  const oracleTag = `oracle-${oracle.trim().toLowerCase()}`;
  const normalized = normalizeTags(tags).filter((tag) => !tag.startsWith("oracle-"));
  return [oracleTag, ...normalized].slice(0, 10);
}

/**
 * Split a search query into keyword terms.
 *
 * The character class must include `\p{M}` (combining marks). Thai vowels and
 * tone marks are separate combining code points, so a class of only
 * `\p{L}\p{N}` treats them as separators and shreds a word into fragments:
 * "บันทึก" becomes ["บ","นท","ก"]. That breaks keyword search in both
 * directions — the intended memory is missed, and the leftover single-character
 * fragments substring-match unrelated Thai text, so an irrelevant memory scores
 * a hit. Latin text is unaffected, which is why this passes unnoticed.
 */
export function queryTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}

export function limitFor(limit: number | undefined): number {
  return Math.max(1, Math.min(50, Math.trunc(limit ?? 10)));
}

export function safeIndexError(error: unknown): "embedding_provider_failure" | "index_write_failure" {
  return isEmbeddingProviderError(error)
    ? "embedding_provider_failure"
    : "index_write_failure";
}

export function reciprocalRankFuse(
  keyword: schema.MemoryRow[],
  semantic: schema.MemoryRow[],
  limit: number,
  semanticDistances = new Map<string, number>()
): RankedMemoryResult[] {
  const byId = new Map<string, {
    memory: schema.MemoryRow;
    keywordRank: number | null;
    semanticRank: number | null;
  }>();
  keyword.forEach((memory, index) => {
    byId.set(memory.id, { memory, keywordRank: index + 1, semanticRank: null });
  });
  semantic.forEach((memory, index) => {
    const existing = byId.get(memory.id);
    if (existing) existing.semanticRank = index + 1;
    else byId.set(memory.id, { memory, keywordRank: null, semanticRank: index + 1 });
  });
  return [...byId.values()].map(({ memory, keywordRank, semanticRank }) => {
    const keywordRrf = keywordRank ? 1 / (RRF_K + keywordRank) : 0;
    const semanticRrf = semanticRank ? 1 / (RRF_K + semanticRank) : 0;
    return {
      memory,
      score: keywordRrf + semanticRrf,
      provenance: {
        keywordRank,
        semanticRank,
        semanticDistance: semanticDistances.get(memory.id) ?? null,
        keywordRrf,
        semanticRrf
      }
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function isChunkManifestCurrent(
  memory: schema.MemoryRow,
  manifestInput: schema.MemoryChunkRow[]
): boolean {
  const manifest = [...manifestInput].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const expected = chunkText([memory.title, memory.content].join("\n\n"));
  return manifest.length === expected.length && manifest.every((chunk, index) =>
    chunk.chunkIndex === index &&
    chunk.sourceRevision === memory.revision &&
    chunk.sourceHash === memory.contentHash &&
    chunk.chunkText === expected[index] &&
    chunk.embeddingModel === schema.EMBEDDING_MODEL &&
    chunk.embeddingVersion === schema.EMBEDDING_VERSION &&
    chunk.embedding.byteLength === schema.EMBEDDING_DIMENSIONS * 4
  );
}
