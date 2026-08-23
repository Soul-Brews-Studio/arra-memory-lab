# Learned patterns

Reusable lessons demonstrated by Arra Memory Lab.

## Selective source map

This lab is a synthesis, not a compatibility layer or a miniature clone. Each borrowed idea was reduced to a contract that can be inspected in one Worker.

| Studied system | What this lab adapts | Where the proof lives here | What it deliberately does not copy |
| --- | --- | --- | --- |
| Arra Memory | authoritative memory rows, rebuildable embeddings, explicit requested/effective search mode, metadata-only trace retention | `memories`/`memory_chunks`, `searchMemories`, `search_traces` | OAuth/DCR, multi-client production state, Turso, local profile fleet |
| Hindsight | source-aware derivation and evidence-backed higher-order claims | chunk revision/hash manifests; `observations` + `observation_sources` | automatic extraction ladder, mental models, entity/temporal graph, large retrieval planner |
| Mem0 | provider capability boundaries and separation of optional enrichment failure from the primary write | `EmbeddingProvider`, public model/dimension disclosure, best-effort indexing result | automatic fact extraction, provider matrix, vector payload as the only current memory state |
| Honcho | derived claims stay scoped to durable source state; retrieval must rejoin current authority before returning it | observation evidence snapshots; semantic query joins chunks to current `memories` and rejects stale revisions/hashes | directional peer models, queues, dreamer/reconciler, agentic dialectic |
| MemPalace | repair should have visible ground truth, preview, bounds, and a clean stop condition | coverage stats; dry-run-first rebuild; 10-memory/256-chunk work budget | palace taxonomy, Chroma/HNSW stack, in-place index surgery, filesystem ingestion suite |

The names above identify design provenance only. The executable contract is this repository's code and tests; no external system's runtime or API behavior is implied.

## 1. Declare authority before adding intelligence

The `memories` row is the durable claim. An embedding is a projection of a particular revision/hash and can be deleted or rebuilt. This separation prevents an inference product from quietly becoming the source of truth.

**Pattern:** every derived row should be traceable to immutable source identity and safely replaceable.

## 2. Make retrieval degradation part of the response

“Hybrid search” is not one stable behavior when an embedding provider can fail. Returning requested mode, effective mode, fallback reason, and per-result rank provenance makes the system debuggable and prevents silent quality changes.

**Pattern:** model/provider fallback is a named outcome, not a hidden implementation detail. Do not use it to disguise database or parsing failures.

## 3. Evidence snapshots outlive sources

An observation stores the source memory ID, revision, and hash it relied on. Editing that memory makes the observation stale; forgetting it retracts the observation without erasing the historical evidence identity.

**Pattern:** derived assertions need lifecycle states and durable citations, not only foreign keys to current rows.

## 4. Preview destructive and expensive work

Forget and rebuild share a two-step contract: `{confirm:false}` describes impact; confirmation performs it. Forget confirmation must echo the previewed revision, hash, chunk count, and observation count, so a changed source or impact fails `stale_preview` instead of deleting. Rebuild additionally caps each run and rechecks revision/hash immediately before replacement.

**Pattern:** make dry-run the default, bind destructive confirmation to the preview snapshot, bound confirmed work, and protect against time-of-check/time-of-use drift.

## 5. Observability should not recreate sensitive input

Search traces keep modes, fallback category, kind filter, limits, result count, duration, status, and error category. They do not retain the raw query or memory content and are capped to the newest 100 rows.

The query hash supports correlation, not anonymization: low-entropy queries may be guessable, so hashed identifiers still belong behind the protected corpus boundary.

**Pattern:** decide the minimum diagnostic metadata and enforce both payload and retention bounds.

## 6. Best-effort enrichment must not weaken authoritative writes

Embedding happens after the memory has succeeded as an authoritative write. Provider failure affects semantic coverage and is surfaced, but it does not roll back the source.

**Pattern:** structure optional enrichment as a recoverable projection pipeline rather than a transaction prerequisite.

## 7. One-click infrastructure choices have honest costs

D1 enables automatic Cloudflare provisioning and makes the experiment easy to deploy. It also couples the lab to Cloudflare and does not exercise portable database infrastructure.

**Pattern:** optimize a lab for learning friction, state the tradeoff plainly, and avoid presenting that choice as universal production guidance.

## 8. Provenance fields and discovery tags answer different questions

Repository scope, artifact path, and producer are structured because operators filter, display, and audit them. Oracle identity remains an `oracle-<name>` tag because it is optional discovery metadata, not the authority boundary. `retrospective` and `cheatsheet` are kinds because they describe what the record is.

**Pattern:** persist one canonical scope, type artifacts explicitly, and do not duplicate authority fields into tags.

## 9. Authentication should match the host surface

A static bearer is the smallest operator contract for curl and a single-user browser API. Claude.ai remote connectors expose authless or OAuth flows, so the MCP lane uses OAuth/DCR while the API retains bearer. The owner passphrase approves a connector but is rejected as an MCP token.

**Pattern:** choose the smallest credential protocol every required host can actually configure; keep unrelated surfaces on simpler lanes.
