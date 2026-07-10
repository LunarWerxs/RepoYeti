import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// Local mode (no OIDC) → /api/* is not gated, so the spec is reachable directly.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// Remote mode WITH an OIDC owner → auth is enforced on /api/* (mirrors auth.test.ts).
const enforcedCfg = (): RepoYetiConfig => ({
  ...localCfg(),
  mode: "remote",
  oauth: {
    issuer: "https://accounts.connections.icu",
    clientId: "cid",
    redirectUri: "https://repoyeti-auth.example.workers.dev/cb",
    ownerSub: "owner-1",
  },
});

// A request over the tunnel — carries a header true-localhost never has (see auth.ts).
const REMOTE = { headers: { "cf-connecting-ip": "203.0.113.7" } };

/** Hono path (`:id`) → OpenAPI template (`{id}`), matching openapi.ts's converter. */
const toOpenApiPath = (p: string): string => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

test("GET /api/openapi.json returns a valid OpenAPI 3.1 document", async () => {
  const res = await createApp(localCfg()).request("/api/openapi.json");
  expect(res.status).toBe(200);
  const doc = await res.json();
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.info).toBeDefined();
  expect(doc.info.title).toBe("RepoYeti API");
  expect(typeof doc.info.version).toBe("string");
  expect(doc.paths).toBeDefined();
  expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  // Reusable error envelope is present + referenced.
  expect(doc.components.schemas.ErrorResponse).toBeDefined();
});

test("DRIFT GUARD: every real /api/* route appears in the spec's paths", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/openapi.json");
  const doc = await res.json();

  const missing: string[] = [];
  for (const r of app.routes) {
    if (r.method === "ALL") continue; // middleware
    if (!r.path.startsWith("/api/")) continue; // /oauth/* + static are out of scope for this guard
    if (r.path === "/api/events") continue; // SSE stream — documented but excluded from the guard
    if (r.path === "/*" || r.path === "*") continue;
    const openApiPath = toOpenApiPath(r.path);
    const verb = r.method.toLowerCase();
    const entry = doc.paths[openApiPath];
    if (!entry?.[verb]) missing.push(`${r.method} ${r.path}`);
  }
  expect(missing).toEqual([]);
});

test("spot-check: POST /api/repos/:id/commit documents a body with a `message` property", async () => {
  const res = await createApp(localCfg()).request("/api/openapi.json");
  const doc = await res.json();
  const op = doc.paths["/api/repos/{id}/commit"]?.post;
  expect(op).toBeDefined();
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  expect(schema.properties?.message).toBeDefined();
});

test("POST /api/shutdown acknowledges before invoking the daemon cleanup hook", async () => {
  let called = false;
  const app = createApp(localCfg(), { requestShutdown: () => { called = true; } });
  const res = await app.request("/api/shutdown", { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(called).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(called).toBe(true);
});

test("the spec is reachable WITHOUT auth even when auth is enforced", async () => {
  const app = createApp(enforcedCfg());
  // A normal /api/* route is gated over the tunnel (401)…
  const gated = await app.request("/api/repos", REMOTE);
  expect(gated.status).toBe(401);
  // …but the spec is in the public allowlist, so it still returns 200 over the tunnel.
  const spec = await app.request("/api/openapi.json", REMOTE);
  expect(spec.status).toBe(200);
  expect((await spec.json()).openapi).toBe("3.1.0");
});
