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
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../relay/worker.js";
import { handleComplete, handleLogin, sign, unsign, txs } from "../src/auth.ts";
import type { OAuthConfig, RepoYetiConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";
import { createRelayIdentity, signAnnounce } from "../src/relay.ts";
import { publishRemoteRoutes } from "../src/runtime.ts";

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
  // Loopback remains direct; only rotating Quick Tunnels need the stable relay callback.
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

test("a Quick Tunnel login uses the resolved stable callback and carries its relay route in signed state", async () => {
  const relayId = "0123456789abcdef0123456789abcdef";
  const app = new Hono();
  app.get("/oauth/login", (c) =>
    handleLogin(c, OAUTH, {
      fetchImpl: mockDiscovery(),
      resolveRedirect: async () => ({
        redirectUri: "https://app.repoyeti.com/oauth/callback",
        relayId,
      }),
    }),
  );

  const res = await app.request("https://snowy-yeti.trycloudflare.com/oauth/login");

  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location")!);
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://app.repoyeti.com/oauth/callback");
  const state = authorize.searchParams.get("state")!;
  const payload = JSON.parse(unsign(state)!) as { n: string; o: string; d: string; r: string };
  expect(payload.o).toBe("https://snowy-yeti.trycloudflare.com");
  expect(payload.d).toBe("https://app.repoyeti.com/oauth/callback");
  expect(payload.r).toBe(relayId);

  txs.delete(payload.n);
});

test("the token exchange reuses the exact registered callback carried by signed state", async () => {
  const nonce = `redirect-uri-${Date.now()}`;
  txs.set(nonce, { verifier: "test-verifier", ts: Date.now() });
  const state = sign(
    JSON.stringify({
      n: nonce,
      o: "https://snowy-yeti.trycloudflare.com",
      d: "https://app.repoyeti.com/oauth/callback",
      r: "0123456789abcdef0123456789abcdef",
    }),
  );
  let tokenBody: URLSearchParams | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCOVERY_URL) return mockDiscovery()(input, init);
    if (url === `${ISSUER}/oauth/token`) {
      tokenBody = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ error: "stop-after-capture" }), { status: 400 });
    }
    throw new Error(`[test] unexpected fetch to ${url}`);
  };
  const app = new Hono();
  app.get("/oauth/finish", (c) => handleComplete(c, OAUTH, { fetchImpl }));

  const res = await app.request(
    `https://snowy-yeti.trycloudflare.com/oauth/finish?code=test-code&state=${encodeURIComponent(state)}`,
  );

  expect(res.status).toBe(502);
  expect(tokenBody!.get("redirect_uri")).toBe("https://app.repoyeti.com/oauth/callback");
  txs.delete(nonce);
});

test("a legacy local state without a redirect field keeps using its originating callback", async () => {
  const nonce = `legacy-state-${Date.now()}`;
  txs.set(nonce, { verifier: "legacy-verifier", ts: Date.now() });
  const state = sign(JSON.stringify({ n: nonce, o: "http://localhost:7171" }));
  let tokenBody: URLSearchParams | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCOVERY_URL) return mockDiscovery()(input, init);
    if (url === `${ISSUER}/oauth/token`) {
      tokenBody = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ error: "stop-after-capture" }), { status: 400 });
    }
    throw new Error(`[test] unexpected fetch to ${url}`);
  };
  const app = new Hono();
  app.get("/oauth/callback", (c) => handleComplete(c, OAUTH, { fetchImpl }));

  const res = await app.request(
    `http://localhost:7171/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`,
  );

  expect(res.status).toBe(502);
  expect(tokenBody!.get("redirect_uri")).toBe("http://localhost:7171/oauth/callback");
  txs.delete(nonce);
});

test("login returns 503 before contacting Connections when the Quick Tunnel callback is unavailable", async () => {
  let discoveryCalled = false;
  const app = new Hono();
  app.get("/oauth/login", (c) =>
    handleLogin(c, OAUTH, {
      fetchImpl: async () => {
        discoveryCalled = true;
        throw new Error("discovery must not run");
      },
      resolveRedirect: async () => {
        throw new Error("callback route is not ready");
      },
    }),
  );

  const res = await app.request("https://snowy-yeti.trycloudflare.com/oauth/login");

  expect(res.status).toBe(503);
  expect(await res.text()).toContain("temporarily unavailable");
  expect(discoveryCalled).toBe(false);
});

test("RepoYeti's public login route consumes the callback announced for its Quick Tunnel", async () => {
  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    mode: "remote",
    relay: { enabled: false },
    oauth: { ...OAUTH, redirectUri: "https://app.repoyeti.com/oauth/callback" },
  };
  await publishRemoteRoutes(
    cfg,
    "https://snowy-yeti.trycloudflare.com",
    (async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  );
  // Populate the module's discovery cache through the supported fetch seam, keeping this route
  // assertion fully offline even though createApp deliberately exposes no production fetch knob.
  const warmup = new Hono();
  warmup.get("/oauth/login", (c) => handleLogin(c, cfg.oauth!, { fetchImpl: mockDiscovery() }));
  const warmupRes = await warmup.request("http://127.0.0.1:7171/oauth/login");
  const warmupState = new URL(warmupRes.headers.get("location")!).searchParams.get("state")!;
  txs.delete((JSON.parse(unsign(warmupState)!) as { n: string }).n);

  const res = await createApp(cfg).request("https://snowy-yeti.trycloudflare.com/oauth/login");

  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location")!);
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://app.repoyeti.com/oauth/callback");
  const payload = JSON.parse(unsign(authorize.searchParams.get("state")!)!) as { n: string; r?: string };
  expect(payload.r).toBe(cfg.relay?.identity?.id);
  txs.delete(payload.n);
});

test("a remote browser completes login through the stable Worker callback and receives an owner session", async () => {
  const origin = "https://snowy-yeti.trycloudflare.com";
  const identity = createRelayIdentity();
  const kv = new Map<string, string>();
  const env = {
    RELAY: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
    },
  };
  const ts = Date.now();
  const announce = await worker.fetch(
    new Request("https://app.repoyeti.com/announce", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signAnnounce(identity, origin, ts),
      },
      body: JSON.stringify({ id: identity.id, origin, ts, publicKey: identity.publicKey }),
    }),
    env,
  );
  expect(announce.status).toBe(200);

  const oauth: OAuthConfig = {
    ...OAUTH,
    redirectUri: "https://app.repoyeti.com/oauth/callback",
    ownerSub: "owner-sub",
    ownerEmail: "owner@example.com",
  };
  const login = new Hono();
  login.get("/oauth/login", (c) =>
    handleLogin(c, oauth, {
      fetchImpl: mockDiscovery(),
      resolveRedirect: async () => ({ redirectUri: oauth.redirectUri, relayId: identity.id }),
    }),
  );
  const loginRes = await login.request(`${origin}/oauth/login`);
  const authorize = new URL(loginRes.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;

  const callback = new URL(oauth.redirectUri);
  callback.searchParams.set("code", "issued-code");
  callback.searchParams.set("state", state);
  const callbackRes = await worker.fetch(new Request(callback), env);
  expect(callbackRes.status).toBe(302);

  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "login-key";
  const idToken = await new SignJWT({ sub: "owner-sub", email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "login-key" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(pair.privateKey);
  let exchange: URLSearchParams | null = null;
  const finishFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCOVERY_URL) return mockDiscovery()(input, init);
    if (url === `${ISSUER}/oauth/token`) {
      exchange = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`[test] unexpected fetch to ${url}`);
  };
  const finish = new Hono();
  finish.get("/oauth/finish", (c) =>
    handleComplete(c, oauth, {
      fetchImpl: finishFetch,
      jwksSet: createLocalJWKSet({ keys: [jwk] }),
    }),
  );

  const finishRes = await finish.request(callbackRes.headers.get("location")!);

  expect(finishRes.status).toBe(302);
  expect(finishRes.headers.get("location")).toBe("/");
  expect(finishRes.headers.get("set-cookie")).toContain("gm_session=");
  expect(finishRes.headers.get("set-cookie")).toContain("Secure");
  expect(exchange!.get("redirect_uri")).toBe(oauth.redirectUri);
  expect(exchange!.get("code_verifier")).toBeTruthy();
});
