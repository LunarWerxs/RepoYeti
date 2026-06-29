import { test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  loadConfig,
  saveConfig,
  hydrateSecrets,
  namedTunnel,
  type RepoYetiConfig,
} from "../src/config.ts";
import { TUNNEL_READY_RE } from "../src/tunnel.ts";
import { getSecret, setSecret, deleteSecret, TUNNEL_TOKEN } from "../src/secrets.ts";

// ── namedTunnel() resolver — picks named vs quick from config + env ─────────────

/** Minimal valid config; spread overrides for each case. */
const base = (over: Partial<RepoYetiConfig> = {}): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...over,
});

/** Run `fn` with CF_TUNNEL_TOKEN set to `val` (or cleared), then restore it. */
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

test("namedTunnel: no tunnel config → null (use the quick tunnel)", () => {
  withEnvToken(undefined, () => expect(namedTunnel(base())).toBeNull());
});

test("namedTunnel: hostname OR token alone → null (needs both)", () => {
  withEnvToken(undefined, () => {
    expect(namedTunnel(base({ tunnel: { hostname: "app.repoyeti.com" } }))).toBeNull();
    expect(namedTunnel(base({ tunnel: { token: "tok" } }))).toBeNull();
  });
});

test("namedTunnel: hostname + token (config) → named, trimmed", () => {
  withEnvToken(undefined, () => {
    expect(
      namedTunnel(base({ tunnel: { hostname: "  app.repoyeti.com  ", token: "  tok  " } })),
    ).toEqual({ hostname: "app.repoyeti.com", token: "tok" });
  });
});

test("namedTunnel: CF_TUNNEL_TOKEN supplies/overrides the token (config keeps only hostname)", () => {
  // token only in env → still resolves
  withEnvToken("env-tok", () => {
    expect(namedTunnel(base({ tunnel: { hostname: "app.repoyeti.com" } }))).toEqual({
      hostname: "app.repoyeti.com",
      token: "env-tok",
    });
  });
  // env wins over a config token
  withEnvToken("env-tok", () => {
    expect(
      namedTunnel(base({ tunnel: { hostname: "app.repoyeti.com", token: "cfg-tok" } })),
    ).toEqual({ hostname: "app.repoyeti.com", token: "env-tok" });
  });
});

test("namedTunnel: provider 'quick' forces the quick tunnel even when both are set", () => {
  withEnvToken(undefined, () =>
    expect(
      namedTunnel(base({ tunnel: { provider: "quick", hostname: "app.repoyeti.com", token: "t" } })),
    ).toBeNull(),
  );
});

// ── TUNNEL_READY_RE — detects a named tunnel's "connection registered" log ──────

test("TUNNEL_READY_RE matches cloudflared edge-connection log lines", () => {
  expect(TUNNEL_READY_RE.test("2026-06-29T20:00:00Z INF Registered tunnel connection connIndex=0")).toBe(true);
  expect(TUNNEL_READY_RE.test("INF Connection 3f2a1b9c-7d4e-4a11-9b2c-aabbccddeeff registered connIndex=1")).toBe(true);
});

test("TUNNEL_READY_RE ignores unrelated output (incl. the quick-tunnel URL line)", () => {
  expect(TUNNEL_READY_RE.test("https://patent-shots-ranges-pill.trycloudflare.com")).toBe(false);
  expect(TUNNEL_READY_RE.test("INF Starting tunnel tunnelID=abc")).toBe(false);
});

// ── token at-rest handling — keychain-stored, stripped from config.json ─────────

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SVC = `repoyeti-test-${process.pid}`;

async function withService<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.REPOYETI_KEYCHAIN_SERVICE;
  process.env.REPOYETI_KEYCHAIN_SERVICE = SVC;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.REPOYETI_KEYCHAIN_SERVICE;
    else process.env.REPOYETI_KEYCHAIN_SERVICE = prev;
  }
}

const snapshot = (): string | null => (existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null);
const restore = (s: string | null): void => {
  if (s !== null) writeFileSync(CONFIG_PATH, s);
  else rmSync(CONFIG_PATH, { force: true });
};

const HAVE_KEYCHAIN = await withService(async () => {
  const ok = await setSecret("__probe__", "x");
  if (ok) await deleteSecret("__probe__");
  return ok;
});

test.skipIf(!HAVE_KEYCHAIN)(
  "hydrateSecrets moves a plaintext tunnel.token into the keychain and strips it from disk",
  async () => {
    const saved = snapshot();
    await withService(async () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          roots: [],
          port: 7171,
          maxDepth: 6,
          maxRepos: 200,
          tunnel: { hostname: "app.repoyeti.com", token: "cf-legacy-token" },
        }),
      );
      const cfg = loadConfig();
      expect(cfg.tunnel?.token).toBe("cf-legacy-token");

      await hydrateSecrets(cfg);

      // token now in the keychain…
      expect(await getSecret(TUNNEL_TOKEN)).toBe("cf-legacy-token");
      // …gone from disk, but the non-secret hostname stays…
      const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      expect(onDisk.tunnel.token).toBeUndefined();
      expect(onDisk.tunnel.hostname).toBe("app.repoyeti.com");
      // …and still usable in the live in-memory config.
      expect(cfg.tunnel?.token).toBe("cf-legacy-token");

      await deleteSecret(TUNNEL_TOKEN);
    });
    restore(saved);
  },
);

test("with the keychain disabled, saveConfig keeps tunnel.token on disk (no silent loss)", () => {
  const prevDisabled = process.env.REPOYETI_NO_KEYCHAIN;
  process.env.REPOYETI_NO_KEYCHAIN = "1";
  const saved = snapshot();
  try {
    const cfg = loadConfig();
    cfg.tunnel = { hostname: "app.repoyeti.com", token: "cf-fallback-token" };
    saveConfig(cfg);
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(onDisk.tunnel.token).toBe("cf-fallback-token");
  } finally {
    if (prevDisabled === undefined) delete process.env.REPOYETI_NO_KEYCHAIN;
    else process.env.REPOYETI_NO_KEYCHAIN = prevDisabled;
    restore(saved);
  }
});
