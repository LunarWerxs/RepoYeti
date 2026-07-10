/**
 * Integration-style tests for the id_token verification path in src/auth.ts handleComplete.
 *
 * These fill the gap documented in tests/auth-protocol.test.ts [3][4][5]:
 *  [3] id_token with wrong iss  → rejected (401 error page)
 *  [4] id_token with wrong aud  → rejected (401 error page)
 *  [5] id_token with past exp   → rejected (401 error page)
 *  [+] id_token valid (control) → accepted (302 redirect to /)
 *
 * Seam used: handleComplete's optional third argument { fetchImpl, jwksSet }.
 *   - fetchImpl intercepts OIDC discovery + token exchange (no live network).
 *   - jwksSet is a createLocalJWKSet resolver built from the test keypair (no remote JWKS fetch).
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
} from "jose";
import {
  sign,
  txs,
  handleComplete,
} from "../src/auth.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME so tests never pollute ~/.repoyeti ─────────────────────────
const TEST_HOME = join(tmpdir(), `repoyeti-auth-oidc-test-${process.pid}`);
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

// ── Constants matching the test OAuthConfig ───────────────────────────────────
const ISSUER = "https://accounts.connections.icu";
const CLIENT_ID = "test-client-oidc";
const OWNER_SUB = "owner-sub-oidc-456";
const OWNER_EMAIL = "owner-oidc@example.com";

const OAUTH_CFG = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: "https://example.com/cb",
  ownerSub: OWNER_SUB,
  ownerEmail: OWNER_EMAIL,
};

const BASE_CFG: RepoYetiConfig = {
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  oauth: OAUTH_CFG,
};

// ── Ephemeral RS256 keypair (generated once per test run) ──────────────────────
let privateKey: CryptoKey;
let localJwksSet: ReturnType<typeof createLocalJWKSet>;

// jose's generateKeyPair is async; initialise before tests run.
let keysReady = false;
async function ensureKeys(): Promise<void> {
  if (keysReady) return;
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  // Give the key an id so createLocalJWKSet can select it.
  jwk.kid = "test-key-1";
  jwk.use = "sig";
  localJwksSet = createLocalJWKSet({ keys: [jwk] });
  keysReady = true;
}

// ── Token factory ─────────────────────────────────────────────────────────────

interface TokenOverrides {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  /** Unix seconds; defaults to now + 3600 */
  exp?: number;
}

async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  await ensureKeys();
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: overrides.sub ?? OWNER_SUB,
    email: overrides.email ?? OWNER_EMAIL,
    aud: overrides.aud ?? CLIENT_ID,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setExpirationTime(overrides.exp ?? nowSec + 3600)
    .setIssuedAt(nowSec)
    .sign(privateKey);
}

// ── Mock fetch factory ────────────────────────────────────────────────────────
//
// Returns a fetchImpl that intercepts:
//   GET  <issuer>/.well-known/openid-configuration  → minimal discovery doc
//   POST <token_endpoint>                            → { id_token: <supplied> }
//
// All other URLs throw so tests fail loudly if something leaks to the real network.

const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`; // never fetched when jwksSet is supplied

function makeMockFetch(idToken: string): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: TOKEN_ENDPOINT,
          jwks_uri: JWKS_URI,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({ id_token: idToken, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`[test] unexpected fetch to ${url} — seam leak`);
  };
}

// ── Helper: build a signed state + pre-wired txs entry, fire handleComplete ───

async function runHandleComplete(idToken: string): Promise<Response> {
  await ensureKeys();

  const nonce = `oidc-test-nonce-${Math.random().toString(36).slice(2)}`;
  txs.set(nonce, { verifier: "test-verifier", ts: Date.now() });

  const statePayload = JSON.stringify({ n: nonce, o: "https://example.com" });
  const state = sign(statePayload);

  const app = new Hono();
  app.get("/oauth/finish", (c) =>
    handleComplete(c, BASE_CFG.oauth!, {
      fetchImpl: makeMockFetch(idToken),
      jwksSet: localJwksSet,
    }),
  );

  const url = `http://localhost/oauth/finish?code=test-code&state=${encodeURIComponent(state)}`;
  const res = await app.request(url);

  // Clean up any un-consumed nonce (consumed on success, remains on error).
  txs.delete(nonce);

  return res;
}

// ── [3] Wrong issuer ──────────────────────────────────────────────────────────

test("[3] id_token with wrong iss is rejected with a 401 error page", async () => {
  const badToken = await mintToken({ iss: "https://evil.com" });
  const res = await runHandleComplete(badToken);
  // jwtVerify throws JWSInvalid/JWTClaimValidationFailed → caught → 401 error page
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(body).toContain("verify");
});

// ── [4] Wrong audience ────────────────────────────────────────────────────────

test("[4] id_token with wrong aud is rejected with a 401 error page", async () => {
  const badToken = await mintToken({ aud: "other-client-id" });
  const res = await runHandleComplete(badToken);
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(body).toContain("verify");
});

// ── [5] Expired token ─────────────────────────────────────────────────────────

test("[5] id_token with past exp is rejected with a 401 error page", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const badToken = await mintToken({ exp: nowSec - 3600 }); // 1 hour in the past
  const res = await runHandleComplete(badToken);
  expect(res.status).toBe(401);
  const body = await res.text();
  expect(body).toContain("verify");
});

// ── [+] Valid token — positive control ────────────────────────────────────────

test("[+] valid id_token (correct iss/aud/exp, matching owner) is accepted → 302 to /", async () => {
  const goodToken = await mintToken(); // all defaults: correct iss, aud, exp, owner sub
  const res = await runHandleComplete(goodToken);
  // handleComplete calls c.redirect("/") on success.
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
});
