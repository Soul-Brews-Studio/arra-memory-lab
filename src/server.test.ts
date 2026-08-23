import { describe, expect, test } from "bun:test";
import worker, { constantTimeTextEqual, isAuthorized, type Env } from "./server";

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {}
} as unknown as ExecutionContext;

const dummyDatabase = {} as D1Database;

describe("lab bearer boundary", () => {
  test("compares tokens without accepting prefixes or suffixes", async () => {
    expect(await constantTimeTextEqual("correct-token", "correct-token")).toBe(true);
    expect(await constantTimeTextEqual("correct-token", "correct-token-extra")).toBe(false);
    expect(await constantTimeTextEqual("correct", "correct-token")).toBe(false);
  });

  test("requires the exact Bearer scheme and configured token", async () => {
    const env: Env = { DB: dummyDatabase, LAB_ACCESS_TOKEN: "correct-token" };
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "Bearer correct-token" }
        }),
        env
      )
    ).toBe(true);
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "bearer correct-token" }
        }),
        env
      )
    ).toBe(false);
    expect(
      await isAuthorized(
        new Request("https://lab.example/api/state", {
          headers: { authorization: "Bearer wrong-token" }
        }),
        env
      )
    ).toBe(false);
  });

  test("keeps public disclosure content-free and private routes fail closed", async () => {
    const publicResponse = await worker.fetch(
      new Request("https://lab.example/api/info"),
      { DB: dummyDatabase },
      context
    );
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as Record<string, unknown>;
    expect(publicBody.name).toBe("Arra Memory Lab");
    expect(JSON.stringify(publicBody)).not.toContain("LAB_ACCESS_TOKEN");

    const unconfigured = await worker.fetch(
      new Request("https://lab.example/api/state"),
      { DB: dummyDatabase },
      context
    );
    expect(unconfigured.status).toBe(503);

    const denied = await worker.fetch(
      new Request("https://lab.example/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong" }
      }),
      { DB: dummyDatabase, LAB_ACCESS_TOKEN: "correct-token" },
      context
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");

    const unknownApiRoute = await worker.fetch(
      new Request("https://lab.example/api/unknown"),
      { DB: dummyDatabase, LAB_ACCESS_TOKEN: "correct-token" },
      context
    );
    expect(unknownApiRoute.status).toBe(401);
  });

  test("validates Elysia's parsed JSON body without rereading the consumed stream", async () => {
    const response = await worker.fetch(
      new Request("https://lab.example/api/search", {
        method: "POST",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ mode: "keyword" })
      }),
      { DB: dummyDatabase, LAB_ACCESS_TOKEN: "correct-token" },
      context
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.some((issue) => issue.path === "query")).toBe(true);

    const unsafeForget = await worker.fetch(
      new Request("https://lab.example/api/memories/demo/forget", {
        method: "POST",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ confirm: true })
      }),
      { DB: dummyDatabase, LAB_ACCESS_TOKEN: "correct-token" },
      context
    );
    expect(unsafeForget.status).toBe(400);
  });
});
