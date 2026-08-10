/**
 * The relay client's crypto and URL rules.
 *
 * The signature is the entire security story of the relay: it is what stops a stranger repointing
 * someone else's permanent link at their own server, which would turn a convenience feature into a
 * phishing kit. So these tests are mostly about what must NOT verify.
 *
 * They also pin the fragment placement of a share URL — the token lives after '#' precisely so the
 * relay can never see it, and a refactor that quietly moves it into the path would hand every share
 * token to the relay operator without any test failing otherwise.
 */
import { test, expect } from "bun:test";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import {
  createRelayIdentity,
  publicKeyFor,
  announcePayload,
  signAnnounce,
  announce,
  relayShareUrl,
} from "../src/relay.ts";

/** Rebuild a verifier key from the raw 32-byte public key the relay stores. */
function verifierFor(rawPublicKeyB64: string) {
  const raw = Buffer.from(rawPublicKeyB64, "base64url");
  // SPKI prefix for Ed25519, then the raw key — the inverse of the export in src/relay.ts.
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

test("an identity's stored keys agree with each other", () => {
  const id = createRelayIdentity();
  expect(id.id).toMatch(/^[a-f0-9]{32}$/);
  expect(publicKeyFor(id.privateKey)).toBe(id.publicKey);
});

test("two identities are distinct", () => {
  // The id is what appears in every share URL; a collision would cross two people's links.
  expect(createRelayIdentity().id).not.toBe(createRelayIdentity().id);
});

test("a signature verifies against the published public key", () => {
  const identity = createRelayIdentity();
  const ts = 1_700_000_000_000;
  const origin = "https://example.trycloudflare.com";
  const sig = signAnnounce(identity, origin, ts);

  const ok = nodeVerify(
    null,
    announcePayload(identity.id, origin, ts),
    verifierFor(identity.publicKey),
    Buffer.from(sig, "base64url"),
  );
  expect(ok).toBe(true);
});

test("a signature does not verify for a different origin", () => {
  // The attack this blocks: replay a captured announce with the address swapped for your own.
  const identity = createRelayIdentity();
  const ts = 1_700_000_000_000;
  const sig = signAnnounce(identity, "https://mine.trycloudflare.com", ts);

  const ok = nodeVerify(
    null,
    announcePayload(identity.id, "https://attacker.example", ts),
    verifierFor(identity.publicKey),
    Buffer.from(sig, "base64url"),
  );
  expect(ok).toBe(false);
});

test("a signature does not verify for a different id", () => {
  const a = createRelayIdentity();
  const b = createRelayIdentity();
  const ts = 1_700_000_000_000;
  const origin = "https://example.trycloudflare.com";
  const sig = signAnnounce(a, origin, ts);

  // Signing your own announce doesn't let you move somebody else's id.
  const ok = nodeVerify(
    null,
    announcePayload(b.id, origin, ts),
    verifierFor(a.publicKey),
    Buffer.from(sig, "base64url"),
  );
  expect(ok).toBe(false);
});

test("another key's signature is rejected", () => {
  const mine = createRelayIdentity();
  const theirs = createRelayIdentity();
  const ts = 1_700_000_000_000;
  const origin = "https://example.trycloudflare.com";

  const ok = nodeVerify(
    null,
    announcePayload(mine.id, origin, ts),
    verifierFor(mine.publicKey),
    Buffer.from(signAnnounce(theirs, origin, ts), "base64url"),
  );
  expect(ok).toBe(false);
});

test("announce refuses a non-https or malformed origin without calling out", async () => {
  const identity = createRelayIdentity();
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  expect((await announce("https://relay.example", identity, "http://insecure.example", spy)).ok).toBe(false);
  expect((await announce("https://relay.example", identity, "not a url", spy)).ok).toBe(false);
  expect(called).toBe(false);
});

test("announce sends the id, origin and signature — and nothing else", async () => {
  const identity = createRelayIdentity();
  let seen: { url: string; body: Record<string, unknown>; sig: string | null } | null = null;
  const spy = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      body: JSON.parse(String(init.body)),
      sig: new Headers(init.headers).get("x-signature"),
    };
    return new Response(
      JSON.stringify({
        ok: true,
        url: "https://relay.example/r/abc",
        capabilities: ["oauth-callback-v1", 42, null],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const res = await announce("https://relay.example/", identity, "https://host.trycloudflare.com/", spy);
  expect(res.ok).toBe(true);
  expect(res.capabilities).toEqual(["oauth-callback-v1"]);
  expect(seen!.url).toBe("https://relay.example/announce");
  expect(seen!.sig).toBeTruthy();
  // Exactly these four fields. Anything else would be data leaving a self-hosted tool.
  expect(Object.keys(seen!.body).sort()).toEqual(["id", "origin", "publicKey", "ts"]);
  expect(seen!.body.origin).toBe("https://host.trycloudflare.com"); // normalised, no trailing slash
});

test("a relay failure is reported, never thrown", async () => {
  // The relay is a convenience; it must never be able to break local git management.
  const identity = createRelayIdentity();
  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const res = await announce("https://relay.example", identity, "https://host.trycloudflare.com", boom);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("network down");
});

test("a legacy announce response remains successful for stable relay publishing", async () => {
  const identity = createRelayIdentity();
  const legacyWorker = (async () =>
    new Response(JSON.stringify({ ok: true, url: "https://relay.example/r/stable" }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const res = await announce("https://relay.example", identity, "https://named.example.com", legacyWorker);

  expect(res).toEqual({ ok: true, url: "https://relay.example/r/stable" });
});

test("the share token rides in the fragment, never the path", () => {
  const url = relayShareUrl("https://relay.example/", "abc123def456abc1", "SECRET_TOKEN");
  expect(url).toBe("https://relay.example/r/abc123def456abc1#/s/SECRET_TOKEN");

  // The part a browser actually transmits must not contain the token — this is the property that
  // makes "the relay cannot redeem your links" structural rather than a promise.
  const sent = url.split("#")[0]!;
  expect(sent).not.toContain("SECRET_TOKEN");
});
