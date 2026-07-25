import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { resolveApiKey, type RepoYetiConfig } from "../src/config.ts";
import { aiKeyName, deleteSecret, getSecret, setSecret } from "../src/secrets.ts";

// Local mode (no OIDC) → /api/* is not gated, so we can exercise the AI routes directly.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /api/ai/settings starts with no configured AI provider", async () => {
  const res = await createApp(localCfg()).request("/api/ai/settings");
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.defaultProvider).toBeNull();
  expect(j.providers.groq).toBeUndefined();
  expect(j.style).toBe("conventional");
  expect(JSON.stringify(j)).not.toContain("apiKey");
});

test("connect with an empty key is rejected before any network call", async () => {
  const res = await post(createApp(localCfg()), "/api/ai/providers/openai/connect", {});
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("NO_KEY");
});

test("compatible connect requires a manual model and a safe API-root URL", async () => {
  const app = createApp(localCfg());
  const noModel = await post(app, "/api/ai/providers/compatible/connect", {
    apiKey: "owner-key",
    baseUrl: "https://gateway.example.test/v1",
  });
  expect(noModel.status).toBe(400);
  expect((await noModel.json()).code).toBe("AI_BAD_REQUEST");

  const operationUrl = await post(app, "/api/ai/providers/compatible/connect", {
    apiKey: "owner-key",
    baseUrl: "https://gateway.example.test/v1/chat/completions",
    model: "manual-chat",
  });
  expect(operationUrl.status).toBe(400);
  expect((await operationUrl.json()).code).toBe("AI_BAD_REQUEST");

  const remoteWithoutKey = await post(app, "/api/ai/providers/compatible/connect", {
    baseUrl: "https://gateway.example.test/v1",
    model: "manual-chat",
  });
  expect(remoteWithoutKey.status).toBe(400);
  expect((await remoteWithoutKey.json()).code).toBe("NO_KEY");
});

test("compatible loopback connect may omit a key and never emits an Authorization header", async () => {
  const cfg = localCfg();
  const originalFetch = globalThis.fetch;
  let authHeader: string | null = "not-called";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authHeader = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ data: [{ id: "local-chat" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await setSecret(aiKeyName("compatible"), "stale-key");
    const app = createApp(cfg);
    const res = await post(app, "/api/ai/providers/compatible/connect", {
      baseUrl: "http://localhost:11434/v1/",
      model: "local-chat",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(authHeader).toBeNull();
    expect(body.settings.providers.compatible).toEqual({
      configured: true,
      model: "local-chat",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(body.settings.defaultProvider).toBe("compatible");
    expect(cfg.ai?.providers.compatible).toMatchObject({
      model: "local-chat",
      baseUrl: "http://localhost:11434/v1",
      noAuth: true,
    });
    expect(cfg.ai?.providers.compatible?.apiKey).toBeUndefined();
    expect(await getSecret(aiKeyName("compatible"))).toBeNull();

    const availability = await app.request("/api/ai/availability");
    expect(await availability.json()).toEqual({ usable: true, commitEnabled: true });
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(aiKeyName("compatible"));
  }
});

test("compatible connect persists a normalized destination and falls back when /models is absent", async () => {
  const cfg = localCfg();
  const originalFetch = globalThis.fetch;
  let sentUrl = "";
  let sentInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sentUrl = String(input);
    sentInit = init;
    return new Response(JSON.stringify({ error: { message: "models route not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const app = createApp(cfg);
    const res = await post(app, "/api/ai/providers/compatible/connect", {
      apiKey: "owner-key",
      baseUrl: "https://gateway.example.test/openai/v1/",
      model: "manual-chat",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discoveryAvailable).toBe(false);
    expect(body.models).toEqual([{ id: "manual-chat", label: "manual-chat" }]);
    expect(body.settings.providers.compatible).toEqual({
      configured: true,
      model: "manual-chat",
      baseUrl: "https://gateway.example.test/openai/v1",
    });
    expect(JSON.stringify(body)).not.toContain("owner-key");
    expect(sentUrl).toBe("https://gateway.example.test/openai/v1/models");
    expect(sentInit?.redirect).toBe("error");
    expect(cfg.ai?.providers.compatible?.baseUrl).toBe(
      "https://gateway.example.test/openai/v1",
    );
    expect(resolveApiKey(cfg, "compatible")).toBe("owner-key");

    const refreshed = await app.request("/api/ai/providers/compatible/models");
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      discoveryAvailable: false,
      models: [{ id: "manual-chat", label: "manual-chat" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(aiKeyName("compatible"));
  }
});

test("compatible connect does not save a key that /models explicitly rejects", async () => {
  const cfg = localCfg();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ error: { message: "no" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const res = await post(createApp(cfg), "/api/ai/providers/compatible/connect", {
      apiKey: "rejected-key",
      baseUrl: "https://gateway.example.test/v1",
      model: "manual-chat",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AI_AUTH_FAILED");
    expect(resolveApiKey(cfg, "compatible")).toBeNull();
    expect(cfg.ai?.providers.compatible).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
    await deleteSecret(aiKeyName("compatible"));
  }
});

test("connect to an unknown provider → 404 BAD_PROVIDER", async () => {
  const res = await post(createApp(localCfg()), "/api/ai/providers/bogus/connect", { apiKey: "x" });
  expect(res.status).toBe(404);
  expect((await res.json()).code).toBe("BAD_PROVIDER");
});

test("commit-message refuses to run until an AI provider is configured", async () => {
  const res = await post(createApp(localCfg()), "/api/repos/whatever/commit-message", {});
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("NO_AI_PROVIDER");
});

test("setting a default provider that has no key is refused", async () => {
  const res = await createApp(localCfg()).request("/api/ai/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultProvider: "openai" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("NOT_CONFIGURED");
});
