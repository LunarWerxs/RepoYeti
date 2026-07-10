/**
 * Locks in the re-parameterized handleLogin signature (RepoYeti burndown G14): it now takes a
 * BARE OAuthConfig + an optional AuthOptions bag, NOT the whole RepoYetiConfig. These tests drive
 * it with a hand-built OAuthConfig (no RepoYetiConfig anywhere) and assert:
 *   • the authorize redirect is built correctly (endpoint, client_id, PKCE S256, redirect_uri, state)
 *   • the PKCE transaction is registered and its verifier matches the sent challenge (S256)
 *   • the injected `secret` option actually signs the state (the "explicit session-secret param")
 *
 * A mock fetch feeds OIDC discovery so nothing hits the network.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { handleLogin, unsign, txs } from "../src/auth.ts";
import type { OAuthConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME so key() writes session.key into a throwaway dir ─────────
const TEST_HOME = join(tmpdir(), `repoyeti-auth-login-test-${process.pid}`);
const ORIG_HOME = process.env.REPOYETI_HOME;

beforeAll(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.REPOYETI_HOME = TEST_HOME;
});

afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.REPOYETI_HOME;
  else process.env.REPOYETI_HOME = ORIG_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── A bare OAuthConfig — the whole point: no RepoYetiConfig involved ────────────
const ISSUER = "https://idp.example.test";
const CLIENT_ID = "login-test-client";
const OAUTH: OAuthConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: "https://app.example.test/oauth/callback",
  scopes: "openid profile email",
};

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

/** Mock fetch that answers only the discovery probe; anything else throws (seam-leak guard). */
function mockDiscovery(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          jwks_uri: `${ISSUER}/oauth/jwks`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`[test] unexpected fetch to ${url} — seam leak`);
  };
}

test("handleLogin(bare OAuthConfig) 302s to the authorize endpoint with a valid PKCE challenge", async () => {
  const app = new Hono();
  app.get("/oauth/login", (c) => handleLogin(c, OAUTH, { fetchImpl: mockDiscovery() }));

  const res = await app.request("http://localhost/oauth/login");
  expect(res.status).toBe(302);

  const loc = new URL(res.headers.get("location")!);
  expect(`${loc.origin}${loc.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
  expect(loc.searchParams.get("response_type")).toBe("code");
  expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(loc.searchParams.get("scope")).toBe("openid profile email");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  // redirect_uri is the daemon's OWN origin as the browser reached it + /oauth/callback (no shim).
  expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost/oauth/callback");

  // The state is signed (default = module key) and carries a nonce registered in txs whose PKCE
  // verifier hashes (S256) to the challenge we just sent — the full challenge/verifier pairing.
  const state = loc.searchParams.get("state");
  const raw = unsign(state ?? undefined);
  expect(raw).not.toBeNull();
  const { n: nonce, o: origin } = JSON.parse(raw!) as { n: string; o: string };
  expect(origin).toBe("http://localhost");

  const tx = txs.get(nonce);
  expect(tx).toBeDefined();
  const challenge = loc.searchParams.get("code_challenge")!;
  expect(createHash("sha256").update(tx!.verifier).digest("base64url")).toBe(challenge);

  txs.delete(nonce); // don't leak into other tests
});

test("handleLogin honours an injected `secret` — the state is signed with it, not the default key", async () => {
  const secret = randomBytes(32);
  const app = new Hono();
  app.get("/oauth/login", (c) => handleLogin(c, OAUTH, { fetchImpl: mockDiscovery(), secret }));

  const res = await app.request("http://localhost/oauth/login");
  expect(res.status).toBe(302);

  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  // Verifying with the injected secret succeeds…
  expect(unsign(state, secret)).not.toBeNull();
  // …while the module's default per-install key does NOT validate it (proves the param is wired).
  expect(unsign(state)).toBeNull();

  const { n: nonce } = JSON.parse(unsign(state, secret)!) as { n: string };
  txs.delete(nonce);
});
