# MCP SDK v2 stateless deployment note

Date: 2026-08-23

## Name the two version axes

This lab pins the TypeScript **server package**
`@modelcontextprotocol/server@2.0.0`. That package version is not the same
thing as an MCP wire-protocol revision.

The v2 handler supports two protocol eras on one endpoint:

| Era | Opening request | Lab behavior |
| --- | --- | --- |
| modern `2026-07-28` | `server/discover` negotiation, then per-request envelopes | fresh `McpServer` for each request |
| 2025 compatibility | `initialize`, including `2025-06-18` | fresh transport and `McpServer` for each POST |

The production code imports `McpServer` from `@modelcontextprotocol/server`
and the Cloudflare wrapper from `agents/mcp/server`. In `agents@0.21.0`, that
wrapper delegates modern traffic to the SDK v2 `createMcpHandler` and builds
legacy compatibility with `sessionIdGenerator: undefined`.

## Stateless contract

Stateless means the MCP transport keeps no conversational or transport session
between HTTP requests. Durable product data still lives in D1; stateless does
not mean “no database.”

The acceptance contract is:

1. two independent `initialize` POSTs succeed;
2. neither response includes `Mcp-Session-Id`;
3. `tools/list` succeeds without a prior session header;
4. legacy `GET` and `DELETE` session operations return `405`;
5. a second process can call a tool using only the endpoint and bearer token;
6. corpus state survives because it is authoritative D1 state, not handler state.

`src/server.test.ts` locks items 1–4 locally. Deployment acceptance records
items 1–6 without retaining the bearer token, memory text, IDs, or vectors.

## Security boundary

The SDK does not authenticate requests. `src/server.ts` verifies the single
lab bearer token before constructing the MCP handler. This remains a
single-user research deployment: it has no OAuth, tenant isolation, rate
limiting, or public-write safety controls.

## Deep session trace

`/dig --deep` found no Claude session files attributed to this repository, so
the search fell back to all known Claude project histories. Relevant evidence:

- 2026-08-23, `odin-oracle`: the standalone `arra-memory-lab` scaffold and
  deployment-readiness handoff;
- 2026-08-13, `digger-oracle`: the earlier architecture decision separating a
  Durable-Object sessionful handler from the stateless `createMcpHandler`
  lane, and preferring Streamable HTTP over legacy HTTP+SSE;
- older Arra sessions: MCP memory-server research, useful as product history
  but not proof of this lab's v2 runtime.

This trace explains why the lab chose the stateless lane. Source, regression,
and live deployment checks—not session prose—prove the current behavior.

## Evidence grades

- **Source proof:** pinned dependency versions, request-local handler factory,
  and no session generator.
- **Deterministic proof:** server regressions for repeated initialize,
  sessionless tool listing, and `GET`/`DELETE` rejection.
- **Runtime proof:** sanitized deployed URL, status/header matrix, tool count,
  and one non-destructive keyword recall.

Official references:

- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md>
