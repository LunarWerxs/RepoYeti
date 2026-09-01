/**
 * Adversarial security tests for the hand-rolled OIDC/PKCE/session code in src/auth.ts.
 *
 * Coverage map:
 *  [1] Tampered/forged signed `state` value → rejected (HMAC signature check)
 *  [2] Expired login transaction (nonce not in txs map) → rejected
 *  [3] id_token `iss` mismatch → rejected (401, against a live mock IdP — see below)
 *  [4] id_token `aud` mismatch → rejected (401, against a live mock IdP — see below)
 *  [5] id_token past `exp` → rejected      (401, against a live mock IdP — see below)
 *  [6] Wrong-owner sub/email in verified token → rejected (ownerMatches check)
 *  [7] Tampered session cookie → readSession returns null
 *
 * Cases [3][4][5] run against a REAL local IdP — a Bun.serve() mini identity provider started
 * in beforeAll that answers OIDC discovery, token exchange and JWKS over 127.0.0.1. The
 * OAuthConfig's `issuer` points at it, so handleComplete is called with NO options bag and
 * therefore drives its own production code path end to end: the module-local `authFetch`
 * closure, the `discover()` cache, and `createRemoteJWKSet()` against a live JWKS URL. The
 * token is minted here with an ephemeral RS256 keypair generated at runtime (nothing secret
 * is ever committed) and deliberately malformed one claim at a time.
 *
 * This is the strong form of the check on purpose. tests/auth-oidc-verify.test.ts covers the
 * same three claims through handleComplete's `{ fetchImpl, jwksSet }` test seams, which is
 * faster but substitutes both network legs — so it cannot see a regression in `discover()`,
 * in the JWKS resolver, or in the default no-options call shape a production login uses.
 * Neither file subsumes the other; a break in the claim checks fails both, a break in the
 * fetch/JWKS plumbing fails only this one.
 *
 * Every rejection test here is paired with the [3-5 control] positive case below. Three tests
 * that assert "401" prove nothing on their own — a mis-wired harness returns 401 for every
 * input. The control is what makes the other three mean "rejected *because of that claim*".
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  sign,
  unsign,
  ownerMatches,
  txs,
  readSession,
  handleComplete,
  authMiddleware,
} from "../src/auth.ts";
import type { OAuthConfig, RepoYetiConfig } from "../src/config.ts";

// ── Temp REPOYETI_HOME so tests never pollute ~/.repoyeti ─────────────────────────
const TEST_HOME = join(tmpdir(), `repoyeti-auth-protocol-test-${process.pid}`);
const ORIG_HOME = process.env.REPOYETI_HOME;

beforeAll(async () => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env.REPOYETI_HOME = TEST_HOME;
  // Force the signing key module to re-read from the temp dir on next call.
  // (The module caches KEY in a closure; setting REPOYETI_HOME only matters if the
  //  first key() call in this process reads from it. In the test runner each test
  //  file is its own module instance so the cache starts cold — this is belt-and-
  //  suspenders to make intent explicit.)

  // Bring up the mock IdP (see "Mock IdP" below). ~75ms for the RS256 keypair.
  const pair = await generateKeyPair("RS256", { extractable: true });
  idpSigningKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = IDP_KID;
  jwk.use = "sig";
  jwk.alg = "RS256";
  const jwksBody = JSON.stringify({ keys: [jwk] });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);

      if (pathname === "/.well-known/openid-configuration") {
        discoveryHits++;
        return Response.json({
          issuer: idpOrigin,
          authorization_endpoint: `${idpOrigin}/oauth/authorize`,
          token_endpoint: `${idpOrigin}/oauth/token`,
          jwks_uri: `${idpOrigin}/.well-known/jwks.json`,
        });
      }

      if (pathname === "/.well-known/jwks.json") {
        jwksHits++;
        return new Response(jwksBody, { headers: { "content-type": "application/json" } });
      }

      if (pathname === "/oauth/token" && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        tokenExchanges.push(body);
        const idToken = issuedTokens.get(body.get("code") ?? "");
        // Answer an unknown code the way a real IdP does, so the "reaches token exchange"
        // test below gets a distinguishable failure rather than a network error.
        if (!idToken) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ id_token: idToken, token_type: "Bearer" });
      }

      return new Response("not found", { status: 404 });
    },
  });
  idpOrigin = `http://127.0.0.1:${server.port}`;
  stopIdp = () => server.stop(true);
});

afterAll(() => {
  stopIdp?.();
  stopIdp = null;
  if (ORIG_HOME === undefined) delete process.env.REPOYETI_HOME;
  else process.env.REPOYETI_HOME = ORIG_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Produce a valid signed cookie value for a session, bypassing the HTTP layer. */
function makeSessionCookie(payload: object): string {
  return sign(JSON.stringify(payload));
}

const OWNER_OAUTH: OAuthConfig = {
  issuer: "https://accounts.connections.icu",
  clientId: "test-client",
  redirectUri: "https://example.com/cb",
  ownerSub: "owner-sub-123",
  ownerEmail: "owner@example.com",
};

// ── Mock IdP: a REAL local server, not a mocked fetch ─────────────────────────
//
// handleComplete reaches the network through `authFetch`, a module-local closure in
// src/auth.ts, and through jose's `createRemoteJWKSet`. Neither can be swapped out on the
// default (production) call path. So instead of reaching past them, these tests give them
// something real to talk to: a Bun.serve() mini identity provider on 127.0.0.1 answering
// the three endpoints an OIDC relying party needs.
//
// The RS256 keypair is generated fresh on every run and never leaves this process. There is
// no key, token or JWKS material committed to this public repo, and there must never be.

const IDP_KID = "auth-protocol-test-key";

/** Authorization codes this IdP will honour → the exact id_token it hands back for each.
 *  Keying by code (rather than a single mutable "next token") keeps each test's fixture
 *  its own, so a leftover from an earlier test cannot silently satisfy a later one. */
const issuedTokens = new Map<string, string>();
/** Every token-exchange body the IdP received — lets a test prove the exchange really happened
 *  and carried the right code, instead of inferring it from a status code that has other causes. */
const tokenExchanges: URLSearchParams[] = [];
/** Bumped on each discovery / JWKS hit, so a test can assert those legs ran for real. */
let discoveryHits = 0;
let jwksHits = 0;

// Held as a closure rather than a typed `Server` handle: Bun 1.4 made that type generic over
// its WebSocket data param, so naming it breaks `bun run typecheck` on a Bun upgrade. Nothing
// here needs the handle itself, only the ability to shut it down.
let stopIdp: (() => void) | null = null;
let idpOrigin = "";
let idpSigningKey: CryptoKey;

/** A fresh OAuthConfig pointed at the local IdP. Fresh per call on purpose: handleComplete
 *  MUTATES the config on a TOFU claim, so a shared object would leak state between tests. */
function idpOAuth(): OAuthConfig {
  return { ...OWNER_OAUTH, issuer: idpOrigin };
}

interface TokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  /** Unix SECONDS. Defaults to one hour from now. */
  exp?: number;
}

/** Mint an id_token signed by the mock IdP's real key, with one claim bent at a time. */
async function mintIdToken(claims: TokenClaims = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? OWNER_OAUTH.ownerEmail })
    .setProtectedHeader({ alg: "RS256", kid: IDP_KID })
    .setSubject(claims.sub ?? OWNER_OAUTH.ownerSub!)
    .setIssuer(claims.iss ?? idpOrigin)
    .setAudience(claims.aud ?? OWNER_OAUTH.clientId)
    .setIssuedAt(nowSec)
    .setExpirationTime(claims.exp ?? nowSec + 3600)
    .sign(idpSigningKey);
}

/**
 * Drive the full /oauth/finish path against the live IdP: register the token the IdP will
 * return for `code`, pre-wire a valid signed state + txs entry, then call handleComplete with
 * NO options bag — exactly as src/http/routes/auth.ts does in production.
 */
async function completeAgainstIdp(idToken: string | null): Promise<Response> {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  if (idToken !== null) issuedTokens.set(code, idToken);

  const nonce = `idp-nonce-${Math.random().toString(36).slice(2)}`;
  txs.set(nonce, { verifier: "test-verifier", ts: Date.now() });
  const state = sign(JSON.stringify({ n: nonce, o: "https://example.com" }));

  const exchangesBefore = tokenExchanges.length;
  const app = new Hono();
  app.get("/oauth/finish", (c) => handleComplete(c, idpOAuth()));
  const res = await app.request(
    `http://localhost/oauth/finish?code=${code}&state=${encodeURIComponent(state)}`,
  );

  txs.delete(nonce); // consumed on success, still present on failure
  issuedTokens.delete(code);

  // Every way this harness can be broken — IdP not listening, wrong port, a route typo — makes
  // handleComplete throw, and its catch turns ANY throw into the same 401 the rejection tests
  // assert. Without this line those tests would go green while proving nothing. Assert here so
  // the guarantee holds for each caller individually, not via a sibling test's side effects.
  expect(tokenExchanges.at(-1)?.get("code")).toBe(code);
  expect(tokenExchanges.length).toBe(exchangesBefore + 1);

  return res;
}

// ── [1] State HMAC: tampered state is rejected ────────────────────────────────

test("[1a] sign → unsign round-trip produces the original payload", () => {
  const payload = JSON.stringify({ n: "nonce-xyz", o: "https://example.com" });
  const token = sign(payload);
  expect(unsign(token)).toBe(payload);
});

test("[1b] a forged state (body changed, mac not updated) returns null", () => {
  const payload = JSON.stringify({ n: "nonce-xyz", o: "https://example.com" });
  const legitimate = sign(payload);
  // Flip one character in the body portion (before the dot) to simulate tampering.
  const [body, mac] = legitimate.split(".");
  const tamperedBody = body!.slice(0, -1) + (body!.slice(-1) === "A" ? "B" : "A");
  const forged = `${tamperedBody}.${mac}`;
  expect(unsign(forged)).toBeNull();
});

test("[1c] a completely fabricated state token (no real HMAC) returns null", () => {
  const fakeBody = Buffer.from('{"n":"evil","o":"https://attacker.com"}').toString("base64url");
  const fakeMac = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").toString("base64url");
  const forged = `${fakeBody}.${fakeMac}`;
  expect(unsign(forged)).toBeNull();
});

test("[1d] a token with a truncated MAC returns null", () => {
  const payload = JSON.stringify({ n: "nonce-abc", o: "https://example.com" });
  const legitimate = sign(payload);
  const [body, mac] = legitimate.split(".");
  // Truncate the MAC to an invalid length — timingSafeEqual will reject length mismatch.
  const truncatedMac = mac!.slice(0, 10);
  expect(unsign(`${body}.${truncatedMac}`)).toBeNull();
});

test("[1e] unsign of undefined returns null", () => {
  expect(unsign(undefined)).toBeNull();
});

test("[1f] unsign of an empty string returns null", () => {
  expect(unsign("")).toBeNull();
});

test("[1g] unsign of a token missing the MAC segment returns null", () => {
  const body = Buffer.from("just-a-body").toString("base64url");
  // No dot → no mac segment
  expect(unsign(body)).toBeNull();
});

// ── [2] Expired login transaction (nonce not in txs map) ─────────────────────
//
// The txs Map is keyed by nonce. handleComplete looks the nonce up; if it is not
// present (because it already expired or was consumed) it returns a 400 error page.
// We can test this without hitting any network by pre-wiring the signed state and
// checking that handleComplete rejects a missing nonce.

test("[2a] a valid signed state whose nonce is NOT in txs yields 400 (expired link)", async () => {
  const nonce = `expired-nonce-${Date.now()}`;
  // Do NOT insert into txs — simulate an already-expired or never-issued nonce.
  const statePayload = JSON.stringify({ n: nonce, o: "https://example.com" });
  const state = sign(statePayload);

  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    oauth: OWNER_OAUTH,
  };

  // Build a request to /oauth/finish?code=xxx&state=<signed-state>
  const app = new Hono();
  app.get("/oauth/finish", (c) => handleComplete(c, cfg.oauth!));
  const req = new Request(`http://localhost/oauth/finish?code=any-code&state=${encodeURIComponent(state)}`);
  const res = await app.request(req.url);

  // Should return 400 (expired link) not 200.
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("expired");
});

test("[2b] a valid signed state whose nonce IS in txs reaches the real token exchange", async () => {
  // This test used to point at the LIVE production IdP (https://accounts.connections.icu) and
  // assert only `status !== 400`. That passed whether the network was up, down, or answering
  // nonsense — every outcome funnels into handleComplete's catch — so it could not distinguish
  // "the nonce check passed" from "everything failed for some unrelated reason", which is the
  // thing its name claims to prove. It also poked a production IdP on every `bun test` run.
  // Now it talks to the local mock IdP and asserts the exchange OBSERVABLY happened.
  const before = tokenExchanges.length;

  // No token registered for this code → the IdP answers invalid_grant, exactly as a real one
  // would for a code it never issued. That is a 502 from handleComplete, NOT the 400 expired page.
  const res = await completeAgainstIdp(null);

  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).not.toContain("expired");
  expect(body).toContain("Token exchange with Connections failed.");

  // The proof the name promises: the IdP's token endpoint actually received the exchange,
  // carrying the PKCE verifier from the txs entry the signed state pointed at.
  expect(tokenExchanges.length).toBe(before + 1);
  const exchange = tokenExchanges.at(-1)!;
  expect(exchange.get("grant_type")).toBe("authorization_code");
  expect(exchange.get("code_verifier")).toBe("test-verifier");
  expect(exchange.get("client_id")).toBe(OWNER_OAUTH.clientId);
}, 10_000);

test("[2c] handleComplete with missing code AND state returns 400 (missing authorization code)", async () => {
  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    oauth: OWNER_OAUTH,
  };
  const app = new Hono();
  app.get("/oauth/finish", (c) => handleComplete(c, cfg.oauth!));
  const res = await app.request("http://localhost/oauth/finish");
  expect(res.status).toBe(400);
});

// ── [3][4][5] id_token iss/aud/exp claim checks ───────────────────────────────
//
// The three threats that matter here all have the same shape: a token that is genuinely,
// verifiably signed, but by or for the wrong party. Each test bends EXACTLY ONE claim and
// leaves everything else valid — same key, same kid, same signature path — so a 401 can only
// mean the claim check fired. The [3-5 control] case at the end proves the harness can also
// produce a 200-class result, which is what stops "always 401" from passing as security.
//
// jwtVerify() failing throws, and handleComplete's catch turns any throw into the 401 error
// page, so the assertion is (401 + the error page's wording).
//
// 10s timeout: three real loopback round trips per test (discovery, token, JWKS) on a cold
// Windows CI box, which has been measured at ~9x a developer machine.

test("[3] an id_token from the WRONG ISSUER is rejected (401)", async () => {
  // Correctly signed by the IdP we trust, but claiming to come from someone else. Accepting
  // this is the whole attack: any service whose key we happen to fetch could mint logins.
  const res = await completeAgainstIdp(await mintIdToken({ iss: "https://evil.com" }));

  expect(res.status).toBe(401);
  expect(await res.text()).toContain("Couldn't verify your Connections sign-in.");
}, 10_000);

test("[4] an id_token minted for the WRONG AUDIENCE is rejected (401)", async () => {
  // A real token from the real IdP — issued to a DIFFERENT client. Without the audience check
  // any token the IdP ever minted for any other app would sign the attacker in here.
  const res = await completeAgainstIdp(await mintIdToken({ aud: "some-other-client-id" }));

  expect(res.status).toBe(401);
  expect(await res.text()).toContain("Couldn't verify your Connections sign-in.");
}, 10_000);

test("[5] an EXPIRED id_token is rejected (401)", async () => {
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
  const res = await completeAgainstIdp(await mintIdToken({ exp: oneHourAgo }));

  expect(res.status).toBe(401);
  expect(await res.text()).toContain("Couldn't verify your Connections sign-in.");
}, 10_000);

test("[3-5 control] a fully valid id_token IS accepted — proves the three above reject on the claim, not on the harness", async () => {
  const res = await completeAgainstIdp(await mintIdToken());

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie")).toContain("gm_session=");
}, 10_000);

test("[3-5 control] the JWKS endpoint was really fetched over the wire", () => {
  // Guards the seam these tests exist to cover: sibling tests in auth-oidc-verify.test.ts pass
  // a `jwksSet` and never touch createRemoteJWKSet. If this count is 0, the tests above verified
  // nothing through the production key-resolution path and their 401s prove less than they look.
  expect(jwksHits).toBeGreaterThan(0);
  expect(discoveryHits).toBeGreaterThan(0);
});

// ── [6] Wrong-owner sub/email check (ownerMatches) ───────────────────────────

test("[6a] ownerMatches returns true when sub matches ownerSub exactly", () => {
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: "sub-abc", ownerEmail: undefined };
  expect(ownerMatches(o, "sub-abc", "other@example.com")).toBe(true);
});

test("[6b] ownerMatches returns true when email matches ownerEmail (case-insensitive)", () => {
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: undefined, ownerEmail: "Owner@Example.COM" };
  expect(ownerMatches(o, "different-sub", "owner@example.com")).toBe(true);
});

test("[6c] ownerMatches returns false for a completely different sub and email", () => {
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: "sub-abc", ownerEmail: "owner@example.com" };
  expect(ownerMatches(o, "sub-evil", "evil@attacker.com")).toBe(false);
});

test("[6d] ownerMatches returns false when sub partially matches (prefix injection)", () => {
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: "sub-abc", ownerEmail: undefined };
  // A longer sub that starts with the owner's sub must NOT match.
  expect(ownerMatches(o, "sub-abc-extra", "legit@example.com")).toBe(false);
});

test("[6e] ownerMatches returns false when email case is different but not a match", () => {
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: undefined, ownerEmail: "owner@example.com" };
  expect(ownerMatches(o, "sub-x", "notowner@example.com")).toBe(false);
});

test("[6f] ownerMatches returns false when no owner is configured (blocks TOFU race)", () => {
  // With no ownerSub and no ownerEmail, a call with any sub/email returns false.
  // (TOFU assignment happens BEFORE ownerMatches in handleComplete, so a valid
  //  first-signer gets assigned and then passes; this test ensures the guard is
  //  strict when a second caller arrives with a different identity.)
  const o: OAuthConfig = { ...OWNER_OAUTH, ownerSub: undefined, ownerEmail: undefined };
  expect(ownerMatches(o, "some-sub", "some@example.com")).toBe(false);
});

test("[6g] readSession rejects a session whose sub no longer matches the configured owner", async () => {
  // Build a valid signed session but with a wrong sub/email.
  const wrongSession = {
    sub: "attacker-sub",
    email: "attacker@evil.com",
    exp: Date.now() + 60_000,
  };
  const cookieValue = makeSessionCookie(wrongSession);

  // Build a minimal Hono context via the app.
  const app = new Hono();
  // Sentinel matches the [7x] tests: a handler that never ran leaves "initial", which fails
  // toBeNull() loudly, instead of `undefined` quietly looking like a near-miss.
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  // Fire a request with the spoofed session cookie. The `await` is load-bearing: without it
  // `result` was read before Hono had necessarily run the handler, so the assertion was really
  // testing the initial `undefined` — and `undefined` is not `null`, so it only ever passed by
  // the accident of Hono dispatching synchronously. Every sibling [7x] test awaits; this one
  // was the odd one out.
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${cookieValue}` },
  }));

  // readSession must return null — the sub and email don't match the configured owner.
  expect(result).toBeNull();
});

// ── [7] Tampered session cookie ───────────────────────────────────────────────

test("[7a] a correctly signed session cookie for the owner is accepted by readSession", async () => {
  const validSession = {
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() + 90 * 24 * 3600 * 1000,
  };
  const cookieValue = makeSessionCookie(validSession);

  const app = new Hono();
  let result: ReturnType<typeof readSession> = undefined as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${cookieValue}` },
  }));

  expect(result).not.toBeNull();
  expect(result?.sub).toBe("owner-sub-123");
});

test("[7b] a tampered cookie (body flipped, MAC not updated) is rejected", async () => {
  const validSession = {
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() + 90 * 24 * 3600 * 1000,
  };
  const legitimate = makeSessionCookie(validSession);
  const [body, mac] = legitimate.split(".");
  // Flip last character of the body → HMAC mismatch.
  const flipped = body!.slice(0, -1) + (body!.slice(-1) === "A" ? "B" : "A");
  const tampered = `${flipped}.${mac}`;

  const app = new Hono();
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${tampered}` },
  }));

  expect(result).toBeNull();
});

test("[7c] a completely fabricated session cookie is rejected", async () => {
  // Construct a fake cookie without knowledge of the signing key.
  const fakeBody = Buffer.from(JSON.stringify({
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() + 9999999,
  })).toString("base64url");
  const fakeMac = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").toString("base64url");
  const fabricated = `${fakeBody}.${fakeMac}`;

  const app = new Hono();
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${fabricated}` },
  }));

  expect(result).toBeNull();
});

test("[7d] a session cookie with a valid MAC but expired exp is rejected", async () => {
  const expiredSession = {
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() - 1000, // 1 second in the past
  };
  const cookieValue = makeSessionCookie(expiredSession);

  const app = new Hono();
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${cookieValue}` },
  }));

  expect(result).toBeNull();
});

test("[7e] a session cookie with no exp field is rejected", async () => {
  const noExpSession = { sub: "owner-sub-123", email: "owner@example.com" };
  const cookieValue = makeSessionCookie(noExpSession);

  const app = new Hono();
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/", {
    headers: { cookie: `gm_session=${cookieValue}` },
  }));

  expect(result).toBeNull();
});

test("[7f] missing session cookie returns null (no crash)", async () => {
  const app = new Hono();
  let result: ReturnType<typeof readSession> = "initial" as unknown as ReturnType<typeof readSession>;
  app.get("/", (c) => {
    result = readSession(c, OWNER_OAUTH);
    return c.text("ok");
  });
  await app.request(new Request("http://localhost/"));

  expect(result).toBeNull();
});

// ── Bonus: authMiddleware integration with session cookie ─────────────────────

test("authMiddleware: a valid session cookie grants access in remote mode over tunnel", async () => {
  const validSession = {
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() + 90 * 24 * 3600 * 1000,
  };
  const cookieValue = makeSessionCookie(validSession);

  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    mode: "remote",
    oauth: OWNER_OAUTH,
  };
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));

  const res = await app.request(new Request("http://localhost/api/repos", {
    headers: {
      cookie: `gm_session=${cookieValue}`,
      "cf-connecting-ip": "203.0.113.7",
    },
  }));
  expect(res.status).toBe(200);
});

test("authMiddleware: a tampered session cookie is rejected in remote mode over tunnel", async () => {
  const validSession = {
    sub: "owner-sub-123",
    email: "owner@example.com",
    exp: Date.now() + 90 * 24 * 3600 * 1000,
  };
  const legitimate = makeSessionCookie(validSession);
  const [body, mac] = legitimate.split(".");
  const tampered = `${body!.slice(0, -1) + (body!.slice(-1) === "A" ? "B" : "A")}.${mac}`;

  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    mode: "remote",
    oauth: OWNER_OAUTH,
  };
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));

  const res = await app.request(new Request("http://localhost/api/repos", {
    headers: {
      cookie: `gm_session=${tampered}`,
      "cf-connecting-ip": "203.0.113.7",
    },
  }));
  expect(res.status).toBe(401);
});
