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
  getLabState,
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

export interface Env {
  DB: D1Database;
  AI?: WorkersAiBinding;
  LAB_ACCESS_TOKEN?: string;
  SEMANTIC_MAX_DISTANCE?: string;
}

const VERSION = "1.0.0";
const requestEnvironments = new WeakMap<Request, Env>();
const memoryKindSchema = z.enum(MEMORY_KINDS);
const searchModeSchema = z.enum(SEARCH_MODES);

const createMemorySchema = z
  .object({
    title: z.string().max(160).optional(),
    content: z.string().min(1).max(12_000),
    kind: memoryKindSchema.optional(),
    tags: z.array(z.string().max(80)).max(10).optional()
  })
  .strict();

const updateMemorySchema = createMemorySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required"
  });

const searchSchema = z
  .object({
    query: z.string().min(1).max(500),
    mode: searchModeSchema.default("hybrid"),
    kind: memoryKindSchema.optional(),
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
  version: VERSION,
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
      "memory_stats"
    ]
  },
  authority: {
    source: "memories",
    derived: ["memory_chunks", "observations", "observation_sources"],
    operational: "search_traces"
  },
  guarantees: [
    "vectors are never authoritative",
    "hybrid fallback is explicit",
    "observation evidence retains source revision and hash",
    "forget and rebuild preview before mutation",
    "search traces never store raw query or memory content"
  ],
  security: {
    mode: "single bearer token",
    processing: "Create/rebuild sends memory chunks to Workers AI; semantic/hybrid recall sends query text. Keyword recall and previews do not call AI.",
    warning: "Lab only: no OAuth, tenant isolation, rate limiting, or public-write safety controls."
  }
} as const;

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

function createLabMcpServer(env: Env) {
  const server = new McpServer({ name: "Arra Memory Lab", version: VERSION });
  const db = database(env);
  const provider = embeddingProvider(env);

  server.registerTool(
    "lab_info",
    { description: "Describe this lab's authority, retrieval, failure, and security contracts." },
    async () => toolResponse({ ...info })
  );

  server.registerTool(
    "remember",
    {
      description: "Write an authoritative memory, then try to create rebuildable embedding chunks.",
      inputSchema: {
        content: z.string().min(1).max(12_000),
        title: z.string().max(160).optional(),
        kind: memoryKindSchema.optional(),
        tags: z.array(z.string().max(80)).max(10).optional()
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

  server.registerTool(
    "recall",
    {
      description: "Recall memories by keyword, semantic, or hybrid RRF with explicit rank provenance and fallback.",
      inputSchema: {
        query: z.string().min(1).max(500),
        mode: searchModeSchema.optional(),
        kind: memoryKindSchema.optional(),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ query, mode, kind, limit }) => {
      try {
        return toolResponse(
          await searchMemories(db, provider, {
            query,
            mode: (mode ?? "hybrid") as SearchMode,
            kind: kind as MemoryKind | undefined,
            limit,
            semanticMaxDistance: semanticMaxDistance(env)
          })
        );
      } catch (error) {
        return toolFailure(error);
      }
    }
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "memory_stats",
    { description: "Return corpus, embedding coverage, observation, and trace metadata without vectors." },
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp" || pathname === "/mcp/") {
      if (!env.LAB_ACCESS_TOKEN?.trim()) {
        return json({ error: "lab_not_configured" }, 503);
      }
      if (!(await isAuthorized(request, env))) {
        return json(
          { error: "unauthorized" },
          401,
          { "www-authenticate": 'Bearer realm="Arra Memory Lab"' }
        );
      }
      const handler = createMcpHandler(() => createLabMcpServer(env));
      return handler(request, env, ctx);
    }

    requestEnvironments.set(request, env);
    try {
      return await apiApp.handle(request);
    } finally {
      requestEnvironments.delete(request);
    }
  }
};
