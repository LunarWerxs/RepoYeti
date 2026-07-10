/**
 * Route tests for src/http/routes/sync.ts — the "/api/settings/sync" HTTP surface fronting
 * src/connections-sync.ts. Uses a temp REPOYETI_HOME + in-memory keychain (tests/api-token.test.ts
 * pattern) and a mocked global fetch for the OIDC + studio.connections.icu calls — never the real
 * Connections service.
 *
 * Covers:
 *  - no-OIDC-configured daemon (authEnforced=false): GET returns a flat disabled/disconnected
 *    status; PUT/pull/push 404 ("sign-in is not configured")
 *  - OIDC-configured but signed OUT of Connections (no refresh/access token): GET reports
 *    connected:false; PUT enable/pull/push surface not_signed_in as a handled 200 { ok:false }
 *  - OIDC-configured and signed IN to Connections: enable / push / pull / disable round-trip
 *    through the real HTTP routes
 *  - error paths: a locker HTTP failure surfaces as a handled `{ ok:false, error }` (never a 500)
 */
import { test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { clearTokens, rememberTokens } from "../src/connections-sync.ts";
import type { RepoYetiConfig, OAuthConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME + in-memory keychain ──────────────────────────────────────────────
const TEST_HOME = join(tmpdir(), `repoyeti-sync-routes-test-${process.pid}`);
const ORIG_HOME = process.env.REPOYETI_HOME;
const ORIG_MEM = process.env.REPOYETI_KEYCHAIN_MEMORY;
const ORIG_SVC = process.env.REPOYETI_KEYCHAIN_SERVICE;

beforeAll(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.REPOYETI_HOME = TEST_HOME;
  process.env.REPOYETI_KEYCHAIN_MEMORY = "1";
  process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-sync-routes-test-${process.pid}`;
});

afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.REPOYETI_HOME;
  else process.env.REPOYETI_HOME = ORIG_HOME;
  if (ORIG_MEM === undefined) delete process.env.REPOYETI_KEYCHAIN_MEMORY;
  else process.env.REPOYETI_KEYCHAIN_MEMORY = ORIG_MEM;
  if (ORIG_SVC === undefined) delete process.env.REPOYETI_KEYCHAIN_SERVICE;
  else process.env.REPOYETI_KEYCHAIN_SERVICE = ORIG_SVC;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const ISSUER = "https://accounts.connections.icu";
const CLIENT_ID = "test-sync-routes-client";
const OAUTH: OAuthConfig = { issuer: ISSUER, clientId: CLIENT_ID, redirectUri: "https://example.com/cb" };
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const STORE_BASE = "https://studio.connections.icu";
const DOC_URL = `${STORE_BASE}/v1/app-data/${encodeURIComponent(CLIENT_ID)}`;

/** No OIDC at all — authEnforced() is false, so the daemon is local-open (bare test config). */
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
/** OIDC configured (Connections sign-in possible) — authEnforced() is true. */
const oidcCfg = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  oauth: { ...OAUTH },
  ...extra,
});

class FakeConnectionsServer {
  version = 0;
  settings: Record<string, unknown> = {};
  failDocWith: number | null = null;

  fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === DISCOVERY_URL) {
      return new Response(JSON.stringify({ issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === TOKEN_ENDPOINT && method === "POST") {
      return new Response(JSON.stringify({ access_token: "access-token-1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === DOC_URL) {
      if (this.failDocWith) return new Response(JSON.stringify({ error: "server_error" }), { status: this.failDocWith });
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            app_id: CLIENT_ID,
            settings: this.settings,
            server_settings: {},
            version: this.version,
            updated_at: this.version ? new Date().toISOString() : null,
            bytes_used: 0,
            max_bytes: 65536,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST") {
        const req = JSON.parse(String(init?.body ?? "{}")) as {
          settings: Record<string, unknown>;
          baseVersion: number;
          merge?: boolean;
        };
        if (req.baseVersion !== this.version) {
          return new Response(
            JSON.stringify({ error: "version_conflict", current: { settings: this.settings, version: this.version } }),
            { status: 409 },
          );
        }
        this.settings = req.merge ? { ...this.settings, ...req.settings } : req.settings;
        this.version += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (method === "DELETE") {
        this.settings = {};
        this.version = 0;
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`[test] unexpected fetch to ${method} ${url} — seam leak`);
  };
}

let server: FakeConnectionsServer;
let origFetch: typeof fetch;

beforeEach(async () => {
  server = new FakeConnectionsServer();
  origFetch = globalThis.fetch;
  globalThis.fetch = server.fetchImpl as unknown as typeof fetch;
  await clearTokens();
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await clearTokens();
});

// ── no OIDC configured at all ────────────────────────────────────────────────────────────

test("GET /api/settings/sync with no OIDC client returns a flat disabled/disconnected status", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/settings/sync");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    enabled: false,
    connected: false,
    lastSyncedAt: null,
    version: 0,
    appearance: null,
  });
});

test("PUT /api/settings/sync with no OIDC client 404s (sign-in not configured)", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(404);
});

test("POST /api/settings/sync/pull and /push with no OIDC client both 404", async () => {
  const app = createApp(localCfg());
  const pull = await app.request("/api/settings/sync/pull", { method: "POST" });
  const push = await app.request("/api/settings/sync/push", { method: "POST" });
  expect(pull.status).toBe(404);
  expect(push.status).toBe(404);
});

// ── OIDC configured, but signed OUT of Connections ──────────────────────────────────────

test("GET /api/settings/sync when OIDC-configured but signed out reports connected:false", async () => {
  const app = createApp(oidcCfg());
  const res = await app.request("/api/settings/sync");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, enabled: false, connected: false, lastSyncedAt: null, version: 0, appearance: null });
});

test("PUT /api/settings/sync {enabled:true} while signed out enables locally with no network call", async () => {
  const app = createApp(oidcCfg());
  const res = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.enabled).toBe(true);
  expect(body.connected).toBe(false);
});

test("POST /api/settings/sync/push while signed out surfaces not_signed_in as a handled 200", async () => {
  const app = createApp(oidcCfg());
  const res = await app.request("/api/settings/sync/push", { method: "POST" });
  expect(res.status).toBe(200); // never a 500 — guard() translates the throw
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("not_signed_in");
});

test("POST /api/settings/sync/pull while signed out surfaces not_signed_in as a handled 200", async () => {
  const app = createApp(oidcCfg());
  const res = await app.request("/api/settings/sync/pull", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("not_signed_in");
});

// ── OIDC configured AND signed in to Connections ────────────────────────────────────────

test("enable → push → pull → disable round-trips through the real HTTP routes while signed in", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  const app = createApp(oidcCfg());

  // Enable: remote is empty, so it seeds from local cfg (no prefs set → empty prefs object).
  const enableRes = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, appearance: { theme: "dark" } }),
  });
  expect(enableRes.status).toBe(200);
  const enableBody = await enableRes.json();
  expect(enableBody.ok).toBe(true);
  expect(enableBody.enabled).toBe(true);
  expect(enableBody.connected).toBe(true);
  expect(enableBody.appearance).toEqual({ theme: "dark" });

  // Manual push: succeeds, returns fresh status.
  const pushRes = await app.request("/api/settings/sync/push", { method: "POST" });
  expect(pushRes.status).toBe(200);
  const pushBody = await pushRes.json();
  expect(pushBody.ok).toBe(true);

  // Manual pull: succeeds (applies the doc we just pushed, which is a no-op vs local state).
  const pullRes = await app.request("/api/settings/sync/pull", { method: "POST" });
  expect(pullRes.status).toBe(200);
  expect((await pullRes.json()).ok).toBe(true);

  // Disable (no forget): turns off, connection stays.
  const disableRes = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(disableRes.status).toBe(200);
  const disableBody = await disableRes.json();
  expect(disableBody.enabled).toBe(false);
  expect(disableBody.connected).toBe(true);
});

test("PUT /api/settings/sync {appearance} alone updates+pushes the appearance when enabled+connected", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  const app = createApp(oidcCfg({ cloudSync: { enabled: true } }));

  const res = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appearance: { theme: "light" } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.appearance).toEqual({ theme: "light" });
  expect(server.settings.appearance).toEqual({ theme: "light" });
});

test("PUT /api/settings/sync {enabled:false, forget:true} disconnects and wipes the remote doc", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  const app = createApp(oidcCfg({ cloudSync: { enabled: true, version: 1 } }));

  const res = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, forget: true }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.enabled).toBe(false);
  expect(body.connected).toBe(false); // token cleared

  const status = await app.request("/api/settings/sync");
  expect((await status.json()).connected).toBe(false);
});

// ── error paths ──────────────────────────────────────────────────────────────────────────

test("a locker HTTP failure on push surfaces as a handled { ok:false } — never a 500", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  server.failDocWith = 500;
  const app = createApp(oidcCfg());

  const res = await app.request("/api/settings/sync/push", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe("string");
});

test("a rate-limited (429) locker failure surfaces retryAfterSeconds when present", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  const app = createApp(oidcCfg());
  // Override just the doc endpoint to return 429 with retry_after_seconds, keeping discovery/token intact.
  const base = server.fetchImpl;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DOC_URL) {
      return new Response(JSON.stringify({ error: "rate_limited", retry_after_seconds: 30 }), { status: 429 });
    }
    return base(input, init);
  }) as unknown as typeof fetch;

  const res = await app.request("/api/settings/sync/pull", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.retryAfterSeconds).toBe(30);
});

test("malformed JSON body on PUT /api/settings/sync is tolerated (falls back to {} — no 500)", async () => {
  await rememberTokens({ refresh_token: "rt-1" }, OAUTH);
  const app = createApp(oidcCfg());
  const res = await app.request("/api/settings/sync", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true); // no enabled/appearance in the (empty) body → just returns status
});
