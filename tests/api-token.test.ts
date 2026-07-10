/**
 * Tests for the OPTIONAL, off-by-default API Bearer token.
 *
 * CRITICAL INVARIANT proven here: when `cfg.apiToken` is UNSET, auth behaves EXACTLY as today
 * (OIDC-only) — a remote request with ANY/no Bearer is still 401, and a valid OIDC session still
 * works. When SET, a request carrying the right `Authorization: Bearer <token>` passes the gate
 * (and a wrong/absent one does not). Plus: the mint/status/revoke routes round-trip correctly.
 *
 * Uses an in-memory keychain (REPOYETI_KEYCHAIN_MEMORY) + a temp REPOYETI_HOME so the real
 * ~/.repoyeti store and OS credential store are never touched. createApp() + the cf-connecting-ip
 * header simulate a request arriving over the tunnel (see auth.ts isRemoteRequest / openapi.test).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { authMiddleware, sign } from "../src/auth.ts";
import type { OAuthConfig, RepoYetiConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME + in-memory keychain so nothing real is touched ───────────────
const TEST_HOME = join(tmpdir(), `repoyeti-api-token-test-${process.pid}`);
const ORIG_HOME = process.env.REPOYETI_HOME;
const ORIG_MEM = process.env.REPOYETI_KEYCHAIN_MEMORY;
const ORIG_SVC = process.env.REPOYETI_KEYCHAIN_SERVICE;

beforeAll(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.REPOYETI_HOME = TEST_HOME;
  process.env.REPOYETI_KEYCHAIN_MEMORY = "1"; // process-local store — no OS credential service
  process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-api-token-test-${process.pid}`;
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

// ── Fixtures ──────────────────────────────────────────────────────────────────────
const OWNER_OAUTH: OAuthConfig = {
  issuer: "https://accounts.connections.icu",
  clientId: "test-client",
  redirectUri: "https://example.com/cb",
  ownerSub: "owner-sub-123",
  ownerEmail: "owner@example.com",
};

/** A remote-mode, auth-enforced config (auth.test.ts mirrors this shape). */
const enforcedCfg = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "remote",
  oauth: { ...OWNER_OAUTH },
  ...extra,
});

/** A request over the tunnel — carries a header true-localhost never has. */
const REMOTE = { headers: { "cf-connecting-ip": "203.0.113.7" } };

/** A valid signed owner session cookie (bypasses the OIDC HTTP dance). */
function ownerSessionCookie(): string {
  return sign(
    JSON.stringify({ sub: "owner-sub-123", email: "owner@example.com", exp: Date.now() + 60_000 }),
  );
}

// ── UNSET ⇒ zero behavior change (OIDC-only) ─────────────────────────────────────────

test("UNSET: remote GET /api/repos with NO Bearer → 401 (behavior unchanged)", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/repos", REMOTE);
  expect(res.status).toBe(401);
});

test("UNSET: remote GET /api/repos with ANY Bearer → still 401 (token never matches)", async () => {
  const app = createApp(enforcedCfg());
  const res = await app.request("/api/repos", {
    headers: { ...REMOTE.headers, authorization: "Bearer anything-at-all" },
  });
  expect(res.status).toBe(401);
});

test("UNSET: remote GET /api/repos with a valid OIDC session still works (NOT 401)", async () => {
  // Minimal Hono with just the gate + a stub route — proves the session path is unaffected.
  const cfg = enforcedCfg();
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  const res = await app.request("/api/repos", {
    headers: { ...REMOTE.headers, cookie: `gm_session=${ownerSessionCookie()}` },
  });
  expect(res.status).toBe(200);
});

// ── SET ⇒ a valid Bearer passes the gate ─────────────────────────────────────────────

test("SET: remote GET /api/repos with the right Bearer → NOT 401 (passes the gate)", async () => {
  const cfg = enforcedCfg({ apiToken: "secret123" });
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  const res = await app.request("/api/repos", {
    headers: { ...REMOTE.headers, authorization: "Bearer secret123" },
  });
  expect(res.status).toBe(200);
});

test("SET: remote GET /api/repos with the WRONG Bearer → 401", async () => {
  const cfg = enforcedCfg({ apiToken: "secret123" });
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  const res = await app.request("/api/repos", {
    headers: { ...REMOTE.headers, authorization: "Bearer wrong" },
  });
  expect(res.status).toBe(401);
});

test("SET: remote GET /api/repos with NO Authorization header → 401", async () => {
  const cfg = enforcedCfg({ apiToken: "secret123" });
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  const res = await app.request("/api/repos", REMOTE);
  expect(res.status).toBe(401);
});

// ── mint / status / revoke round-trip ────────────────────────────────────────────────

test("mint returns a token, flips status configured=true, revoke flips it back", async () => {
  // Start from a config with no apiToken; mint via the route (owner-gated — use a session).
  const cfg = enforcedCfg();
  const app = createApp(cfg);
  const auth = { cookie: `gm_session=${ownerSessionCookie()}`, ...REMOTE.headers };

  // Status before: not configured.
  const before = await app.request("/api/auth/token", { headers: auth });
  expect(before.status).toBe(200);
  expect(await before.json()).toEqual({ ok: true, configured: false });

  // Mint: returns the token value (the only time) + updates cfg in memory.
  const minted = await app.request("/api/auth/token", { method: "POST", headers: auth });
  expect(minted.status).toBe(200);
  const body = (await minted.json()) as { ok: boolean; token: string };
  expect(body.ok).toBe(true);
  expect(typeof body.token).toBe("string");
  expect(body.token.length).toBeGreaterThan(20);
  expect(cfg.apiToken).toBe(body.token); // hydrated into the live config

  // Status after mint: configured (and NEVER returns the value).
  const after = await app.request("/api/auth/token", { headers: auth });
  const afterBody = (await after.json()) as Record<string, unknown>;
  expect(afterBody).toEqual({ ok: true, configured: true });
  expect(JSON.stringify(afterBody)).not.toContain(body.token);

  // A request carrying the freshly-minted token now passes the gate.
  const passes = await app.request("/api/repos", {
    headers: { ...REMOTE.headers, authorization: `Bearer ${body.token}` },
  });
  expect(passes.status).not.toBe(401);

  // Revoke: clears the token; status flips back to false.
  const revoked = await app.request("/api/auth/token", { method: "DELETE", headers: auth });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ ok: true });
  expect(cfg.apiToken).toBeUndefined();

  const final = await app.request("/api/auth/token", { headers: auth });
  expect(await final.json()).toEqual({ ok: true, configured: false });
});
