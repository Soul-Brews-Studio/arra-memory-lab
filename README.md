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
- **Trace-linked recall:** a recall returns a `traceId` when trace persistence succeeds; ranked result snapshots retain only memory ID, rank/score provenance, source revision, and source hash.
- **Explicit supersession:** `supersedesMemoryId` resolves once at write time into an immutable ID/revision/hash snapshot. It does not infer a temporal graph.
- **Small provenance:** `project`, `sourcePath`, and `createdBy` are structured fields; an Oracle identity remains an `oracle-<name>` tag. `retrospective` and `cheatsheet` are first-class memory kinds.

The trace `queryHash` is a correlation handle, not anonymization—especially for low-entropy queries—so trace access remains protected even though raw query and memory content are omitted.

## Release identity

`package.json` is the single source of truth for the lab's Bangkok CalVer:
`YY.M.D-alpha.HMM`, where `HMM = hour × 100 + minute` in `Asia/Bangkok`.
The build injects only that string into the public client; `/api/info`, MCP
`initialize`, the `lab_info` tool, and the UI footer report the same value.

```sh
npm run version:next   # preview the next available Bangkok minute
npm run version:bump   # update package.json + package-lock.json, no commit/tag
npm run version:check  # fail if format or lock metadata drift
```

The bump command rejects same-minute reuse, clock rollback, unknown flags, and
any CalVer not newer than existing `arra-memory-lab-v*` tags.

This is intentionally not a production identity or tenancy design. The private web API uses one owner bearer secret. The remote MCP lane uses OAuth 2.1, S256 PKCE, Dynamic Client Registration (DCR), expiring access tokens, and refresh tokens so Claude.ai and other web MCP clients can connect without storing the owner passphrase. Tenants, queues, ANN indexes, and autonomous consolidation remain deferred.

### Data flow and privacy boundary

- Creating a memory tries a best-effort embedding after the D1 source write succeeds.
- Semantic/hybrid recall sends the query text to Workers AI.
- A confirmed rebuild sends the selected memory title/content chunks to Workers AI and writes derived vectors to D1.
- Keyword recall and rebuild previews do not call Workers AI.
- D1 stores authoritative text plus derived chunk text/vectors; search traces and result links store only hashes, IDs, ranks, scores, and operational metadata.

Use synthetic or non-sensitive data unless your Cloudflare account policy and threat model explicitly allow this processing. In local development, the Workers AI binding still accesses the remote service and may incur usage.

## Deploy

1. Click **Deploy to Cloudflare** above and authorize the repository deployment.
2. The Cloudflare deployment form prompts for `LAB_ACCESS_TOKEN`. Supply a long random value (for example, one generated with `openssl rand -hex 32`); Cloudflare stores it as a secret binding. The same value unlocks the browser API and approves new OAuth clients, but OAuth clients never receive it.
3. Deploy. The repository's deploy script automatically applies the D1 migrations before building and publishing the Worker.
4. Open the Worker URL. Enter the same token once; the browser stores it only in `sessionStorage`, so closing that browser session clears it.

If the deployment form or automatic migration step needs manual recovery, use the equivalent CLI fallback:

```sh
printf '%s' 'replace-with-a-long-random-token' | npx wrangler secret put LAB_ACCESS_TOKEN
npx wrangler d1 migrations apply DB --remote
```

For a checked-out release, do not edit placeholder IDs in `wrangler.jsonc`.
The release helper builds and tests first, resolves exactly one D1 database
named `arra-memory-lab` and one KV namespace named `arra-memory-lab-oauth`,
writes their IDs only to a mode-`0600` temporary config, applies migrations,
then deploys that same immutable build:

```sh
npm run deploy:dry-run
npm run deploy
```

Private `/api/*` routes require `Authorization: Bearer $LAB_ACCESS_TOKEN`. `/mcp` accepts only access tokens issued by the lab's OAuth provider; the owner secret itself is rejected there. OAuth discovery, DCR, token exchange, and the approval UI live under `/.well-known/*`, `/oauth/*`, and `/authorize`. Only `GET /api/info` is public application content. If `LAB_ACCESS_TOKEN` is absent, private API access and OAuth approval fail closed.

The consent response intentionally omits CSP `form-action`: embedded OAuth
browsers used by real MCP hosts blocked submission even with an exact-origin
allowlist. The form target is a fixed relative `/authorize`; `base-uri 'none'`
prevents base-target rewriting, every DCR-derived field is HTML-escaped, and
the POST path re-parses PKCE/scopes/client state before the OAuth provider
validates and completes the redirect. This is a measured compatibility
boundary, not a general CSP recommendation.

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
  -d '{"title":"Prefer explicit authority","content":"Memories are sources; embeddings are projections.","kind":"retrospective","tags":["architecture"],"project":"github.com/soul-brews-studio/claude-ai-mcp-poc","sourcePath":"ψ/memory/retrospectives/example.md","createdBy":"rrr","oracleName":"neo","supersedesMemoryId":"OPTIONAL_EXISTING_MEMORY_ID"}'

# Hybrid recall exposes requested/effective modes and rank provenance
curl -X POST "$LAB_URL/api/search" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"query":"Which data is authoritative?","mode":"hybrid","project":"github.com/soul-brews-studio/claude-ai-mcp-poc","limit":8}'

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

The lab exposes stateless Streamable HTTP MCP at `/mcp`. A token with both
advertised scopes receives these tools:

`lab_info`, `remember`, `recall`, `observe`, `forget`, `rebuild_index`, `memory_stats`, `trace_list`, `trace_get`.

`lab_info` is always present for a valid token. `memory:read` controls
`recall`, `memory_stats`, `trace_list`, and `trace_get`; `memory:write` controls
`remember`, `observe`, `forget`, and `rebuild_index`. Scope checks use the
unwrapped access-token scope on every stateless request, including refresh-token
downscoping.

The implementation pins `@modelcontextprotocol/server@2.0.0` and uses the
Cloudflare Agents `createMcpHandler` wrapper. “SDK v2” and “protocol version”
are separate axes: the endpoint serves modern `2026-07-28` requests and keeps
the 2025-era `initialize` flow as a stateless compatibility lane. Neither lane
creates an `Mcp-Session-Id`; every request receives a fresh server instance.
See [`docs/mcp-v2-stateless.md`](./docs/mcp-v2-stateless.md) for the proof matrix.

### Connect or reload an MCP client

```sh
npm run mcp:connect -- codex "$LAB_URL/mcp" arra-memory-lab
# or Claude Code:
npm run mcp:connect -- claude "$LAB_URL/mcp" arra-memory-lab
```

The helper registers the URL and starts the client's OAuth login. Re-running it refreshes the registration/login path. For Claude.ai, open **Settings → Connectors → Add custom connector**, enter only `https://…/mcp`, click **Connect**, and enter the lab passphrase on the approval page.

### Bearer versus OAuth

| Surface | Credential | Why |
| --- | --- | --- |
| Browser and curl `/api/*` | static `LAB_ACCESS_TOKEN` bearer | fastest single-owner lab path |
| Claude.ai remote connector `/mcp` | OAuth access/refresh tokens | Claude.ai custom connectors support authless or OAuth, not a user-entered static header |
| Codex / Claude Code `/mcp` | OAuth login via helper | no long-lived owner passphrase in client config |

See [`docs/provenance-oauth-report.md`](./docs/provenance-oauth-report.md) for the measured decision and sanitized proof.

## Failure contracts

- Authoritative memory writes survive embedding failures.
- Hybrid recall degrades only for embedding-provider failures and reports the reason.
- Explicit semantic recall errors if semantic inference is unavailable.
- Database/vector errors are not mislabeled as AI fallback.
- Trace-write failures never alter a successful recall or mask its original error.
- Completed trace, ranked result links, and retention pruning are attempted in one D1 batch; trace persistence remains fail-safe relative to recall.
- Forgetting a memory does not erase historical trace-result or supersession snapshots; pruning a trace cascades to its ranked links.
- Rebuild rechecks source revision/hash before replacing derived chunks.
- Forget confirmation requires the revision, hash, chunk count, and observation count returned by its preview; stale confirmation fails with HTTP `409` / `stale_preview`.

See [`CONTRACT.md`](./CONTRACT.md) for the current runtime boundary and [`DESIGN.md`](./DESIGN.md) for the UI system.

## Primary platform references

- [Cloudflare Deploy buttons and automatic resource provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare D1 binding configuration](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cloudflare OAuth provider for remote MCP](https://github.com/cloudflare/workers-oauth-provider)
- [Anthropic remote MCP connector authentication](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)
- [EmbeddingGemma 300M model contract](https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/)
- [Drizzle ORM with Cloudflare D1](https://orm.drizzle.team/docs/connect-cloudflare-d1)
