# Provenance fields and OAuth-first MCP — measured decision

Date: 2026-08-23
Scope: `arra-memory-lab` v1.1 authentication/provenance decision, followed by the bounded v1.2 trace/supersession extension
Evidence grade: local code + deterministic tests + local Wrangler OAuth runtime + deployed Cloudflare/Claude.ai acceptance.

## Decision

The lab keeps two deliberately small authentication lanes:

| Lane | Authentication | Intended clients |
| --- | --- | --- |
| `/api/*` | one static `LAB_ACCESS_TOKEN` bearer | browser UI, curl, operator scripts |
| `/mcp` | OAuth authorization code, S256 PKCE, DCR, expiring access token + refresh token | Claude.ai, Codex, Claude Code, MCP Inspector |

The owner secret is also the approval-page passphrase. It is never accepted as an MCP access token and is never copied into connector configuration. This avoids a second operator secret while keeping the long-lived owner credential out of MCP clients.

Claude.ai was the deciding constraint. Anthropic documents remote custom connectors as **authless or OAuth-based** and documents DCR support. Its connector form accepts a server URL and runs a Connect flow; it does not expose a field for a custom static `Authorization` header. Static bearer remains simpler for the web API, but it is not the portable Claude.ai connector contract.

## Provenance shape

The `arra-oracle-v3` study found one first-class repository scope (`project`), one artifact pointer (`source_file`), and producer identity (`created_by`). Session summaries add `oracle-<name>` to concepts instead of adding an `oracle_name` database column. RRR files can expose `source: rrr: owner/repo`; the indexer converts that into canonical project scope.

The lab therefore uses:

| Requested concept | Stored representation | Reason |
| --- | --- | --- |
| repo | `project`, e.g. `github.com/owner/repo` | repo and project are the same filter scope here; two columns would diverge |
| path | `source_path` / API `sourcePath` | stable pointer to the RRR, cheatsheet, or source artifact |
| project | `project` | exact structured search filter |
| producer | `created_by` / API `createdBy` | `manual`, `rrr`, `importer`, or another explicit producer |
| oracle name | `oracle-<name>` tag | optional discovery metadata, not authority scope |
| retrospective / cheatsheet | `kind` | content type, not a topic tag |

### Alternatives measured

| Model | Added columns | Exact project filter | RRR path | Duplicate identity | Verdict |
| --- | ---: | --- | --- | --- | --- |
| tags only | 0 | no | untyped | low | too weak |
| repo + project + path + oracle column | 4 | yes | yes | high (`repo` vs `project`) | too easy to drift |
| project + path + producer; Oracle tag | 3 | yes | yes | none | chosen |

No tenant, session, supersession, valid-time, usage-heat, or trace-link sidecar was added. Those need a demonstrated query or lifecycle contract before they earn schema authority.

## API and MCP contract

`remember` and `POST /api/memories` accept:

```json
{
  "title": "What changed",
  "content": "The concrete retrospective text.",
  "kind": "retrospective",
  "tags": ["oauth"],
  "project": "github.com/soul-brews-studio/claude-ai-mcp-poc",
  "sourcePath": "ψ/memory/retrospectives/2026-08/23/example.md",
  "createdBy": "rrr",
  "oracleName": "neo"
}
```

The stored row contains structured `project`, `sourcePath`, and `createdBy`. Its tags become `oracle-neo` plus the supplied topic tags. `recall` and `POST /api/search` accept optional exact `project` filtering in keyword, semantic, and hybrid modes.

Valid kinds are:

```text
note decision lesson context retrospective cheatsheet
```

## OAuth request path

```text
Claude.ai / Codex / Claude Code
  -> GET /.well-known/oauth-protected-resource/mcp
  -> GET /.well-known/oauth-authorization-server
  -> POST /oauth/register                    # DCR
  -> GET /authorize + S256 challenge
  -> owner enters LAB_ACCESS_TOKEN once
  -> POST /authorize
  -> POST /oauth/token                       # code + verifier
  -> POST /mcp Authorization: Bearer <issued access token>
  -> fresh stateless MCP server for the request
```

`@cloudflare/workers-oauth-provider@0.8.1` owns client registration, codes, token issuance, refresh, token hashing, metadata endpoints, and validation in `OAUTH_KV`. The application owns only the small approval page and owner-passphrase comparison.

## Local runtime proof

The sanitized machine-readable artifact is [`evidence/provenance-oauth-local-2026-08-23.json`](./evidence/provenance-oauth-local-2026-08-23.json).

Observed results:

- protected-resource metadata: `200`
- authorization-server metadata: `200`
- DCR public-client registration: `201`
- consent page: `200`
- approval callback redirect: `302`
- token exchange: `200`, access + refresh token issued, `S256` only
- unauthenticated `/mcp`: `401 invalid_token`
- `LAB_ACCESS_TOKEN` sent directly as MCP bearer: `401 invalid_token`
- issued OAuth token: MCP initialize `200`, tools/list `200`
- stateless invariant: no `Mcp-Session-Id`
- tool catalogue: 7 tools; `memory_stats` present
- provenance integration: an RRR retrospective persisted all three structured fields, normalized `oracle-neo`, did not duplicate repository identity into tags, and exact-project recall excluded another repository

Fresh gates:

```text
26 tests passed / 0 failed / 88 expectations
TypeScript typecheck passed
Vite Worker + React production build passed
0002 local migration: 10 commands passed
Wrangler deployment dry-run passed
```

## Connect and reload

```sh
npm run mcp:connect -- codex https://YOUR-WORKER.workers.dev/mcp arra-memory-lab
npm run mcp:connect -- claude https://YOUR-WORKER.workers.dev/mcp arra-memory-lab
```

Both commands register the Streamable HTTP URL and start OAuth login. Claude.ai uses Settings → Connectors → Add custom connector, then the same URL and Connect flow.

## Deployed acceptance

The sanitized deployment artifact is [`evidence/provenance-oauth-production-2026-08-23.json`](./evidence/provenance-oauth-production-2026-08-23.json). It records a successful remote migration with four authoritative rows preserved, OAuth metadata and DCR, a stateless MCP initialize, a real Claude.ai connector tool call, structured provenance create/search/forget cleanup, and a Workers AI semantic recall followed by cleanup. The six screenshots under [`evidence/screenshots/`](./evidence/screenshots/) are the browser evidence for the live UI, consent surface, connected tool catalogue, permission prompt, and returned `memory_stats` payload.

## Stop condition and remaining proof

v1.2 adds only the bounded extensions whose contracts are now explicit: metadata-only ranked trace-result snapshots, `trace_list`/`trace_get`, and one immutable predecessor ID/revision/hash snapshot on a new memory. It still stops before raw-query logs, trace replay, automatic recall suppression, supersession inference, tenant scopes, or automatic filesystem ingestion.

Still unverified: an induced production provider outage, concurrent production mutation races, and relevance/latency/capacity benchmarks. Those require separate controlled acceptance work; deployment existence does not prove them.

## Sources

- local study: `ψ/learn/Soul-Brews-Studio/arra-oracle-v3/2026-08-23/1058_ARCHITECTURE.md`
- local study: `ψ/learn/Soul-Brews-Studio/arra-oracle-v3/2026-08-23/1058_CODE-SNIPPETS.md`
- local study: `ψ/learn/Soul-Brews-Studio/arra-oracle-v3/2026-08-23/1058_QUICK-REFERENCE.md`
- [Anthropic: Building custom connectors via remote MCP](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)
- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
