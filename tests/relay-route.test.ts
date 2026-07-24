/**
 * The relay's OWNER-FACING surface: redactRelay() (the key-free view the Settings UI reads),
 * PUT /api/relay (the toggle itself), and the "which origin do we hand links out on" rule that
 * decides both what a minted share URL looks like and whether an old one is flagged stale.
 *
 * The load-bearing assertion in here is the negative one: the relay identity's PRIVATE key is what
 * proves only this machine may move its own forwarding address, so a response that leaked it would
 * let anyone repoint every share link already sent at a server of their choosing. Several tests
 * below check the serialized payload for those bytes rather than trusting the shape of a type.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { redactRelay, DEFAULT_RELAY_URL, type RepoYetiConfig } from "../src/config.ts";
import {
  ensureRelayIdentity,
  publicShareOrigin,
  shareLinkFor,
  getRelayBase,
} from "../src/runtime.ts";
import { createRelayIdentity, publicKeyFor } from "../src/relay.ts";
import { isStaleOrigin } from "../src/share/index.ts";

/** Minimal valid config; spread overrides for each case. */
const base = (over: Partial<RepoYetiConfig> = {}): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...over,
});

/** A config with the relay already on and an identity minted — the post-toggle steady state. */
function enabledCfg(url = "https://go.example.com"): RepoYetiConfig {
  const identity = createRelayIdentity();
  return base({ relay: { enabled: true, url, identity } });
}

async function putRelay(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request("/api/relay", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// ── redactRelay() — the key-free projection the UI reads ────────────────────────────

test("redactRelay: no relay config → ON by default (the stable address is the default), nothing configured", () => {
  // Default-on semantics (config.ts relayEffective): only an explicit `enabled: false`, or a
  // configured named tunnel, reads as off. An untouched config gets the hosted address.
  expect(redactRelay(base())).toEqual({
    enabled: true,
    url: null,
    id: null,
    defaultUrl: DEFAULT_RELAY_URL,
  });
});

test("redactRelay: exposes the public id but NEVER the private key", () => {
  const cfg = enabledCfg();
  const r = redactRelay(cfg);
  expect(r.enabled).toBe(true);
  expect(r.url).toBe("https://go.example.com");
  expect(r.id).toBe(cfg.relay?.identity?.id ?? null);
  // The whole point: the signing half stays on this machine.
  const priv = cfg.relay?.identity?.privateKey ?? "";
  expect(priv.length).toBeGreaterThan(0);
  expect(JSON.stringify(r)).not.toContain(priv);
});

test("ensureRelayIdentity preserves a valid pair and rotates a mismatched pair as one unit", async () => {
  const valid = createRelayIdentity();
  const validCfg = base({ relay: { enabled: true, identity: valid } });
  expect(await ensureRelayIdentity(validCfg)).toEqual(valid);

  const unrelated = createRelayIdentity();
  const brokenCfg = base({
    relay: {
      enabled: true,
      identity: { ...valid, privateKey: unrelated.privateKey },
    },
  });
  const repaired = await ensureRelayIdentity(brokenCfg);
  expect(repaired.id).not.toBe(valid.id);
  expect(repaired.publicKey).toBe(publicKeyFor(repaired.privateKey));
  expect(brokenCfg.relay?.identity).toEqual(repaired);
});

// ── PUT /api/relay ─────────────────────────────────────────────────────────────────

test("PUT /api/relay {enabled:true} with no URL adopts the default relay and mints an identity", async () => {
  const cfg = base();
  const res = await putRelay(createApp(cfg), { enabled: true });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.relay.enabled).toBe(true);
  expect(j.relay.url).toBe(DEFAULT_RELAY_URL);
  // The id is half the permanent URL, so it has to exist before the owner is shown one.
  expect(j.relay.id).toMatch(/^[a-f0-9]{32}$/);
  expect(j.relayUrl).toBe(`${DEFAULT_RELAY_URL}/r/${j.relay.id}`);
  expect(cfg.relay?.identity?.privateKey).toBeTruthy();
});

test("PUT /api/relay never returns the private key it just minted", async () => {
  const cfg = base();
  const res = await putRelay(createApp(cfg), { enabled: true });
  const body = await res.text();
  const priv = cfg.relay?.identity?.privateKey ?? "";
  expect(priv.length).toBeGreaterThan(0);
  expect(body).not.toContain(priv);
});

test("PUT /api/relay accepts a self-hosted relay URL and strips a trailing slash", async () => {
  const cfg = base();
  const j = await (await putRelay(createApp(cfg), { enabled: true, url: "https://go.example.com/" })).json();
  expect(j.relay.url).toBe("https://go.example.com");
  expect(j.relayUrl).toBe(`https://go.example.com/r/${j.relay.id}`);
});

test("PUT /api/relay rejects a non-https or path-bearing URL (BAD_REQUEST, 400)", async () => {
  for (const url of ["http://go.example.com", "https://go.example.com/sub", "not-a-url"]) {
    const res = await putRelay(createApp(base()), { enabled: true, url });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_REQUEST");
  }
});

test("PUT /api/relay {enabled:false} turns it off but KEEPS the identity", async () => {
  const cfg = enabledCfg();
  const idBefore = cfg.relay?.identity?.id;
  const j = await (await putRelay(createApp(cfg), { enabled: false })).json();
  expect(j.relay.enabled).toBe(false);
  expect(j.relayUrl).toBeNull();
  // Re-minting would register a NEW id on the relay and silently break every link already sent.
  expect(cfg.relay?.identity?.id).toBe(idBefore);
});

test("turning the relay off and on again keeps the same permanent URL", async () => {
  const cfg = base();
  const app = createApp(cfg);
  const first = await (await putRelay(app, { enabled: true })).json();
  await putRelay(app, { enabled: false });
  const again = await (await putRelay(app, { enabled: true })).json();
  expect(again.relayUrl).toBe(first.relayUrl);
});

test("GET /api/status carries the redacted relay for the owner, private key absent", async () => {
  const cfg = enabledCfg();
  const res = await createApp(cfg).request("/api/status");
  const body = await res.text();
  const st = JSON.parse(body);
  expect(st.relay.enabled).toBe(true);
  expect(st.relay.id).toBe(cfg.relay?.identity?.id);
  expect(st.relayUrl).toBe(`https://go.example.com/r/${cfg.relay?.identity?.id}`);
  expect(st.relayError).toBeNull();
  expect(body).not.toContain(cfg.relay?.identity?.privateKey ?? "__absent__");
});

// ── the origin links are handed out on ─────────────────────────────────────────────

test("getRelayBase: null when opted out or identity-less; the url falls back to the hosted default", () => {
  const identity = createRelayIdentity();
  // No identity yet (fresh daemon before its first announce) → no base, even though default-on.
  expect(getRelayBase(base())).toBeNull();
  // Explicit opt-out wins regardless of what else is configured.
  expect(getRelayBase(base({ relay: { enabled: false, url: "https://g.example.com", identity } }))).toBeNull();
  // Enabled + identity but NO url → the hosted default steps in (relayEffective's fallback).
  expect(getRelayBase(base({ relay: { enabled: true, identity } }))).toBe(
    `${DEFAULT_RELAY_URL}/r/${identity.id}`,
  );
  expect(getRelayBase(base({ relay: { enabled: true, url: "https://g.example.com" } }))).toBeNull();
  expect(getRelayBase(base({ relay: { enabled: true, url: "https://g.example.com", identity } }))).toBe(
    `https://g.example.com/r/${identity.id}`,
  );
});

test("publicShareOrigin falls back to the tunnel (null in-process) when the relay is off", () => {
  // No managed tunnel runs under test, so this is the honest "we don't know where we live" answer —
  // which isStaleOrigin treats as "cannot tell", NOT as "moved".
  expect(publicShareOrigin(base())).toBeNull();
});

test("publicShareOrigin is the permanent relay base once the relay is on", () => {
  const cfg = enabledCfg();
  expect(publicShareOrigin(cfg)).toBe(`https://go.example.com/r/${cfg.relay?.identity?.id}`);
});

test("shareLinkFor puts the token in the FRAGMENT when the relay is on", () => {
  const cfg = enabledCfg();
  const url = shareLinkFor(cfg, "tok123", "http://127.0.0.1:7171");
  expect(url).toBe(`https://go.example.com/r/${cfg.relay?.identity?.id}#/s/tok123`);
  // A fragment is never transmitted, so the relay cannot see — or redeem — what it forwards.
  // If this ever becomes a path, the relay operator receives every share token.
  expect(url.split("#")[0]).not.toContain("tok123");
});

test("shareLinkFor uses the caller's own origin when there is no relay and no tunnel", () => {
  expect(shareLinkFor(base(), "tok123", "http://127.0.0.1:7171")).toBe("http://127.0.0.1:7171/s/tok123");
});

// ── staleness, measured against the origin we actually hand out ─────────────────────

test("a relay-minted link is NOT stale after the tunnel address rotates", () => {
  const cfg = enabledCfg();
  const handedOut = publicShareOrigin(cfg); // what the share row records at mint
  // The tunnel moving underneath is exactly the event the relay exists to absorb: the relay base
  // is unchanged, so the link the recipient holds still resolves.
  expect(isStaleOrigin(handedOut, publicShareOrigin(cfg))).toBe(false);
});

test("a link minted BEFORE the relay was switched on is still flagged stale", () => {
  const cfg = enabledCfg();
  // Turning the relay on does not resurrect links that carry a dead trycloudflare hostname.
  expect(isStaleOrigin("https://old-host.trycloudflare.com", publicShareOrigin(cfg))).toBe(true);
});
