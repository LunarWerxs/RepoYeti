/**
 * The relay Worker itself, exercised in-process against a fake KV.
 *
 * Worth testing here rather than only after deploy: this is the piece that decides who may move a
 * daemon's address, and getting it wrong means anyone can repoint a link someone already trusts.
 * Bun's WebCrypto supports Ed25519, so the Worker's verification path runs for real — no mocking of
 * the security-critical part.
 */
import { test, expect, beforeEach } from "bun:test";
import worker from "../relay/worker.js";
import { createRelayIdentity, signAnnounce } from "../src/relay.ts";

/** Cloudflare KV, minus everything this Worker doesn't use. */
function fakeKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
  };
}

let env: { RELAY: ReturnType<typeof fakeKv> };
beforeEach(() => {
  env = { RELAY: fakeKv() };
});

function announceRequest(id: string, origin: string, ts: number, signature: string, publicKey?: string) {
  return new Request("https://relay.example/announce", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: JSON.stringify({ id, origin, ts, ...(publicKey ? { publicKey } : {}) }),
  });
}

async function register(identity = createRelayIdentity(), origin = "https://one.trycloudflare.com") {
  const ts = Date.now();
  const res = await worker.fetch(
    announceRequest(identity.id, origin, ts, signAnnounce(identity, origin, ts), identity.publicKey),
    env,
  );
  return { identity, res };
}

test("a first announce registers the daemon and pins its key", async () => {
  const { identity, res } = await register();
  expect(res.status).toBe(200);
  const stored = JSON.parse(env.RELAY.map.get(`d:${identity.id}`)!);
  expect(stored.origin).toBe("https://one.trycloudflare.com");
  expect(stored.publicKey).toBe(identity.publicKey);
});

test("the same daemon can move its own address", async () => {
  const { identity } = await register();
  const ts = Date.now();
  const next = "https://two.trycloudflare.com";
  const res = await worker.fetch(
    announceRequest(identity.id, next, ts, signAnnounce(identity, next, ts)),
    env,
  );
  expect(res.status).toBe(200);
  expect(JSON.parse(env.RELAY.map.get(`d:${identity.id}`)!).origin).toBe(next);
});

test("a stranger cannot move someone else's address, even with their own valid key", async () => {
  // THE attack this service must not permit: repointing a link the recipient already trusts.
  const { identity } = await register();
  const attacker = createRelayIdentity();
  const ts = Date.now();
  const evil = "https://attacker.example";

  const res = await worker.fetch(
    // Correctly signed — by the WRONG key — and offering a replacement publicKey.
    announceRequest(identity.id, evil, ts, signAnnounce(attacker, evil, ts), attacker.publicKey),
    env,
  );
  expect(res.status).toBe(401);
  expect(JSON.parse(env.RELAY.map.get(`d:${identity.id}`)!).origin).toBe("https://one.trycloudflare.com");
});

test("an unsigned announce is refused", async () => {
  const identity = createRelayIdentity();
  const ts = Date.now();
  const res = await worker.fetch(
    announceRequest(identity.id, "https://x.trycloudflare.com", ts, "", identity.publicKey),
    env,
  );
  expect(res.status).toBe(401);
});

test("an old announce is refused, so a captured one can't be replayed later", async () => {
  const identity = createRelayIdentity();
  const ts = Date.now() - 60 * 60 * 1000;
  const origin = "https://x.trycloudflare.com";
  const res = await worker.fetch(
    announceRequest(identity.id, origin, ts, signAnnounce(identity, origin, ts), identity.publicKey),
    env,
  );
  expect(res.status).toBe(400);
});

test("a non-https origin is refused", async () => {
  const identity = createRelayIdentity();
  const ts = Date.now();
  const origin = "http://plaintext.example";
  const res = await worker.fetch(
    announceRequest(identity.id, origin, ts, signAnnounce(identity, origin, ts), identity.publicKey),
    env,
  );
  expect(res.status).toBe(400);
});

test("opening a link serves a forwarding page that does not contain the token", async () => {
  const { identity } = await register();
  // The fragment is never transmitted, so the Worker sees only this:
  const res = await worker.fetch(new Request(`https://relay.example/r/${identity.id}`), env);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("https://one.trycloudflare.com");
  expect(body).toContain("location.replace");
});

test("a path after the id is a plain redirect", async () => {
  const { identity } = await register();
  const res = await worker.fetch(new Request(`https://relay.example/r/${identity.id}/dashboard`), env);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://one.trycloudflare.com/dashboard");
});

test("another RepoYeti can resolve a relay invitation without executing the forwarding page", async () => {
  const { identity } = await register();
  const res = await worker.fetch(new Request(`https://relay.example/resolve/${identity.id}`), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    origin: "https://one.trycloudflare.com",
  });
});

test("an unknown id gets a dead-end page, not a redirect", async () => {
  const res = await worker.fetch(new Request("https://relay.example/r/0123456789abcdef"), env);
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("isn't available");
});

test("a malformed id is rejected outright", async () => {
  const res = await worker.fetch(new Request("https://relay.example/r/../etc"), env);
  expect(res.status).toBe(404);
});

test("a stored origin that isn't https is never redirected to", async () => {
  // Defence in depth: even if a bad value reached KV somehow, it must not become a redirect.
  const id = "abcdef0123456789";
  env.RELAY.map.set(`d:${id}`, JSON.stringify({ publicKey: "x", origin: "javascript:alert(1)" }));
  const res = await worker.fetch(new Request(`https://relay.example/r/${id}`), env);
  expect(res.status).toBe(404);
});
