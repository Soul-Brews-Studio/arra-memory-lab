# Arra Memory Lab

A standalone, single-user Cloudflare lab for learning the contracts behind trustworthy AI memory: authoritative sources, rebuildable embeddings, evidence-backed observations, inspectable hybrid recall, bounded traces, and preview-before-mutation operations.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Soul-Brews-Studio/arra-memory-lab)

The deployment creates one Worker, automatically provisions its D1 database from `wrangler.jsonc`, and runs the included migrations through the deploy script. Workers AI supplies 768-dimensional `@cf/google/embeddinggemma-300m` embeddings.

## What this demonstrates

- **Authority tiers:** memories are authoritative; chunks/embeddings and observations are derived.
- **Honest recall:** every search reports requested mode, effective mode, degradation, and rank provenance.
- **Evidence lineage:** observations retain source memory IDs, revisions, and hashes.
- **Safe mutation:** forget and rebuild are dry-run-first; forget confirmation is bound to the exact preview snapshot, and confirmed rebuild work is bounded.
- **Data minimization:** the newest 100 search traces contain operational metadata, never query or memory content.

The trace `queryHash` is a correlation handle, not anonymization—especially for low-entropy queries—so trace access remains protected even though raw query and memory content are omitted.

This is intentionally not a production identity or tenancy design. It uses one bearer token, fails closed without it, and defers OAuth/DCR, tenants, queues, ANN indexes, and autonomous consolidation.

### Data flow and privacy boundary

- Creating a memory tries a best-effort embedding after the D1 source write succeeds.
- Semantic/hybrid recall sends the query text to Workers AI.
- A confirmed rebuild sends the selected memory title/content chunks to Workers AI and writes derived vectors to D1.
- Keyword recall and rebuild previews do not call Workers AI.
- D1 stores authoritative text plus derived chunk text/vectors; search traces store only a query hash and operational metadata.

Use synthetic or non-sensitive data unless your Cloudflare account policy and threat model explicitly allow this processing. In local development, the Workers AI binding still accesses the remote service and may incur usage.

## Deploy

1. Click **Deploy to Cloudflare** above and authorize the repository deployment.
2. The Cloudflare deployment form prompts for `LAB_ACCESS_TOKEN`. Supply a long random value (for example, one generated with `openssl rand -hex 32`); Cloudflare stores it as a secret binding.
3. Deploy. The repository's deploy script automatically applies the D1 migrations before building and publishing the Worker.
4. Open the Worker URL. Enter the same token once; the browser stores it only in `sessionStorage`, so closing that browser session clears it.

If the deployment form or automatic migration step needs manual recovery, use the equivalent CLI fallback:

```sh
printf '%s' 'replace-with-a-long-random-token' | npx wrangler secret put LAB_ACCESS_TOKEN
npx wrangler d1 migrations apply DB --remote
```

The API and `/mcp` require `Authorization: Bearer $LAB_ACCESS_TOKEN`. Only `GET /api/info` is public, and it discloses architecture/capabilities—not corpus content. If `LAB_ACCESS_TOKEN` is absent, protected access fails closed.

### Why D1 for one-click deployment?

D1 is used because Cloudflare's deployment flow can provision and bind it automatically, keeping this lab genuinely close to one click. The tradeoff is deliberate provider coupling: this version does not demonstrate a portable database layer or Turso/libSQL deployment. That is acceptable for a focused Cloudflare lab, not a blanket production recommendation.

## Local development

Requires Node.js for install/build/deploy, Bun for the test/check scripts, and a Cloudflare account for Workers AI. Wrangler warns because the AI binding remains remote even while the Worker and D1 run locally.

```sh
cd labs/arra-memory-lab
npm install
cp .env.example .dev.vars
# Set LAB_ACCESS_TOKEN in .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

Quality checks:

```sh
npm run typecheck
npm test
npm run build
# or all three:
npm run check
```

The `postbuild` hook removes `.env*` and `.dev.vars*` files from `dist/`. This is defense in depth for local artifacts; Wrangler's deploy manifest does not upload those development files.

## HTTP examples

```sh
export LAB_URL='https://arra-memory-lab.<account>.workers.dev'
export LAB_ACCESS_TOKEN='your-long-random-token'
export AUTH="Authorization: Bearer $LAB_ACCESS_TOKEN"

# Public capability disclosure
curl "$LAB_URL/api/info"

# Create an authoritative memory (indexing is best effort)
curl -X POST "$LAB_URL/api/memories" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"Prefer explicit authority","content":"Memories are sources; embeddings are projections.","kind":"decision","tags":["architecture"]}'

# Hybrid recall exposes requested/effective modes and rank provenance
curl -X POST "$LAB_URL/api/search" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"query":"Which data is authoritative?","mode":"hybrid","limit":8}'

# Preview a forget and retain the returned expected* fields
curl -X POST "$LAB_URL/api/memories/MEMORY_ID/forget" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"confirm":false}'

# Confirm only that exact preview. A changed source/impact returns 409 stale_preview.
curl -X POST "$LAB_URL/api/memories/MEMORY_ID/forget" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"confirm":true,"expectedRevision":1,"expectedHash":"COPY_FROM_PREVIEW","expectedChunks":0,"expectedObservationCount":0}'

# Preview a bounded rebuild; confirmed work is capped at 10 memories / 256 chunks
curl -X POST "$LAB_URL/api/index/rebuild" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"confirm":false}'
```

## MCP

The lab exposes stateless Streamable HTTP MCP at `/mcp` with these tools:

`lab_info`, `remember`, `recall`, `observe`, `forget`, `rebuild_index`, `memory_stats`.

The implementation pins `@modelcontextprotocol/server@2.0.0` and uses the
Cloudflare Agents `createMcpHandler` wrapper. “SDK v2” and “protocol version”
are separate axes: the endpoint serves modern `2026-07-28` requests and keeps
the 2025-era `initialize` flow as a stateless compatibility lane. Neither lane
creates an `Mcp-Session-Id`; every request receives a fresh server instance.
See [`docs/mcp-v2-stateless.md`](./docs/mcp-v2-stateless.md) for the proof matrix.

### MCP endpoint check with curl

```sh
curl -X POST "$LAB_URL/mcp" \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### MCP client configuration

For clients that support Streamable HTTP servers:

```json
{
  "mcpServers": {
    "arra-memory-lab": {
      "type": "http",
      "url": "https://arra-memory-lab.<account>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${LAB_ACCESS_TOKEN}"
      }
    }
  }
}
```

If your client does not interpolate environment variables in headers, use its secret manager rather than committing the token. The exact configuration wrapper varies by MCP client; the endpoint and bearer header do not.

## Failure contracts

- Authoritative memory writes survive embedding failures.
- Hybrid recall degrades only for embedding-provider failures and reports the reason.
- Explicit semantic recall errors if semantic inference is unavailable.
- Database/vector errors are not mislabeled as AI fallback.
- Trace-write failures never alter a successful recall or mask its original error.
- Rebuild rechecks source revision/hash before replacing derived chunks.
- Forget confirmation requires the revision, hash, chunk count, and observation count returned by its preview; stale confirmation fails with HTTP `409` / `stale_preview`.

See [`CONTRACT.md`](./CONTRACT.md) for the frozen v1 boundary and [`DESIGN.md`](./DESIGN.md) for the UI system.

## Primary platform references

- [Cloudflare Deploy buttons and automatic resource provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare D1 binding configuration](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [EmbeddingGemma 300M model contract](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/)
- [Drizzle ORM with Cloudflare D1](https://orm.drizzle.team/docs/connect-cloudflare-d1)
