import { describe, expect, mock, test } from "bun:test";
import packageMetadata from "../package.json";
import type { Env } from "./server";
import { LAB_CALVER_PATTERN, LAB_VERSION } from "./version";

mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {}
}));

const {
  constantTimeTextEqual,
  defaultHandler,
  hasStrictS256Pkce,
  handleAuthorization,
  isAuthorized,
  mcpApiHandler
} = await import("./server");

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {}
} as unknown as ExecutionContext;

const dummyDatabase = {} as D1Database;
const defaultOAuth = {
  unwrapToken: async (token: string) => {
    const scope = token === "info-token"
      ? []
      : token === "read-token"
        ? ["memory:read"]
        : token === "correct-token" || token === "full-token"
          ? ["memory:read", "memory:write"]
          : null;
    return scope ? { scope, grant: { clientId: "test-client", scope, props: {} } } : null;
  }
};
function env(input: Partial<Env> = {}): Env {
  return {
    DB: dummyDatabase,
    OAUTH_PROVIDER: defaultOAuth as unknown as Env["OAUTH_PROVIDER"],
    ...input
  } as Env;
}

function mcpRequest(body: unknown, method = "POST", token = "full-token") {
  return new Request("https://lab.example/mcp", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {})
  });
}

async function mcpJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length) ?? text;
  return JSON.parse(data) as T;
}

describe("lab API bearer and MCP OAuth boundaries", () => {
  test("compares tokens without accepting prefixes or suffixes", async () => {
    expect(await constantTimeTextEqual("correct-token", "correct-token")).toBe(true);
    expect(await constantTimeTextEqual("correct-token", "correct-token-extra")).toBe(false);
    expect(await constantTimeTextEqual("correct", "correct-token")).toBe(false);
  });

  test("requires the exact Bearer scheme and configured token", async () => {
    const testEnv = env({ LAB_ACCESS_TOKEN: "correct-token" });
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "Bearer correct-token" }
        }),
        testEnv
      )
    ).toBe(true);
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "bearer correct-token" }
        }),
        testEnv
      )
    ).toBe(false);
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "Bearer wrong-token" }
        }),
        testEnv
      )
    ).toBe(false);
  });

  test("keeps public disclosure content-free and private routes fail closed", async () => {
    const publicResponse = await defaultHandler.fetch(
      new Request("https://lab.example/api/info"),
      env(),
      context
    );
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as Record<string, unknown>;
    expect(publicBody.name).toBe("Arra Memory Lab");
    expect(LAB_VERSION).toBe(packageMetadata.version);
    expect(LAB_VERSION).toMatch(LAB_CALVER_PATTERN);
    expect(publicBody.version).toBe(LAB_VERSION);
    expect(publicBody.versionScheme).toBe("Bangkok CalVer YY.M.D-alpha.HMM");
    expect(publicBody.mcp).toEqual(
      expect.objectContaining({
        sdk: "@modelcontextprotocol/server@2.0.0",
        transport: "stateless Streamable HTTP"
      })
    );
    expect(JSON.stringify(publicBody)).not.toContain("LAB_ACCESS_TOKEN");

    const unconfigured = await defaultHandler.fetch(
      new Request("https://lab.example/api/state"),
      env(),
      context
    );
    expect(unconfigured.status).toBe(503);

    const unknownApiRoute = await defaultHandler.fetch(
      new Request("https://lab.example/api/unknown"),
      env({ LAB_ACCESS_TOKEN: "correct-token" }),
      context
    );
    expect(unknownApiRoute.status).toBe(401);
  });

  test("serves independent legacy MCP requests without a session identifier", async () => {
    const testEnv = env();
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stateless-regression", version: "1.0.0" }
      }
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await mcpApiHandler.fetch(mcpRequest(initialize), testEnv, context);
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      const body = await mcpJson<{
        result: { protocolVersion: string; serverInfo: { version: string } };
      }>(response);
      expect(body.result.protocolVersion).toBe("2025-06-18");
      expect(body.result.serverInfo.version).toBe(LAB_VERSION);
    }

    const tools = await mcpApiHandler.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      testEnv,
      context
    );
    expect(tools.status).toBe(200);
    expect(tools.headers.get("mcp-session-id")).toBeNull();
    const toolsBody = await mcpJson<{
      result: { tools: Array<{ name: string }> };
    }>(tools);
    expect(toolsBody.result.tools.map(({ name }) => name).sort()).toEqual([
      "forget",
      "lab_info",
      "memory_stats",
      "observe",
      "rebuild_index",
      "recall",
      "remember",
      "trace_get",
      "trace_list"
    ]);

    const labInfo = await mcpApiHandler.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "lab_info", arguments: {} }
      }),
      testEnv,
      context
    );
    expect(labInfo.status).toBe(200);
    const labInfoBody = await mcpJson<{
      result: { structuredContent: { version: string; versionScheme: string } };
    }>(labInfo);
    expect(labInfoBody.result.structuredContent.version).toBe(LAB_VERSION);
    expect(labInfoBody.result.structuredContent.versionScheme).toBe(
      "Bangkok CalVer YY.M.D-alpha.HMM"
    );

    for (const method of ["GET", "DELETE"]) {
      const response = await mcpApiHandler.fetch(mcpRequest({}, method), testEnv, context);
      expect(response.status).toBe(405);
      expect(response.headers.get("mcp-session-id")).toBeNull();
    }
  });

  test("registers MCP tools from the unwrapped OAuth token scopes", async () => {
    const testEnv = env();
    const listRequest = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    const infoOnlyResponse = await mcpApiHandler.fetch(
      mcpRequest(listRequest, "POST", "info-token"),
      testEnv,
      context
    );
    const infoOnlyBody = await mcpJson<{
      result: { tools: Array<{ name: string }> };
    }>(infoOnlyResponse);
    expect(infoOnlyBody.result.tools.map(({ name }) => name)).toEqual(["lab_info"]);

    const readOnlyResponse = await mcpApiHandler.fetch(
      mcpRequest(listRequest, "POST", "read-token"),
      testEnv,
      context
    );
    const readOnlyBody = await mcpJson<{
      result: { tools: Array<{ name: string }> };
    }>(readOnlyResponse);
    expect(readOnlyBody.result.tools.map(({ name }) => name).sort()).toEqual([
      "lab_info",
      "memory_stats",
      "recall",
      "trace_get",
      "trace_list"
    ]);

    const forbiddenCall = await mcpApiHandler.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "remember", arguments: { content: "must not run" } }
      }, "POST", "read-token"),
      testEnv,
      context
    );
    const forbiddenBody = await mcpJson<{
      result?: unknown;
      error?: { code: number; message: string };
    }>(forbiddenCall);
    expect(forbiddenBody.result).toBeUndefined();
    expect(forbiddenBody.error?.message).toContain("remember");

    const fullResponse = await mcpApiHandler.fetch(
      mcpRequest(listRequest, "POST", "full-token"),
      testEnv,
      context
    );
    const fullBody = await mcpJson<{
      result: { tools: Array<{ name: string }> };
    }>(fullResponse);
    expect(fullBody.result.tools.map(({ name }) => name).sort()).toEqual([
      "forget",
      "lab_info",
      "memory_stats",
      "observe",
      "rebuild_index",
      "recall",
      "remember",
      "trace_get",
      "trace_list"
    ]);

    const invalid = await mcpApiHandler.fetch(
      mcpRequest(listRequest, "POST", "invalid-token"),
      testEnv,
      context
    );
    expect(invalid.status).toBe(401);
  });

  test("validates Elysia's parsed JSON body without rereading the consumed stream", async () => {
    const response = await defaultHandler.fetch(
      new Request("https://lab.example/api/search", {
        method: "POST",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ mode: "keyword" })
      }),
      env({ LAB_ACCESS_TOKEN: "correct-token" }),
      context
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.some((issue) => issue.path === "query")).toBe(true);

    const unsafeForget = await defaultHandler.fetch(
      new Request("https://lab.example/api/memories/demo/forget", {
        method: "POST",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ confirm: true })
      }),
      env({ LAB_ACCESS_TOKEN: "correct-token" }),
      context
    );
    expect(unsafeForget.status).toBe(400);

    const mutableSupersession = await defaultHandler.fetch(
      new Request("https://lab.example/api/memories/demo", {
        method: "PATCH",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ supersedesMemoryId: "other" })
      }),
      env({ LAB_ACCESS_TOKEN: "correct-token" }),
      context
    );
    expect(mutableSupersession.status).toBe(400);
  });

  test("uses the owner secret only on the OAuth approval page", async () => {
    const challenge = "a".repeat(43);
    const oauthRequest = {
      responseType: "code",
      clientId: "claude-client",
      redirectUri: "https://claude.ai/api/mcp/auth_callback?source=lab&mode=oauth",
      scope: ["memory:read", "memory:write"],
      state: "client-state",
      codeChallenge: challenge,
      codeChallengeMethod: "S256"
    };
    let completed = 0;
    const oauth = {
      parseAuthRequest: async (request: Request) => {
        const redirectUri = new URL(request.url).searchParams.get("redirect_uri");
        if (redirectUri && redirectUri !== oauthRequest.redirectUri) {
          throw new Error("redirect_uri mismatch");
        }
        return oauthRequest;
      },
      lookupClient: async () => ({
        clientId: "claude-client",
        clientName: "Claude",
        redirectUris: [oauthRequest.redirectUri]
      }),
      completeAuthorization: async ({ request }: { request: { redirectUri: string } }) => {
        if (request.redirectUri !== oauthRequest.redirectUri) {
          throw new Error("redirect_uri mismatch");
        }
        completed += 1;
        return { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=ok" };
      }
    };
    const testEnv = env({ LAB_ACCESS_TOKEN: "correct-token", OAUTH_PROVIDER: oauth as unknown as Env["OAUTH_PROVIDER"] });
    const page = await handleAuthorization(new Request("https://lab.example/authorize"), testEnv);
    expect(page.status).toBe(200);
    const policy = page.headers.get("content-security-policy");
    expect(policy).not.toContain("form-action");
    expect(policy).toContain("base-uri 'none'");
    const pageBody = await page.text();
    expect(pageBody).toContain("Connect Claude");
    expect(pageBody).toContain('<form method="post" action="/authorize">');
    expect(pageBody).toContain("https://claude.ai/api/mcp/auth_callback?source=lab&amp;mode=oauth");
    expect(pageBody).toContain("<code>memory:read</code>");
    expect(pageBody).toContain("<code>memory:write</code>");

    const state = btoa(JSON.stringify(oauthRequest));
    const denied = await handleAuthorization(new Request("https://lab.example/authorize", {
      method: "POST",
      body: new URLSearchParams({ state, passphrase: "wrong" })
    }), testEnv);
    expect(denied.status).toBe(403);

    const tamperedState = btoa(JSON.stringify({
      ...oauthRequest,
      redirectUri: "https://attacker.example/callback"
    }));
    const tampered = await handleAuthorization(new Request("https://lab.example/authorize", {
      method: "POST",
      body: new URLSearchParams({ state: tamperedState, passphrase: "correct-token" })
    }), testEnv);
    expect(tampered.status).toBe(400);
    expect(completed).toBe(0);

    const accepted = await handleAuthorization(new Request("https://lab.example/authorize", {
      method: "POST",
      body: new URLSearchParams({ state, passphrase: "correct-token" })
    }), testEnv);
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toContain("claude.ai/api/mcp/auth_callback");
    expect(completed).toBe(1);
  });

  test("reports OAuth provider failure as retryable without redirecting", async () => {
    const oauthRequest = {
      responseType: "code",
      clientId: "failure-client",
      redirectUri: "https://client.example/callback",
      scope: ["memory:read"],
      state: "failure-state",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256"
    };
    const oauth = {
      parseAuthRequest: async () => oauthRequest,
      lookupClient: async () => ({ clientId: oauthRequest.clientId, clientName: "Failure client" }),
      completeAuthorization: async () => {
        throw new Error("simulated KV outage");
      }
    };
    const log = mock(() => {});
    const previous = console.error;
    console.error = log;
    try {
      const response = await handleAuthorization(
        new Request("https://lab.example/authorize", {
          method: "POST",
          body: new URLSearchParams({
            state: btoa(JSON.stringify(oauthRequest)),
            passphrase: "correct-token"
          })
        }),
        env({ LAB_ACCESS_TOKEN: "correct-token", OAUTH_PROVIDER: oauth as unknown as Env["OAUTH_PROVIDER"] })
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toContain("temporarily unavailable");
      expect(log).toHaveBeenCalledWith(
        "Arra Memory Lab OAuth completion failed",
        { category: "oauth_provider", errorType: "Error" }
      );
    } finally {
      console.error = previous;
    }
  });

  test("rejects empty and unsupported OAuth scopes before consent", async () => {
    const challenge = "a".repeat(43);
    for (const scope of [[], ["memory:admin"]]) {
      const oauth = {
        parseAuthRequest: async () => ({
          responseType: "code",
          clientId: "scope-client",
          redirectUri: "https://client.example/callback",
          scope,
          state: "scope-state",
          codeChallenge: challenge,
          codeChallengeMethod: "S256"
        }),
        lookupClient: async () => ({ clientId: "scope-client", clientName: "Scope client" })
      };
      const response = await handleAuthorization(
        new Request("https://lab.example/authorize"),
        env({ LAB_ACCESS_TOKEN: "correct-token", OAUTH_PROVIDER: oauth as unknown as Env["OAUTH_PROVIDER"] })
      );
      expect(response.status).toBe(400);
    }
  });

  test("rejects authorization unless PKCE is present and strictly S256", async () => {
    const valid = {
      responseType: "code",
      clientId: "claude-client",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scope: ["memory:read"],
      state: "client-state",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256"
    };
    expect(hasStrictS256Pkce(valid)).toBe(true);
    expect(hasStrictS256Pkce({ ...valid, codeChallenge: undefined })).toBe(false);
    expect(hasStrictS256Pkce({ ...valid, codeChallengeMethod: "plain" })).toBe(false);
    expect(hasStrictS256Pkce({ ...valid, codeChallenge: "short" })).toBe(false);

    let completed = 0;
    const oauth = {
      parseAuthRequest: async () => ({ ...valid, codeChallenge: undefined }),
      lookupClient: async () => ({
        clientId: "claude-client",
        clientName: "Claude",
        redirectUris: [valid.redirectUri]
      }),
      completeAuthorization: async () => {
        completed += 1;
        return { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=ok" };
      }
    };
    const testEnv = env({ LAB_ACCESS_TOKEN: "correct-token", OAUTH_PROVIDER: oauth as unknown as Env["OAUTH_PROVIDER"] });

    const missingOnGet = await handleAuthorization(new Request("https://lab.example/authorize"), testEnv);
    expect(missingOnGet.status).toBe(400);

    const missingOnPost = await handleAuthorization(new Request("https://lab.example/authorize", {
      method: "POST",
      body: new URLSearchParams({
        state: btoa(JSON.stringify({ ...valid, codeChallenge: undefined })),
        passphrase: "correct-token"
      })
    }), testEnv);
    expect(missingOnPost.status).toBe(400);
    expect(completed).toBe(0);
  });
});
