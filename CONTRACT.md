# Arra Memory Lab — runtime contract

This file is the implementation boundary for the standalone lab. It is intentionally smaller than the production Arra Memory service.

## Goal

One Cloudflare Worker, one automatically provisioned D1 database, one OAuth KV namespace, one Workers AI binding, one React UI, and one OAuth-protected Streamable HTTP MCP endpoint.

The lab demonstrates five reusable memory-system contracts:

1. `memories` is authoritative; embeddings and observations are derived.
2. Hybrid recall exposes requested mode, effective mode, fallback, and rank provenance.
3. Observations retain exact source IDs, revisions, and hashes, then become stale or retracted when sources change.
4. Rebuild and forget operations preview impact before confirmed mutation; forget confirmation is bound to the exact preview snapshot.
5. Search traces retain bounded metadata and ranked result snapshots, never raw query or memory content.
6. Supersession is an immutable pointer to one exact memory ID/revision/hash snapshot, not a temporal inference engine.

## Deployment boundary

- Runtime: Cloudflare Workers
- HTTP framework: Elysia
- UI: React + Vite
- ORM: Drizzle ORM
- Storage: D1 (chosen instead of Turso because Deploy to Cloudflare can provision D1 automatically)
- Embeddings: Workers AI `@cf/google/embeddinggemma-300m`, 768 dimensions
- MCP: `@modelcontextprotocol/server@2.0.0`, stateless Streamable HTTP at `/mcp`; modern `2026-07-28` plus stateless 2025-era compatibility, with no `Mcp-Session-Id`
- Access: `Authorization: Bearer $LAB_ACCESS_TOKEN` for private `/api/*`; OAuth 2.1 + S256 PKCE + DCR for `/mcp`
- Release identity: `package.json` is authoritative Bangkok CalVer (`YY.M.D-alpha.HMM`); `/api/info`, MCP `initialize`, `lab_info`, and the UI footer expose the same value.

This is a single-user lab, not a multi-tenant production service. It must fail closed when `LAB_ACCESS_TOKEN` is absent.

Creating/indexing memory sends canonical memory chunks to Workers AI. Semantic/hybrid recall sends query text to Workers AI. Keyword recall and dry-run rebuilds do not invoke AI. D1 retains authoritative text and derived chunk text/vectors; the bounded trace table retains neither raw query nor memory content.

## HTTP API

- `GET /api/info` — public architecture/capability disclosure; no corpus content.
- `GET /api/state` — memories, observations with evidence, bounded traces, coverage/stats.
- `POST /api/memories` — create authoritative memory; indexing is best effort. Optional structured provenance is `project`, `sourcePath`, and `createdBy`; optional `oracleName` becomes an `oracle-<name>` tag. Optional `supersedesMemoryId` must resolve to an existing exact snapshot.
- `PATCH /api/memories/:id` — increment source revision, invalidate chunks, mark dependent observations stale.
- `POST /api/memories/:id/forget` — `{confirm:false}` returns `expectedRevision`, `expectedHash`, `expectedChunks`, and `expectedObservationCount`; confirmation must echo all four with `{confirm:true,...}`. Changed authority or impact fails `409 stale_preview` instead of deleting.
- `POST /api/search` — `{query,mode,kind?,project?,limit?}`; mode is `keyword|semantic|hybrid`; the response includes a correlation `traceId` only when the trace and result links were persisted.
- `POST /api/observations` — manual statement plus 1–8 source memory IDs; stores evidence snapshots.
- `POST /api/index/rebuild` — dry-run by default; confirmed work is bounded to 10 memories and 256 chunks.

## MCP tools

`lab_info`, `remember`, `recall`, `observe`, `forget`, `rebuild_index`, `memory_stats`, `trace_list`, `trace_get`.

`lab_info` is available to every valid OAuth token. `memory:read` adds `recall`, `memory_stats`, `trace_list`, and `trace_get`. `memory:write` adds `remember`, `observe`, `forget`, and `rebuild_index`. A token carrying both advertised scopes receives the full nine-tool catalog.

## Data authority

- `memories`: authoritative source rows with monotonic integer revision.
- `memory_chunks`: rebuildable embedding projection with source revision/hash.
- `observations`: derived assertions; source snapshots live in `observation_sources`.
- `search_traces`: bounded operational metadata; newest 100 only; no raw query or content.
- `search_trace_results`: ranked memory ID/revision/hash/score snapshots; no memory foreign key, so links survive forget; trace pruning cascades.

## Failure semantics

- An embedding failure never rolls back a successful authoritative memory write.
- Hybrid mode falls back only for embedding-provider failures and says so.
- Explicit semantic mode fails when semantic inference is unavailable.
- Database/vector parsing failures are not mislabeled as AI fallback.
- Trace-write failure never changes a successful search into a failure and never masks the original error.
- Completed trace insertion, result-link insertion, and retention pruning share one D1 batch where supported.
- A superseding write is removed if the referenced source snapshot changes during creation.
- Rebuild rechecks source revision/hash before replacing derived chunks.
- Forget confirmation rechecks the previewed revision, hash, chunk count, and dependent-observation count atomically before deleting.

`kind` includes `note`, `decision`, `lesson`, `context`, `retrospective`, and `cheatsheet`. Repository identity is stored once as canonical `project` (for example `github.com/owner/repo`), not duplicated into tags. `sourcePath` points to the artifact. `createdBy` identifies the producer (`manual`, `rrr`, or another explicit producer). Oracle identity remains a tag because it is optional discovery metadata rather than the authority scope.

## Deferred on purpose

Tenants, per-user scopes, external identity providers, OAuth revocation UI, graph expansion, supersession inference, mental-model generation, async queues, external providers, ANN indexes, autonomous consolidation, and temporal knowledge graphs.
