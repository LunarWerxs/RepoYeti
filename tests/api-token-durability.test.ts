/**
 * Durable revocation + honest replacement of the optional API Bearer token (audit item 5).
 *
 * The defect these guard against was traced statically during the 1.0 audit: `deleteSecret`
 * swallowed a refused keychain delete, so DELETE /api/auth/token and "sign out everywhere" cleared
 * only the in-memory copy, answered `ok`, and the next daemon boot hydrated the SAME token back out
 * of the keychain. Mint likewise discarded `setSecret`'s boolean, so it could hand out a token that
 * died with the process while the old one lived on. Neither route saved the config, so on a
 * keychain-less host a mint was not durable until some unrelated setting happened to be saved.
 *
 * "Restart" is simulated the way the daemon does it: `loadConfig()` from disk, then
 * `hydrateSecrets()`. A failing credential store is injected through the seam in src/secrets.ts
 * on top of the suite's in-memory store (tests/setup.ts: REPOYETI_KEYCHAIN_MEMORY=1) — no OS
 * credential store is ever touched. Each test snapshots and restores config.json, because the
 * whole suite shares one REPOYETI_HOME.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { CONFIG_DIR, hydrateSecrets, loadConfig, saveConfig, type RepoYetiConfig } from "../src/config.ts";
import { API_TOKEN, deleteSecret, getSecret, setSecret, setSecretStoreForTests } from "../src/secrets.ts";

const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const localCfg = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  ...extra,
});
const onDisk = (): Partial<RepoYetiConfig> =>
  existsSync(CONFIG_PATH) ? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<RepoYetiConfig>) : {};

const refuse = async (): Promise<never> => {
  throw new Error("credential store: access denied");
};

let savedConfig: string | null = null;
let restoreStore: (() => void) | null = null;
const ORIG_NO_KEYCHAIN = process.env.REPOYETI_NO_KEYCHAIN;

beforeEach(() => {
  savedConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
});
afterEach(async () => {
  restoreStore?.();
  restoreStore = null;
  if (ORIG_NO_KEYCHAIN === undefined) delete process.env.REPOYETI_NO_KEYCHAIN;
  else process.env.REPOYETI_NO_KEYCHAIN = ORIG_NO_KEYCHAIN;
  await deleteSecret(API_TOKEN);
  if (savedConfig !== null) writeFileSync(CONFIG_PATH, savedConfig);
  else rmSync(CONFIG_PATH, { force: true });
});

test("revoke: a store that refuses the delete cannot bring the token back at the next boot", async () => {
  const cfg = localCfg();
  expect(await setSecret(API_TOKEN, "old-token")).toBe(true);
  cfg.apiToken = "old-token";
  saveConfig(cfg); // keychain confirmed → the token is stripped from disk, exactly as in production

  restoreStore = setSecretStoreForTests({ delete: refuse });
  const app = createApp(cfg);
  const res = await app.request("/api/auth/token", { method: "DELETE" });
  expect(res.status).toBe(200);
  // Honest: durable (a tombstone protects the restart) but the keychain bytes are still there.
  expect(await res.json()).toMatchObject({ ok: true, durable: true, keychainCleared: false });
  // Live access ended immediately…
  expect(cfg.apiToken).toBeUndefined();
  expect((await app.request("/api/auth/token")).json()).resolves.toEqual({ ok: true, configured: false });
  // …even though the store still holds the bytes — this is the state that used to resurrect it.
  expect(await getSecret(API_TOKEN)).toBe("old-token");

  // RESTART with the store still refusing: the tombstone is on disk, hydration loads nothing.
  const rebooted = loadConfig();
  expect(rebooted.apiTokenRevoked).toBe(true);
  await hydrateSecrets(rebooted);
  expect(rebooted.apiToken).toBeUndefined();
  expect(loadConfig().apiTokenRevoked).toBe(true); // still refused → tombstone kept

  // The store recovers: the next boot retries the delete, clears the tombstone, and persists that.
  restoreStore();
  restoreStore = null;
  const later = loadConfig();
  await hydrateSecrets(later);
  expect(later.apiToken).toBeUndefined();
  expect(later.apiTokenRevoked).toBeUndefined();
  expect(await getSecret(API_TOKEN)).toBeNull();
  expect(loadConfig().apiTokenRevoked).toBeUndefined();
});

test("sign out everywhere: the same refused delete is tombstoned, not swallowed", async () => {
  const cfg = localCfg();
  expect(await setSecret(API_TOKEN, "old-token")).toBe(true);
  cfg.apiToken = "old-token";
  saveConfig(cfg);

  restoreStore = setSecretStoreForTests({ delete: refuse });
  const res = await createApp(cfg).request("/api/auth/logout-all", { method: "POST" });
  expect(res.status).toBe(200);
  expect(cfg.apiToken).toBeUndefined();
  expect(onDisk().apiTokenRevoked).toBe(true);
  const rebooted = loadConfig();
  await hydrateSecrets(rebooted);
  expect(rebooted.apiToken).toBeUndefined();
});

test("mint: a store that refuses the write falls back to config.json, says so, and the old token is gone", async () => {
  const cfg = localCfg();
  expect(await setSecret(API_TOKEN, "old-token")).toBe(true);
  cfg.apiToken = "old-token";
  saveConfig(cfg);

  restoreStore = setSecretStoreForTests({ set: refuse });
  const app = createApp(cfg);
  const res = await app.request("/api/auth/token", { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; token: string; store: string };
  expect(body.ok).toBe(true);
  expect(body.store).toBe("config");
  expect(cfg.apiToken).toBe(body.token);
  expect(body.token).not.toBe("old-token");
  // Durable through the degraded path: the new token is on disk (owner-only file), so a restart
  // keeps it — and the plaintext copy wins over the stale keychain slot during hydration.
  expect(onDisk().apiToken).toBe(body.token);
  const rebooted = loadConfig();
  await hydrateSecrets(rebooted);
  expect(rebooted.apiToken).toBe(body.token);

  // The store recovers: boot migrates the plaintext token into the keychain and strips the file,
  // overwriting the old token's slot — the replacement is now complete everywhere.
  restoreStore();
  restoreStore = null;
  const later = loadConfig();
  await hydrateSecrets(later);
  expect(later.apiToken).toBe(body.token);
  expect(await getSecret(API_TOKEN)).toBe(body.token);
  expect(onDisk().apiToken).toBeUndefined();
});

test("mint after a tombstoned revoke: a successful write retires the tombstone", async () => {
  const cfg = localCfg();
  expect(await setSecret(API_TOKEN, "old-token")).toBe(true);
  cfg.apiToken = "old-token";
  restoreStore = setSecretStoreForTests({ delete: refuse });
  const app = createApp(cfg);
  await app.request("/api/auth/token", { method: "DELETE" });
  expect(cfg.apiTokenRevoked).toBe(true);
  restoreStore();
  restoreStore = null;

  const res = await app.request("/api/auth/token", { method: "POST" });
  const body = (await res.json()) as { token: string; store: string };
  expect(body.store).toBe("keychain");
  expect(cfg.apiTokenRevoked).toBeUndefined();
  expect(onDisk().apiTokenRevoked).toBeUndefined();
  // And the next boot loads the NEW token, not nothing (a stale tombstone would have deleted it).
  const rebooted = loadConfig();
  await hydrateSecrets(rebooted);
  expect(rebooted.apiToken).toBe(body.token);
});

test("with no keychain at all (REPOYETI_NO_KEYCHAIN=1) mint and revoke are durable through config.json", async () => {
  process.env.REPOYETI_NO_KEYCHAIN = "1";
  const cfg = localCfg();
  const app = createApp(cfg);

  const minted = (await (await app.request("/api/auth/token", { method: "POST" })).json()) as {
    token: string;
    store: string;
  };
  expect(minted.store).toBe("config");
  expect(onDisk().apiToken).toBe(minted.token);
  const afterMint = loadConfig();
  await hydrateSecrets(afterMint);
  expect(afterMint.apiToken).toBe(minted.token);

  const revoked = await app.request("/api/auth/token", { method: "DELETE" });
  expect(await revoked.json()).toEqual({ ok: true, durable: true, keychainCleared: true });
  expect(onDisk().apiToken).toBeUndefined();
  expect(onDisk().apiTokenRevoked).toBeUndefined(); // nothing to tombstone: there is no store
  const afterRevoke = loadConfig();
  await hydrateSecrets(afterRevoke);
  expect(afterRevoke.apiToken).toBeUndefined();
});
