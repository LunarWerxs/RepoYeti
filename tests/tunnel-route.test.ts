import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { redactTunnel, type RepoYetiConfig } from "../src/config.ts";
import { getSecret, TUNNEL_TOKEN } from "../src/secrets.ts";

// Covers the named-tunnel "stable address" surface: redactTunnel() (the key-free view the UI reads)
// and PUT /api/tunnel (set / clear / leave-unchanged + bad-input guard). The token bytes must never
// leave the keychain — only presence flags travel over the wire.

/** Minimal valid config; spread overrides for each case. */
const base = (over: Partial<RepoYetiConfig> = {}): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...over,
});

/** Run `fn` with CF_TUNNEL_TOKEN set (or cleared), then restore it. */
function withEnvToken<T>(val: string | undefined, fn: () => T): T {
  const prev = process.env.CF_TUNNEL_TOKEN;
  if (val === undefined) delete process.env.CF_TUNNEL_TOKEN;
  else process.env.CF_TUNNEL_TOKEN = val;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CF_TUNNEL_TOKEN;
    else process.env.CF_TUNNEL_TOKEN = prev;
  }
}

/** Drive the route + secret ops against a process-local in-memory keychain under a unique service,
 *  so the token path runs headlessly without touching the real OS store (or other tests' secrets). */
async function withMemKeychain<T>(fn: () => Promise<T>): Promise<T> {
  const prevMem = process.env.REPOYETI_KEYCHAIN_MEMORY;
  const prevSvc = process.env.REPOYETI_KEYCHAIN_SERVICE;
  process.env.REPOYETI_KEYCHAIN_MEMORY = "1";
  process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-tunnel-test-${process.pid}`;
  try {
    return await fn();
  } finally {
    if (prevMem === undefined) delete process.env.REPOYETI_KEYCHAIN_MEMORY;
    else process.env.REPOYETI_KEYCHAIN_MEMORY = prevMem;
    if (prevSvc === undefined) delete process.env.REPOYETI_KEYCHAIN_SERVICE;
    else process.env.REPOYETI_KEYCHAIN_SERVICE = prevSvc;
  }
}

async function putTunnel(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request("/api/tunnel", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// ── redactTunnel() — the key-free projection the UI reads ────────────────────────────

test("redactTunnel: no tunnel config → empty/false everywhere", () => {
  withEnvToken(undefined, () =>
    expect(redactTunnel(base())).toEqual({
      hostname: null,
      hasToken: false,
      tokenFromEnv: false,
      named: false,
    }),
  );
});

test("redactTunnel: hostname + config token → named, hasToken, no env flag (token bytes never appear)", () => {
  withEnvToken(undefined, () => {
    const r = redactTunnel(base({ tunnel: { hostname: "app.repoyeti.com", token: "cf-secret" } }));
    expect(r).toEqual({ hostname: "app.repoyeti.com", hasToken: true, tokenFromEnv: false, named: true });
    // belt-and-suspenders: the serialized view carries no token field of any name.
    expect(JSON.stringify(r)).not.toContain("cf-secret");
  });
});

test("redactTunnel: CF_TUNNEL_TOKEN env supplies the token → tokenFromEnv + named with hostname alone", () => {
  withEnvToken("env-tok", () =>
    expect(redactTunnel(base({ tunnel: { hostname: "app.repoyeti.com" } }))).toEqual({
      hostname: "app.repoyeti.com",
      hasToken: true,
      tokenFromEnv: true,
      named: true,
    }),
  );
});

// ── PUT /api/tunnel ───────────────────────────────────────────────────────────────

test("PUT /api/tunnel sets a stable hostname + token (keychain-stored, never echoed) and /api/status reflects it", async () => {
  await withEnvToken(undefined, () =>
    withMemKeychain(async () => {
      const cfg = base();
      const app = createApp(cfg);

      const res = await putTunnel(app, { hostname: "app.repoyeti.com", token: "cf-tok" });
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.tunnel).toEqual({
        hostname: "app.repoyeti.com",
        hasToken: true,
        tokenFromEnv: false,
        named: true,
      });
      // the token went to the keychain, not the response…
      expect(JSON.stringify(j)).not.toContain("cf-tok");
      expect(await getSecret(TUNNEL_TOKEN)).toBe("cf-tok");
      // …and the in-memory config carries it for this running daemon.
      expect(cfg.tunnel?.token).toBe("cf-tok");

      // GET /api/status shows the same redacted view on a fresh load.
      const st = await (await app.request("/api/status")).json();
      expect(st.tunnel).toEqual({
        hostname: "app.repoyeti.com",
        hasToken: true,
        tokenFromEnv: false,
        named: true,
      });
    }),
  );
});

test("PUT /api/tunnel with hostname only leaves the saved token untouched", async () => {
  await withEnvToken(undefined, () =>
    withMemKeychain(async () => {
      const cfg = base();
      const app = createApp(cfg);
      await putTunnel(app, { hostname: "h1.example.com", token: "keep-me" });

      const res = await putTunnel(app, { hostname: "h2.example.com" }); // token omitted = leave
      const j = await res.json();
      expect(j.tunnel.hostname).toBe("h2.example.com");
      expect(j.tunnel.hasToken).toBe(true);
      expect(cfg.tunnel?.token).toBe("keep-me");
    }),
  );
});

test("PUT /api/tunnel with empty strings clears both fields + drops the keychain token", async () => {
  await withEnvToken(undefined, () =>
    withMemKeychain(async () => {
      const cfg = base();
      const app = createApp(cfg);
      await putTunnel(app, { hostname: "app.repoyeti.com", token: "cf-tok" });
      expect(await getSecret(TUNNEL_TOKEN)).toBe("cf-tok");

      const res = await putTunnel(app, { hostname: "", token: "" });
      const j = await res.json();
      expect(j.tunnel).toEqual({ hostname: null, hasToken: false, tokenFromEnv: false, named: false });
      // emptied-out block is collapsed, and the keychain token is gone.
      expect(cfg.tunnel).toBeUndefined();
      expect(await getSecret(TUNNEL_TOKEN)).toBeNull();
    }),
  );
});

test("PUT /api/tunnel rejects a hostname that isn't a bare host (BAD_REQUEST, 400)", async () => {
  const res = await putTunnel(createApp(base()), { hostname: "https://nope.example.com/path" });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});
