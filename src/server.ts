import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { drizzle } from "drizzle-orm/d1";
import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { z } from "zod";
import {
  createMemory,
  createObservation,
  ForgetPreviewConflictError,
  forgetMemory,
  getSearchTrace,
  getLabState,
  listSearchTraces,
  rebuildIndex,
  searchMemories,
  SemanticScanLimitError,
  updateMemory,
  MAX_SEMANTIC_CHUNKS,
  type LabDatabase,
  type MemoryKind,
  type SearchMode
} from "./domain";
import {
  EmbeddingProviderError,
  workersAiEmbeddingProvider,
  type EmbeddingProvider,
  type WorkersAiBinding
} from "./embedding";
import { MEMORY_KINDS, SEARCH_MODES } from "./db/schema";
import { LAB_VERSION } from "./version";

export interface Env {
  DB: D1Database;
  AI?: WorkersAiBinding;
  LAB_ACCESS_TOKEN?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SEMANTIC_MAX_DISTANCE?: string;
}

const requestEnvironments = new WeakMap<Request, Env>();
const memoryKindSchema = z.enum(MEMORY_KINDS);
const searchModeSchema = z.enum(SEARCH_MODES);
const READ_SCOPE = "memory:read";
const WRITE_SCOPE = "memory:write";
const MCP_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;

function hasSupportedScopes(request: AuthRequest): boolean {
  return Array.isArray(request.scope) && request.scope.length > 0 && request.scope.every((scope) =>
    MCP_SCOPES.includes(scope as (typeof MCP_SCOPES)[number])
  );
}

function authorizationRequestUrl(origin: string, request: AuthRequest): string {
  const url = new URL("/authorize", origin);
  url.searchParams.set("response_type", request.responseType);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", request.scope.join(" "));
  url.searchParams.set("state", request.state);
  if (request.codeChallenge) url.searchParams.set("code_challenge", request.codeChallenge);
  if (request.codeChallengeMethod) {
    url.searchParams.set("code_challenge_method", request.codeChallengeMethod);
  }
  for (const resource of Array.isArray(request.resource)
    ? request.resource
    : request.resource
      ? [request.resource]
      : []) {
    url.searchParams.append("resource", resource);
  }
  return url.href;
}

const createMemorySchema = z
  .object({
    title: z.string().max(160).optional(),
    content: z.string().min(1).max(12_000),
    kind: memoryKindSchema.optional(),
    tags: z.array(z.string().max(80)).max(10).optional(),
    project: z.string().max(240).optional(),
    sourcePath: z.string().max(500).optional(),
    createdBy: z.string().max(80).optional(),
    oracleName: z.string().max(80).optional(),
    supersedesMemoryId: z.string().min(1).max(128).optional()
  })
  .strict();

const updateMemorySchema = createMemorySchema
  .omit({ supersedesMemoryId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required"
  });

const searchSchema = z
  .object({
    query: z.string().min(1).max(500),
    mode: searchModeSchema.default("hybrid"),
    kind: memoryKindSchema.optional(),
    project: z.string().max(240).optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict();

const observationSchema = z
  .object({
    statement: z.string().min(1).max(4_000),
    sourceMemoryIds: z.array(z.string().min(1)).min(1).max(8)
  })
  .strict();

const confirmationSchema = z
  .object({ confirm: z.boolean().optional().default(false) })
  .strict();

const forgetSchema = z.union([
  z.object({ confirm: z.literal(false).optional() }).strict(),
  z
    .object({
      confirm: z.literal(true),
      expectedRevision: z.number().int().min(1),
      expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
      expectedChunks: z.number().int().min(0),
      expectedObservationCount: z.number().int().min(0)
    })
    .strict()
]);

const mcpForgetSchema = z.union([
  z.object({
    memoryId: z.string().min(1),
    confirm: z.literal(false).optional()
  }),
  z.object({
    memoryId: z.string().min(1),
    confirm: z.literal(true),
    expectedRevision: z.number().int().min(1),
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedChunks: z.number().int().min(0),
    expectedObservationCount: z.number().int().min(0)
  })
]);

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function envFor(request: Request): Env {
  const env = requestEnvironments.get(request);
  if (!env) throw new Error("request environment is unavailable");
  return env;
}

function database(env: Env): LabDatabase {
  return drizzle(env.DB);
}

function embeddingProvider(env: Env): EmbeddingProvider | null {
  return env.AI ? workersAiEmbeddingProvider(env.AI) : null;
}

function semanticMaxDistance(env: Env): number {
  const value = Number(env.SEMANTIC_MAX_DISTANCE ?? "0.7");
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("SEMANTIC_MAX_DISTANCE must be a number from 0 to 2");
  }
  return value;
}

export async function constantTimeTextEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.LAB_ACCESS_TOKEN?.trim();
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match ? constantTimeTextEqual(match[1]!, expected) : false;
}

/** OAuth authorization is accepted only when PKCE is present and pinned to S256. */
export function hasStrictS256Pkce(request: AuthRequest): boolean {
  return request.codeChallengeMethod === "S256" &&
    typeof request.codeChallenge === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge);
}

async function requireAccess(request: Request): Promise<Response | null> {
  const env = envFor(request);
  if (!env.LAB_ACCESS_TOKEN?.trim()) {
    return json(
      {
        error: "lab_not_configured",
        message: "LAB_ACCESS_TOKEN must be configured before private routes can be used."
      },
      503
    );
  }
  if (!(await isAuthorized(request, env))) {
    return json(
      { error: "unauthorized", message: "Send the lab token as a Bearer credential." },
      401,
      { "www-authenticate": 'Bearer realm="Arra Memory Lab"' }
    );
  }
  return null;
}

function validationResponse(error: z.ZodError): Response {
  return json(
    {
      error: "invalid_request",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    },
    400
  );
}

function safeError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "unknown error";
  if (error instanceof SemanticScanLimitError) {
    return json(
      {
        error: error.code,
        message: `Exact semantic recall is capped at ${MAX_SEMANTIC_CHUNKS} current chunks in this lab. Use keyword mode or reduce the corpus.`
      },
      422
    );
  }
  if (error instanceof ForgetPreviewConflictError) {
    return json(
      {
        error: error.code,
        message: "The memory or its derived impact changed after preview. Request a fresh preview before confirming."
      },
      409
    );
  }
  if (message === "memory update conflict") {
    return json(
      {
        error: "revision_conflict",
        message: "The memory changed while this revision was being applied. Reload and retry."
      },
      409
    );
  }
  const clientError =
    /(?:required|characters or fewer|memory not found|source memories|do not exist|1 to 8)/i.test(
      message
    );
  const status = clientError ? (message === "memory not found" ? 404 : 400) : error instanceof EmbeddingProviderError ? 503 : 500;
  console.error("Arra Memory Lab request failed", {
    category: error instanceof EmbeddingProviderError ? "embedding_provider" : clientError ? "input" : "internal",
    message
  });
  return json(
    {
      error:
        error instanceof EmbeddingProviderError
          ? "embedding_provider_error"
          : clientError
            ? "invalid_request"
            : "internal_error",
      message:
        error instanceof EmbeddingProviderError
          ? "Semantic inference is unavailable. Keyword mode remains available."
          : clientError
            ? message
            : "The lab could not complete this operation."
    },
    status
  );
}

function parseBody<T>(body: unknown, schema: z.ZodType<T>): T | Response {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : validationResponse(parsed.error);
}

const info = {
  name: "Arra Memory Lab",
  version: LAB_VERSION,
  versionScheme: "Bangkok CalVer YY.M.D-alpha.HMM",
  purpose: "A small, inspectable memory-system lab built from five open-source architecture studies.",
  runtime: "Cloudflare Workers",
  http: "Elysia",
  ui: "React + Vite",
  persistence: "Cloudflare D1 via Drizzle ORM",
  embeddings: {
    provider: "Cloudflare Workers AI",
    model: "@cf/google/embeddinggemma-300m",
    dimensions: 768,
    vectorSearch: `exact cosine scan capped at ${MAX_SEMANTIC_CHUNKS} current chunks`
  },
  mcp: {
    endpoint: "/mcp",
    sdk: "@modelcontextprotocol/server@2.0.0",
    wrapper: "agents@0.21.0 createMcpHandler",
    transport: "stateless Streamable HTTP",
    sessionMode: "one fresh MCP server per request; no Mcp-Session-Id",
    protocolEras: ["2026-07-28 modern", "2025 legacy compatibility"],
    tools: [
      "lab_info",
      "remember",
      "recall",
      "observe",
      "forget",
      "rebuild_index",
      "memory_stats",
      "trace_list",
      "trace_get"
    ]
  },
  authority: {
    source: "memories",
    provenance: "project + sourcePath + createdBy; oracleName is a normalized tag; supersession pins an exact source snapshot",
    derived: ["memory_chunks", "observations", "observation_sources"],
    operational: ["search_traces", "search_trace_results"]
  },
  guarantees: [
    "vectors are never authoritative",
    "hybrid fallback is explicit",
    "observation evidence retains source revision and hash",
    "forget and rebuild preview before mutation",
    "search traces and ranked result links never store raw query or memory content",
    "supersession is an immutable snapshot link, not a temporal inference engine"
  ],
  security: {
    mode: "OAuth 2.1 + PKCE/DCR for /mcp; static bearer for private /api routes",
    processing: "Create/rebuild sends memory chunks to Workers AI; semantic/hybrid recall sends query text. Keyword recall and previews do not call AI.",
    warning: "Lab only: one owner approval secret, no tenant isolation, rate limiting, or public-write safety controls."
  }
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]!);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Embedded OAuth browsers have blocked even exact-origin form-action lists.
      // The form target is fixed below and base-uri prevents target rewriting.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function handleAuthorization(request: Request, env: Env): Promise<Response> {
  if (!env.LAB_ACCESS_TOKEN?.trim()) {
    return json({ error: "lab_not_configured" }, 503);
  }
  if (request.method === "GET") {
    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return html("<h1>Invalid authorization request</h1>", 400);
    }
    if (!hasStrictS256Pkce(oauthRequest)) {
      return html("<h1>S256 PKCE is required</h1>", 400);
    }
    if (!hasSupportedScopes(oauthRequest)) {
      return html("<h1>At least one supported memory scope is required</h1>", 400);
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return html("<h1>Unknown OAuth client</h1>", 400);
    const state = btoa(JSON.stringify(oauthRequest));
    const requestedScopes = oauthRequest.scope.length > 0
      ? oauthRequest.scope.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")
      : "<li><code>none</code></li>";
    return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Arra Memory Lab</title><style>body{font:16px system-ui;background:#090b12;color:#eef2ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(34rem,calc(100% - 2rem));background:#151926;border:1px solid #343b52;border-radius:18px;padding:2rem;box-sizing:border-box}h1{margin-top:0}p{color:#b9c1d9;line-height:1.55}code{overflow-wrap:anywhere}label{display:grid;gap:.5rem;margin:1.5rem 0}input,button{font:inherit;padding:.8rem 1rem;border-radius:10px}input{border:1px solid #4a536f;background:#0d1019;color:#fff}button{border:0;background:#8fffd4;color:#07120e;font-weight:700;cursor:pointer}</style></head><body><main class="card"><p>Arra Memory Lab · OAuth</p><h1>Connect ${escapeHtml(client.clientName || "MCP client")}</h1><p>This grants the client access to the requested MCP memory tools. The browser passphrase is exchanged locally with this Worker; the MCP client receives a revocable OAuth token, not the passphrase.</p><p><strong>Redirect URI</strong><br><code>${escapeHtml(oauthRequest.redirectUri)}</code></p><p><strong>Requested scopes</strong></p><ul>${requestedScopes}</ul><form method="post" action="/authorize"><input type="hidden" name="state" value="${escapeHtml(state)}"><label>Lab passphrase<input name="passphrase" type="password" required autocomplete="current-password" autofocus></label><button type="submit">Authorize MCP client</button></form></main></body></html>`);
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const form = await request.formData();
  const passphrase = form.get("passphrase");
  if (typeof passphrase !== "string" || !(await constantTimeTextEqual(passphrase, env.LAB_ACCESS_TOKEN))) {
    return html("<h1>Invalid lab passphrase</h1>", 403);
  }
  const state = form.get("state");
  if (typeof state !== "string") return html("<h1>Missing authorization state</h1>", 400);
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(atob(state)) as AuthRequest;
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(
      new Request(authorizationRequestUrl(request.url, oauthRequest))
    );
  } catch {
    return html("<h1>Invalid authorization state</h1>", 400);
  }
  if (!hasStrictS256Pkce(oauthRequest)) {
    return html("<h1>S256 PKCE is required</h1>", 400);
  }
  if (!hasSupportedScopes(oauthRequest)) {
    return html("<h1>At least one supported memory scope is required</h1>", 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return html("<h1>Unknown OAuth client</h1>", 400);
  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "owner",
      metadata: { label: "Arra Memory Lab", clientName: client.clientName || "MCP client" },
      scope: oauthRequest.scope,
      props: { userId: "owner", username: "Arra Memory Lab owner" }
    }));
  } catch (error) {
    console.error("Arra Memory Lab OAuth completion failed", {
      category: "oauth_provider",
      errorType: error instanceof Error ? error.name : "unknown"
    });
    return html("<h1>Authorization is temporarily unavailable</h1>", 503);
  }
  return Response.redirect(redirectTo, 302);
}

function createApiApp() {
  return new Elysia({ adapter: CloudflareAdapter, aot: false })
    .get("/api/info", () => json(info))
    .get("/api/state", async ({ request }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      try {
        return json(await getLabState(database(envFor(request))));
      } catch (error) {
        return safeError(error);
      }
    })
    .post("/api/memories", async ({ request, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, createMemorySchema);
      if (body instanceof Response) return body;
      try {
        const env = envFor(request);
        return json(await createMemory(database(env), embeddingProvider(env), body), 201);
      } catch (error) {
        return safeError(error);
      }
    })
    .patch("/api/memories/:id", async ({ request, params, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, updateMemorySchema);
      if (body instanceof Response) return body;
      try {
        return json({ memory: await updateMemory(database(envFor(request)), params.id, body) });
      } catch (error) {
        return safeError(error);
      }
    })
    .post("/api/memories/:id/forget", async ({ request, params, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, forgetSchema);
      if (body instanceof Response) return body;
      try {
        return json({ result: await forgetMemory(database(envFor(request)), params.id, body) });
      } catch (error) {
        return safeError(error);
      }
    })
    .post("/api/search", async ({ request, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, searchSchema);
      if (body instanceof Response) return body;
      try {
        const env = envFor(request);
        return json({
          search: await searchMemories(database(env), embeddingProvider(env), {
            ...body,
            semanticMaxDistance: semanticMaxDistance(env)
          })
        });
      } catch (error) {
        return safeError(error);
      }
    })
    .post("/api/observations", async ({ request, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, observationSchema);
      if (body instanceof Response) return body;
      try {
        return json(
          await createObservation(
            database(envFor(request)),
            body.statement,
            body.sourceMemoryIds
          ),
          201
        );
      } catch (error) {
        return safeError(error);
      }
    })
    .post("/api/index/rebuild", async ({ request, body: rawBody }) => {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const body = parseBody(rawBody, confirmationSchema);
      if (body instanceof Response) return body;
      try {
        const env = envFor(request);
        return json({ result: await rebuildIndex(database(env), embeddingProvider(env), body.confirm) });
      } catch (error) {
        return safeError(error);
      }
    })
    .all("/api/*", async ({ request }) => {
      const denied = await requireAccess(request);
      return denied ?? json({ error: "not_found" }, 404);
    });
}

function toolResponse(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function toolFailure(error: unknown) {
  const category =
    error instanceof EmbeddingProviderError
      ? "embedding_provider"
      : error instanceof SemanticScanLimitError
        ? error.code
        : error instanceof ForgetPreviewConflictError
          ? error.code
        : "operation";
  console.error("Arra Memory Lab MCP tool failed", {
    category,
    message: error instanceof Error ? error.message : "unknown error"
  });
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          category === "embedding_provider"
            ? "Semantic inference is unavailable. Try keyword mode."
            : category === "semantic_scan_limit"
              ? `Exact semantic recall is capped at ${MAX_SEMANTIC_CHUNKS} current chunks. Try keyword mode.`
              : category === "stale_preview"
                ? "The forget preview is stale. Request a fresh preview before confirming."
            : "The lab could not complete that operation. Check the input and try again."
      }
    ]
  };
}

function createLabMcpServer(env: Env, scopes: ReadonlySet<string>) {
  const server = new McpServer({ name: "Arra Memory Lab", version: LAB_VERSION });
  const db = database(env);
  const provider = embeddingProvider(env);

  server.registerTool(
    "lab_info",
    { description: "Describe this lab's authority, retrieval, failure, and security contracts." },
    async () => toolResponse({ ...info })
  );

  if (scopes.has(WRITE_SCOPE)) server.registerTool(
    "remember",
    {
      description: "Write an authoritative memory, then try to create rebuildable embedding chunks.",
      inputSchema: {
        content: z.string().min(1).max(12_000),
        title: z.string().max(160).optional(),
        kind: memoryKindSchema.optional(),
        tags: z.array(z.string().max(80)).max(10).optional(),
        project: z.string().max(240).optional(),
        sourcePath: z.string().max(500).optional(),
        createdBy: z.string().max(80).optional(),
        oracleName: z.string().max(80).optional(),
        supersedesMemoryId: z.string().min(1).max(128).optional()
      }
    },
    async (input) => {
      try {
        return toolResponse(await createMemory(db, provider, input));
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(READ_SCOPE)) server.registerTool(
    "recall",
    {
      description: "Recall memories by keyword, semantic, or hybrid RRF with explicit rank provenance and fallback.",
      inputSchema: {
        query: z.string().min(1).max(500),
        mode: searchModeSchema.optional(),
        kind: memoryKindSchema.optional(),
        project: z.string().max(240).optional(),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ query, mode, kind, project, limit }) => {
      try {
        return toolResponse(
          await searchMemories(db, provider, {
            query,
            mode: (mode ?? "hybrid") as SearchMode,
            kind: kind as MemoryKind | undefined,
            project,
            limit,
            semanticMaxDistance: semanticMaxDistance(env)
          })
        );
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(WRITE_SCOPE)) server.registerTool(
    "observe",
    {
      description: "Create a derived statement backed by exact source memory IDs, revisions, and hashes.",
      inputSchema: {
        statement: z.string().min(1).max(4_000),
        sourceMemoryIds: z.array(z.string().min(1)).min(1).max(8)
      }
    },
    async ({ statement, sourceMemoryIds }) => {
      try {
        return toolResponse(await createObservation(db, statement, sourceMemoryIds));
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(WRITE_SCOPE)) server.registerTool(
    "forget",
    {
      description: "Preview or confirm deletion of one authoritative memory and report affected derived state.",
      inputSchema: mcpForgetSchema,
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (input) => {
      try {
        const { memoryId, ...confirmation } = input;
        return toolResponse(await forgetMemory(db, memoryId, confirmation));
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(WRITE_SCOPE)) server.registerTool(
    "rebuild_index",
    {
      description: "Preview or confirm a bounded rebuild of missing/stale derived embedding chunks.",
      inputSchema: { confirm: z.boolean().optional() },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async ({ confirm }) => {
      try {
        return toolResponse(await rebuildIndex(db, provider, confirm === true));
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(READ_SCOPE)) server.registerTool(
    "trace_list",
    {
      description: "List up to 50 newest metadata-only search traces with ranked result snapshot links.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true }
    },
    async ({ limit }) => {
      try {
        return toolResponse({ traces: await listSearchTraces(db, limit) });
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(READ_SCOPE)) server.registerTool(
    "trace_get",
    {
      description: "Read one metadata-only search trace and its ranked result snapshots by trace ID.",
      inputSchema: { traceId: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true }
    },
    async ({ traceId }) => {
      try {
        return toolResponse({ trace: await getSearchTrace(db, traceId) });
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  if (scopes.has(READ_SCOPE)) server.registerTool(
    "memory_stats",
    { description: "Return corpus, embedding coverage, observation, trace, and trace-result counts without vectors." },
    async () => {
      try {
        const state = await getLabState(db);
        return toolResponse({ stats: state.stats });
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  return server;
}

const apiApp = createApiApp();

export const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/authorize") return handleAuthorization(request, env);

    requestEnvironments.set(request, env);
    try {
      return await apiApp.handle(request);
    } finally {
      requestEnvironments.delete(request);
    }
  }
};

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
    const token = bearer ? await env.OAUTH_PROVIDER.unwrapToken(bearer) : null;
    if (!token) {
      return json(
        { error: "invalid_token", message: "Send a valid OAuth Bearer token." },
        401,
        { "www-authenticate": 'Bearer realm="Arra Memory Lab", error="invalid_token"' }
      );
    }
    const handler = createMcpHandler(() => createLabMcpServer(env, new Set(token.scope)));
    return handler(request, env, ctx);
  }
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [...MCP_SCOPES],
  allowPlainPKCE: false,
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler
});
