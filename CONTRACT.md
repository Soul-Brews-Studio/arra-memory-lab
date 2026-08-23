# Arra Memory Lab — frozen v1 contract

This file is the implementation boundary for the standalone lab. It is intentionally smaller than the production Arra Memory service.

## Goal

One Cloudflare Worker, one automatically provisioned D1 database, one Workers AI binding, one React UI, and one bearer-protected Streamable HTTP MCP endpoint.

The lab demonstrates five reusable memory-system contracts:

1. `memories` is authoritative; embeddings and observations are derived.
2. Hybrid recall exposes requested mode, effective mode, fallback, and rank provenance.
3. Observations retain exact source IDs, revisions, and hashes, then become stale or retracted when sources change.
4. Rebuild and forget operations preview impact before confirmed mutation; forget confirmation is bound to the exact preview snapshot.
5. Search traces retain bounded metadata, never raw query or memory content.

## Deployment boundary

- Runtime: Cloudflare Workers
- HTTP framework: Elysia
- UI: React + Vite
- ORM: Drizzle ORM
- Storage: D1 (chosen instead of Turso because Deploy to Cloudflare can provision D1 automatically)
- Embeddings: Workers AI `@cf/google/embeddinggemma-300m`, 768 dimensions
- MCP: stateless Streamable HTTP at `/mcp`
- Access: `Authorization: Bearer $LAB_ACCESS_TOKEN` for every `/api/*` route except `/api/info`, and for `/mcp`

This is a single-user lab, not a multi-tenant production service. It must fail closed when `LAB_ACCESS_TOKEN` is absent.

Creating/indexing memory sends canonical memory chunks to Workers AI. Semantic/hybrid recall sends query text to Workers AI. Keyword recall and dry-run rebuilds do not invoke AI. D1 retains authoritative text and derived chunk text/vectors; the bounded trace table retains neither raw query nor memory content.

## HTTP API

- `GET /api/info` — public architecture/capability disclosure; no corpus content.
- `GET /api/state` — memories, observations with evidence, bounded traces, coverage/stats.
- `POST /api/memories` — create authoritative memory; indexing is best effort.
- `PATCH /api/memories/:id` — increment source revision, invalidate chunks, mark dependent observations stale.
- `POST /api/memories/:id/forget` — `{confirm:false}` returns `expectedRevision`, `expectedHash`, `expectedChunks`, and `expectedObservationCount`; confirmation must echo all four with `{confirm:true,...}`. Changed authority or impact fails `409 stale_preview` instead of deleting.
- `POST /api/search` — `{query,mode,kind?,limit?}`; mode is `keyword|semantic|hybrid`.
- `POST /api/observations` — manual statement plus 1–8 source memory IDs; stores evidence snapshots.
- `POST /api/index/rebuild` — dry-run by default; confirmed work is bounded to 10 memories and 256 chunks.

## MCP tools

`lab_info`, `remember`, `recall`, `observe`, `forget`, `rebuild_index`, `memory_stats`.

## Data authority

- `memories`: authoritative source rows with monotonic integer revision.
- `memory_chunks`: rebuildable embedding projection with source revision/hash.
- `observations`: derived assertions; source snapshots live in `observation_sources`.
- `search_traces`: bounded operational metadata; newest 100 only; no raw query or content.

## Failure semantics

- An embedding failure never rolls back a successful authoritative memory write.
- Hybrid mode falls back only for embedding-provider failures and says so.
- Explicit semantic mode fails when semantic inference is unavailable.
- Database/vector parsing failures are not mislabeled as AI fallback.
- Trace-write failure never changes a successful search into a failure and never masks the original error.
- Rebuild rechecks source revision/hash before replacing derived chunks.
- Forget confirmation rechecks the previewed revision, hash, chunk count, and dependent-observation count atomically before deleting.

## Deferred on purpose

OAuth/DCR, tenants, graph expansion, mental-model generation, async queues, external providers, ANN indexes, autonomous consolidation, and temporal knowledge graphs.
