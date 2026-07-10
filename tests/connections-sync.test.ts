/**
 * Tests for src/connections-sync.ts — the daemon-side BFF for "Sync my settings with Connections".
 *
 * Zero prior coverage for this surface, so this file exercises the whole lifecycle against a
 * MOCKED fetch (token endpoint + the locker's studio.connections.icu calls; the @cnct/connect
 * SDK uses fixed endpoint paths, so OIDC discovery is never fetched) — NEVER the real
 * Connections service. Uses a temp REPOYETI_HOME + an in-memory keychain
 * (REPOYETI_KEYCHAIN_MEMORY, following tests/api-token.test.ts) so nothing real is touched.
 *
 * Covers:
 *  - token refresh-on-401: an expired/absent access token triggers a refresh before the locker call
 *  - refresh-token rotation persistence: a rotated refresh_token is re-saved to the keychain
 *  - a dead/revoked refresh token (400/401 from the token endpoint) clears the connection
 *  - enable/disable/forget lifecycle (seed-when-empty, pull-when-populated, forget wipes remote+local)
 *  - PREF_KEYS allowlist filtering: non-allowlisted keys never leave the box (push), and an
 *    untrusted/newer remote doc can't inject arbitrary config keys (pull)
 *  - appearance merge/passthrough behavior
 */
import { test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initCloudSync,
  hasConnection,
  rememberTokens,
  clearTokens,
  pushNow,
  pullNow,
  enable,
  disable,
  updateAppearance,
  syncStatus,
} from "../src/connections-sync.ts";
import { getSecret, CONNECTIONS_REFRESH_TOKEN } from "../src/secrets.ts";
import type { RepoYetiConfig, OAuthConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME + in-memory keychain so nothing real is touched ──────────────────
const TEST_HOME = join(tmpdir(), `repoyeti-connections-sync-test-${process.pid}`);
const ORIG_HOME = process.env.REPOYETI_HOME;
const ORIG_MEM = process.env.REPOYETI_KEYCHAIN_MEMORY;
const ORIG_SVC = process.env.REPOYETI_KEYCHAIN_SERVICE;

beforeAll(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.REPOYETI_HOME = TEST_HOME;
  process.env.REPOYETI_KEYCHAIN_MEMORY = "1";
  process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-connections-sync-test-${process.pid}`;
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

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
const ISSUER = "https://accounts.connections.icu";
const CLIENT_ID = "test-sync-client";
const OAUTH: OAuthConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: "https://example.com/cb",
};

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const STORE_BASE = "https://studio.connections.icu";
const DOC_URL = `${STORE_BASE}/v1/app-data/${encodeURIComponent(CLIENT_ID)}`;

function baseCfg(extra?: Partial<RepoYetiConfig>): RepoYetiConfig {
  return { roots: [], port: 7171, maxDepth: 6, maxRepos: 200, oauth: { ...OAUTH }, ...extra };
}

/** In-memory fake of the remote app-data document + token endpoint, wired as the global fetch. */
class FakeConnectionsServer {
  version = 0;
  settings: Record<string, unknown> = {};
  /** Tokens the fake token endpoint will accept as a refresh_token → mints an access token. */
  validRefreshTokens = new Set<string>(["initial-refresh-token"]);
  /** When set, the NEXT successful refresh rotates to this new refresh token. */
  rotateTo: string | null = null;
  /** Call counters for assertions. */
  tokenCalls = 0;
  docGetCalls = 0;
  docPostCalls = 0;
  docDeleteCalls = 0;
  lastAuthHeader: string | null = null;

  fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({ issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === TOKEN_ENDPOINT && method === "POST") {
      this.tokenCalls += 1;
      const body = new URLSearchParams(String(init?.body ?? ""));
      const rt = body.get("refresh_token");
      if (!rt || !this.validRefreshTokens.has(rt)) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      const payload: Record<string, unknown> = {
        access_token: `access-for-${rt}`,
        expires_in: 3600,
      };
      if (this.rotateTo) {
        payload.refresh_token = this.rotateTo;
        this.validRefreshTokens.add(this.rotateTo);
        this.rotateTo = null;
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === DOC_URL) {
      this.lastAuthHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      if (method === "GET") {
        this.docGetCalls += 1;
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
        this.docPostCalls += 1;
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
        if (req.merge) {
          this.settings = { ...this.settings, ...req.settings };
        } else {
          this.settings = req.settings;
        }
        this.version += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (method === "DELETE") {
        this.docDeleteCalls += 1;
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
  await clearTokens(); // reset any in-memory token state left by a previous test
  await initCloudSync(); // re-arm the module's "loaded" guard against the fresh keychain state
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  await clearTokens();
});

// ── token refresh-on-401 (in this module: refresh-on-missing/expired access token) ──────

test("getAccessToken mints a fresh access token via refresh when none is cached", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH); // no access_token yet
  const cfg = baseCfg();
  await pushNow(cfg, OAUTH); // forces getAccessToken() → refresh()
  expect(server.tokenCalls).toBe(1);
  expect(server.lastAuthHeader).toBe("Bearer access-for-initial-refresh-token");
});

test("a cached, unexpired access token is reused — no refresh call", async () => {
  await rememberTokens({ access_token: "still-fresh", refresh_token: "initial-refresh-token", expires_in: 3600 }, OAUTH);
  const cfg = baseCfg();
  await pushNow(cfg, OAUTH);
  expect(server.tokenCalls).toBe(0);
  expect(server.lastAuthHeader).toBe("Bearer still-fresh");
});

test("an expired cached access token triggers a re-refresh", async () => {
  await rememberTokens({ access_token: "stale", refresh_token: "initial-refresh-token", expires_in: -1 }, OAUTH);
  const cfg = baseCfg();
  await pushNow(cfg, OAUTH);
  expect(server.tokenCalls).toBe(1);
  expect(server.lastAuthHeader).toBe("Bearer access-for-initial-refresh-token");
});

// ── refresh-token rotation persistence ───────────────────────────────────────────────────

test("a rotated refresh_token from the IdP is persisted to the keychain and used on the next refresh", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  server.rotateTo = "rotated-refresh-token";
  const cfg = baseCfg();

  await pushNow(cfg, OAUTH); // triggers refresh → rotation happens here
  expect(await getSecret(CONNECTIONS_REFRESH_TOKEN)).toBe("rotated-refresh-token");

  // Force a second refresh (simulate the cached access token going stale) and confirm the
  // rotated refresh token is what's actually spent.
  await rememberTokens({ access_token: "force-expired", expires_in: -1 }, OAUTH);
  await pushNow(cfg, OAUTH);
  expect(server.lastAuthHeader).toBe("Bearer access-for-rotated-refresh-token");
});

test("a dead/revoked refresh token (400) clears the stored connection entirely", async () => {
  await rememberTokens({ refresh_token: "not-a-real-token" }, OAUTH);
  const cfg = baseCfg();
  await expect(pushNow(cfg, OAUTH)).rejects.toThrow();
  expect(hasConnection()).toBe(false);
  expect(await getSecret(CONNECTIONS_REFRESH_TOKEN)).toBeNull();
});

// ── enable/disable/forget lifecycle ───────────────────────────────────────────────────────

test("enable() with an empty remote doc seeds the store from local settings", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ diffStats: true, autoCommitIntervalSecs: 42 });
  const status = await enable(cfg, OAUTH);

  expect(status.enabled).toBe(true);
  expect(status.connected).toBe(true);
  expect(server.docPostCalls).toBe(1); // seeded (pushed), not pulled-and-applied
  expect(server.settings.prefs).toMatchObject({ diffStats: true, autoCommitIntervalSecs: 42 });
});

test("enable() with a populated remote doc pulls and applies it locally instead of pushing", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  server.settings = { prefs: { diffStats: true, autoScan: true } };
  server.version = 1;

  const cfg = baseCfg({ diffStats: false });
  const status = await enable(cfg, OAUTH);

  expect(status.enabled).toBe(true);
  expect(server.docPostCalls).toBe(0); // never pushed — only pulled
  expect(cfg.diffStats).toBe(true); // applied from remote
  expect(cfg.autoScan).toBe(true);
});

test("enable() while signed out turns the flag on locally but performs no network call", async () => {
  const cfg = baseCfg();
  const status = await enable(cfg, OAUTH);
  expect(status.enabled).toBe(true);
  expect(status.connected).toBe(false);
  expect(server.docGetCalls + server.docPostCalls).toBe(0);
});

test("disable() without forget turns sync off but keeps the connection + remote doc", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ cloudSync: { enabled: true, version: 3 } });
  const status = await disable(cfg, OAUTH, { forget: false });

  expect(status.enabled).toBe(false);
  expect(hasConnection()).toBe(true); // still connected
  expect(server.docDeleteCalls).toBe(0);
  expect(cfg.cloudSync?.version).toBe(3); // untouched
});

test("disable({ forget: true }) deletes the remote doc and clears local tokens/state", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ cloudSync: { enabled: true, version: 5, appearance: { theme: "dark" }, lastSyncedAt: "x" } });

  const status = await disable(cfg, OAUTH, { forget: true });

  expect(status.enabled).toBe(false);
  expect(server.docDeleteCalls).toBe(1);
  expect(hasConnection()).toBe(false);
  expect(await getSecret(CONNECTIONS_REFRESH_TOKEN)).toBeNull();
  expect(cfg.cloudSync?.version).toBe(0);
  expect(cfg.cloudSync?.appearance).toBeUndefined();
  expect(cfg.cloudSync?.lastSyncedAt).toBeUndefined();
});

test("disable({ forget: true }) still clears local state even if the remote delete fails", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ cloudSync: { enabled: true } });
  // Make the DELETE fail.
  const realImpl = server.fetchImpl;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
      return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
    }
    return realImpl(input, init);
  }) as unknown as typeof fetch;

  const status = await disable(cfg, OAUTH, { forget: true });
  expect(status.enabled).toBe(false);
  expect(hasConnection()).toBe(false); // local disconnect proceeds regardless
});

// ── PREF_KEYS allowlist filtering ──────────────────────────────────────────────────────

test("pushNow only ever sends PREF_KEYS-allowlisted keys — never secrets or machine-specific state", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({
    roots: ["/definitely/secret/path"],
    port: 9999,
    maxDepth: 99,
    maxRepos: 12345,
    mode: "remote",
    autoCommit: true, // deliberately excluded from PREF_KEYS
    autoCommitPush: true, // deliberately excluded from PREF_KEYS
    diffStats: true, // allowlisted (note: PREF_KEYS lists "diffStats", matching this config key)
    apiToken: "super-secret-token",
    ai: { providers: { anthropic: { apiKey: "sk-ant-should-never-leave", model: "x" } } },
  });

  await pushNow(cfg, OAUTH);

  const sent = server.settings.prefs as Record<string, unknown>;
  // Only allowlisted, portable keys present.
  expect(sent).toEqual({ diffStats: true });
  // Explicitly confirm forbidden data never appears anywhere in the pushed payload.
  const raw = JSON.stringify(server.settings);
  expect(raw).not.toContain("secret/path");
  expect(raw).not.toContain("super-secret-token");
  expect(raw).not.toContain("sk-ant-should-never-leave");
  expect(raw).not.toContain("autoCommit");
});

test("pullNow only applies PREF_KEYS-allowlisted keys from the remote doc — extras are ignored", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  server.version = 1;
  server.settings = {
    prefs: {
      diffStats: true,
      autoScan: true,
      // Not on the allowlist — must be ignored even though the remote doc carries it (e.g. a
      // malicious or future-version write) so a synced doc can never inject arbitrary config.
      mode: "remote",
      apiToken: "hijacked-token",
      roots: ["/etc"],
    },
  };

  const cfg = baseCfg({ mode: "local", apiToken: undefined, roots: [] });
  const result = await pullNow(cfg, OAUTH);

  expect(result.applied).toBe(true);
  expect(cfg.diffStats).toBe(true);
  expect(cfg.autoScan).toBe(true);
  // Non-allowlisted fields are untouched.
  expect(cfg.mode).toBe("local");
  expect(cfg.apiToken).toBeUndefined();
  expect(cfg.roots).toEqual([]);
});

test("pullNow against a never-written remote doc (version 0) applies nothing", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ diffStats: true });
  const result = await pullNow(cfg, OAUTH);
  expect(result.applied).toBe(false);
  expect(result.version).toBe(0);
  expect(cfg.diffStats).toBe(true); // unchanged
});

// ── appearance merge behavior ─────────────────────────────────────────────────────────

test("pushNow includes the locally-held appearance blob alongside prefs", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  const cfg = baseCfg({ cloudSync: { appearance: { theme: "dark" } } });
  await pushNow(cfg, OAUTH);
  expect(server.settings.appearance).toEqual({ theme: "dark" });
});

test("pullNow adopts a remote appearance blob (object) into cfg.cloudSync.appearance", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  server.version = 1;
  server.settings = { prefs: {}, appearance: { theme: "light" } };
  const cfg = baseCfg();
  await pullNow(cfg, OAUTH);
  expect(cfg.cloudSync?.appearance).toEqual({ theme: "light" });
});

test("pullNow ignores a malformed (non-object) remote appearance value", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  server.version = 1;
  server.settings = { prefs: {}, appearance: "not-an-object" as unknown as Record<string, unknown> };
  const cfg = baseCfg({ cloudSync: { appearance: { theme: "dark" } } });
  await pullNow(cfg, OAUTH);
  expect(cfg.cloudSync?.appearance).toEqual({ theme: "dark" }); // left untouched
});

test("updateAppearance pushes only when sync is enabled + connected", async () => {
  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);

  // Disabled: recorded locally, no network call.
  const cfgOff = baseCfg({ cloudSync: { enabled: false } });
  await updateAppearance(cfgOff, OAUTH, { theme: "light" });
  expect(cfgOff.cloudSync?.appearance).toEqual({ theme: "light" });
  expect(server.docPostCalls).toBe(0);

  // Enabled + connected: recorded locally AND pushed.
  const cfgOn = baseCfg({ cloudSync: { enabled: true } });
  await updateAppearance(cfgOn, OAUTH, { theme: "system" });
  expect(cfgOn.cloudSync?.appearance).toEqual({ theme: "system" });
  expect(server.docPostCalls).toBe(1);
  expect(server.settings.appearance).toEqual({ theme: "system" });
});

// ── syncStatus() projection ────────────────────────────────────────────────────────────

test("syncStatus reflects enabled/connected/version/appearance from cfg + module token state", async () => {
  const cfg = baseCfg({ cloudSync: { enabled: true, version: 7, lastSyncedAt: "2026-01-01T00:00:00.000Z", appearance: { theme: "dark" } } });
  expect(hasConnection()).toBe(false); // no tokens remembered in this test
  let s = syncStatus(cfg);
  expect(s).toEqual({ enabled: true, connected: false, lastSyncedAt: "2026-01-01T00:00:00.000Z", version: 7, appearance: { theme: "dark" } });

  await rememberTokens({ refresh_token: "initial-refresh-token" }, OAUTH);
  s = syncStatus(cfg);
  expect(s.connected).toBe(true);
});
