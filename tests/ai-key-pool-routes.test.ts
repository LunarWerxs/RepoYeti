/**
 * Route-level proof that the key-rotation pool (src/ai/credential-pool.ts) is actually wired into
 * GET /api/ai/providers/:provider/models, not just unit-tested in isolation. Every assertion here
 * would fail if the route went back to calling listModels() with a single bare key.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { type RepoYetiConfig } from "../src/config.ts";
import { aiKeyName, deleteSecret, aiKeyPoolName } from "../src/secrets.ts";
import { resetCredentialPools } from "../src/ai/credential-pool.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("PUT then GET /api/ai/providers/:provider/keys manages the pool and never leaks a key", async () => {
  resetCredentialPools();
  const cfg = localCfg();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const app = createApp(cfg);
    // Connect the primary key first - the pool route requires an already-connected provider.
    const connect = await post(app, "/api/ai/providers/groq/connect", { apiKey: "primary-key" });
    expect(connect.status).toBe(200);

    // No pool extras yet.
    const empty = await app.request("/api/ai/providers/groq/keys");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ provider: "groq", total: 1, available: 1 });

    // Add two extras (and resubmit the primary, which the handler must drop rather than double-count).
    const updated = await put(app, "/api/ai/providers/groq/keys", {
      apiKeys: ["primary-key", "extra-key-a", "extra-key-b"],
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.poolSize).toBe(2);
    expect(cfg.ai?.providers.groq?.apiKeys).toEqual(["extra-key-a", "extra-key-b"]);

    const snap = await app.request("/api/ai/providers/groq/keys");
    const snapBody = await snap.json();
    expect(snapBody.total).toBe(3); // primary + 2 extras
    expect(JSON.stringify(snapBody)).not.toContain("primary-key");
    expect(JSON.stringify(snapBody)).not.toContain("extra-key-a");
    expect(JSON.stringify(snapBody)).not.toContain("extra-key-b");

    // Replacing with an empty list clears the pool extras (and the keychain secret) entirely.
    const cleared = await put(app, "/api/ai/providers/groq/keys", { apiKeys: [] });
    expect((await cleared.json()).poolSize).toBe(0);
    expect(cfg.ai?.providers.groq?.apiKeys).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(aiKeyName("groq"));
    await deleteSecret(aiKeyPoolName("groq"));
  }
});

test("GET /api/ai/providers/:provider/models rotates to the pool's second key on a 429", async () => {
  resetCredentialPools();
  const cfg = localCfg();
  const originalFetch = globalThis.fetch;
  const okBody = JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] });
  const okInit = { status: 200, headers: { "content-type": "application/json" } };
  let calls = 0;
  const seenAuth: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seenAuth.push(auth);
    // Connect-time validation (call 1) must succeed regardless of which key is used, so the
    // provider actually gets saved - "dead-primary" only starts failing once it is the pool's
    // primary key being probed by a LATER /models call, which is the behavior under test.
    if (calls > 1 && auth.includes("dead-primary")) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(okBody, okInit);
  }) as typeof fetch;

  try {
    const app = createApp(cfg);
    const connect = await post(app, "/api/ai/providers/groq/connect", { apiKey: "dead-primary" });
    expect(connect.status).toBe(200);
    await put(app, "/api/ai/providers/groq/keys", { apiKeys: ["working-backup"] });
    seenAuth.length = 0; // only the /models call below is under test

    const res = await app.request("/api/ai/providers/groq/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.models).toEqual([{ id: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile" }]);
    // Proves rotation actually happened over the wire: the daemon tried the dead primary key
    // FIRST, then fell back to the working pool key - never the other order, and never only one.
    expect(seenAuth).toEqual(["Bearer dead-primary", "Bearer working-backup"]);
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(aiKeyName("groq"));
    await deleteSecret(aiKeyPoolName("groq"));
  }
});
