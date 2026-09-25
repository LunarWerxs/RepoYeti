// Pins the test-mode response contract check (src/http/response-check.ts): a handler whose real JSON
// answer no longer matches the response schema /api/openapi.json declares for it must fail loudly,
// naming the route and the field, and only while REPOYETI_RESPONSE_CHECK=1 (tests/setup.ts sets it).
import { test, expect } from "bun:test";
import { z } from "zod";
import { createApp } from "../src/http/app.ts";
import { META } from "../src/http/openapi.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// GET /api/scan answers { ok: true, running } with no git or disk work, so it is a cheap route to
// point a deliberately wrong declaration at. The declaration is restored whatever the outcome.
const ROUTE = "GET /api/scan";
const DRIFTED = z.looseObject({ ok: z.literal(true), scopeLabel: z.string() });

async function withDriftedDeclaration<T>(run: () => T | Promise<T>): Promise<T> {
  const original = META[ROUTE]!;
  META[ROUTE] = { ...original, response: DRIFTED };
  try {
    return await run();
  } finally {
    META[ROUTE] = original;
  }
}

test("a response that drifts from its declared schema becomes a 500 naming the route and field", async () => {
  expect(process.env.REPOYETI_RESPONSE_CHECK).toBe("1");
  const res = await withDriftedDeclaration(() => createApp(localCfg()).request("/api/scan"));
  expect(res.status).toBe(500);
  const body = (await res.json()) as { ok: boolean; code: string; message: string };
  expect(body.ok).toBe(false);
  expect(body.code).toBe("ERROR");
  expect(body.message).toContain("GET /api/scan");
  expect(body.message).toContain("scopeLabel");
});

test("the check costs nothing outside test mode: without the flag the drifted answer goes out as-is", async () => {
  const saved = process.env.REPOYETI_RESPONSE_CHECK;
  delete process.env.REPOYETI_RESPONSE_CHECK;
  try {
    const res = await withDriftedDeclaration(() => createApp(localCfg()).request("/api/scan"));
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { running: unknown }).running).toBe("boolean");
  } finally {
    process.env.REPOYETI_RESPONSE_CHECK = saved;
  }
});

test("the declared response schema is what /api/openapi.json publishes for the route", async () => {
  const res = await createApp(localCfg()).request("/api/openapi.json");
  const doc = (await res.json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { required?: string[] } }> }> }>>;
  };
  const schema = doc.paths["/api/health"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  expect(schema?.required).toEqual(expect.arrayContaining(["ok", "service", "version", "ts"]));
});
