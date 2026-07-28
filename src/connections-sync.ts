/**
 * "Sync my settings with Connections" — the daemon-side Backend-for-Frontend (BFF).
 *
 * RepoYeti is a single-user local daemon, so the daemon IS the BFF: it holds the owner's
 * Connections `refresh_token` server-side (OS keychain), mints fresh
 * access tokens as needed, and calls the settings-sync store
 * (`studio.connections.icu/v1/app-data/{clientId}`).
 *
 * Since 2026-07-08 the token machinery is the OFFICIAL SDK — @cnct/connect (which also ships the
 * settings-sync store, formerly the separate @cnct/locker package) — instead of a hand-rolled
 * refresh loop: single-flight rotation-safe refresh (Connections rotates third-party refresh
 * tokens and family-revokes on replay), dead-session cleanup, and server-side revoke on forget all
 * come from the shared package. This module keeps only the
 * RepoYeti-specific parts: the KEYCHAIN persistence seam (the refresh token never touches disk in
 * plaintext; the access token lives in memory only), the settings allowlist, and the sync
 * orchestration. Interactive sign-in stays in src/auth.ts (the hardened OIDC module) — it hands the
 * verified owner's token set in through rememberTokens().
 *
 * NOTE: the sign-in client is PUBLIC (PKCE, no secret) — a configured `oauth.clientSecret` is no
 * longer used by the refresh path (the registered RepoYeti client was converted to public 2026-07-06).
 *
 * Off by default and additive: with `cfg.cloudSync.enabled` false (the default) nothing here runs.
 */
import type {
  ConnectClient,
  ConnectStore,
  SettingsSync,
  SettingsSyncStatus,
  TokenSet,
} from "@cnct/connect";
import {
  saveConfig,
  type RepoYetiConfig,
  type OAuthConfig,
  type CloudSyncConfig,
} from "./config.ts";
import { getSecret, setSecret, deleteSecret, CONNECTIONS_REFRESH_TOKEN } from "./secrets.ts";
import { broadcast } from "./bus.ts";

/** App-tier document we store (namespaced by the store itself as (sub, clientId), so no inner key). */
/**
 * The ONLY daemon-config keys that sync. Deliberately excludes machine-specific state (roots,
 * servers, port, maxDepth, maxRepos), the security-relevant access `mode`, unattended-action master
 * toggles (`autoCommit`, `autoCommitPush` — a fresh machine must not start pushing on its own), and
 * every secret (oauth, tunnel, ai keys, apiToken). What's left is portable UI/behaviour preference.
 */
const PREF_KEYS = [
  "diffStats",
  "changesStatDisplay",
  "changesChars",
  "remoteEditing",
  "diffPatchBytes",
  "diffPatchEnabled",
  "syncCheck",
  "syncIntervalSecs",
  "keepInSync",
  "autoCommitMode",
  "autoCommitIntervalSecs",
  "autoCommitAt",
  "autoCommitPull",
  "autoCommitAiFallback",
  "autoScan",
] as const satisfies readonly (keyof RepoYetiConfig)[];

// ── SDK session plumbing ──────────────────────────────────────────────────────────
// The SDK persists its session through a hybrid store: everything lives in MEMORY except the
// refresh token, which is mirrored to the OS KEYCHAIN (the one durable credential — exactly the
// pre-SDK behavior). A cold start synthesizes an expired token set from the keychain refresh
// token, so the first use forces a refresh and rotation flows back through this same seam.
let memory = new Map<string, string>();
let keychainRefresh: string | null = null;
let loaded = false;

const tokenKeyFor = (clientId: string): string => `cnx.connect.tokens.${clientId}`;

function storeFor(clientId: string): ConnectStore {
  const tokenKey = tokenKeyFor(clientId);
  return {
    get: (key) => {
      const hit = memory.get(key);
      if (hit !== undefined) return hit;
      if (key === tokenKey && keychainRefresh) {
        const seed = JSON.stringify({ accessToken: "", refreshToken: keychainRefresh, expiresAt: 0 } satisfies TokenSet);
        memory.set(key, seed);
        return seed;
      }
      return null;
    },
    set: async (key, value) => {
      memory.set(key, value);
      if (key !== tokenKey) return;
      try {
        const tokens = JSON.parse(value) as TokenSet;
        if (tokens.refreshToken && tokens.refreshToken !== keychainRefresh) {
          keychainRefresh = tokens.refreshToken;
          await setSecret(CONNECTIONS_REFRESH_TOKEN, tokens.refreshToken);
        }
      } catch {
        /* non-JSON writes (PKCE records) need no keychain mirror */
      }
    },
    remove: async (key) => {
      memory.delete(key);
      if (key === tokenKey && keychainRefresh) {
        keychainRefresh = null;
        await deleteSecret(CONNECTIONS_REFRESH_TOKEN);
      }
    },
  };
}

let client: ConnectClient | null = null;
let clientKey = "";
let settingsSync: SettingsSync | null = null;
let settingsSyncKey = "";
// The SDK is import()-ed lazily so a daemon that never syncs (cloudSync disabled, the default)
// never loads it — it only resolves on an actual sync/forget operation.
async function connectFor(oauth: OAuthConfig): Promise<ConnectClient> {
  const key = `${oauth.issuer.replace(/\/+$/, "")}|${oauth.clientId}`;
  if (!client || clientKey !== key) {
    const { createConnect } = await import("@cnct/connect");
    clientKey = key;
    client = createConnect({
      clientId: oauth.clientId,
      issuer: oauth.issuer,
      redirectUri: oauth.redirectUri || "http://127.0.0.1/oauth/callback",
      scopes: (oauth.scopes || "openid profile email").split(/\s+/).filter(Boolean),
      store: storeFor(oauth.clientId),
      // Late-bound so the test harness's globalThis.fetch stub is honored even though the
      // client is memoized across calls (the SDK captures `fetch` at construction). Cast: the
      // SDK only CALLS it — Bun's `typeof fetch` also declares a `preconnect` member.
      fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
    });
  }
  return client;
}

/** Load the persisted refresh token from the keychain into the session seam. Call once at daemon boot. */
export async function initCloudSync(): Promise<void> {
  if (loaded) return;
  loaded = true;
  keychainRefresh = await getSecret(CONNECTIONS_REFRESH_TOKEN);
}

/** True when the daemon holds a Connections credential it can sync with (a refresh or access token). */
export function hasConnection(): boolean {
  if (keychainRefresh) return true;
  for (const [key, value] of memory) {
    if (!key.startsWith("cnx.connect.tokens.")) continue;
    try {
      const tokens = JSON.parse(value) as TokenSet;
      if (tokens.refreshToken || tokens.accessToken) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * Retain the token set from a successful "Sign in with Connections" (wired via auth.ts `onTokens`).
 * Seeds the SDK session; the refresh token is mirrored to the keychain by the store seam above.
 */
export async function rememberTokens(
  tokens: { access_token?: string; refresh_token?: string; expires_in?: number },
  oauth: OAuthConfig,
): Promise<void> {
  loaded = true;
  // MERGE semantics: a partial set (e.g. an access token with no refresh_token) must never
  // clobber the durable refresh token already held — same contract as the pre-SDK module.
  const store = storeFor(oauth.clientId);
  const tokenKey = tokenKeyFor(oauth.clientId);
  let existing: TokenSet | null = null;
  try {
    const raw = await store.get(tokenKey);
    existing = raw ? (JSON.parse(raw) as TokenSet) : null;
  } catch {
    existing = null;
  }
  const seed: TokenSet = {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? existing?.refreshToken,
    expiresAt: tokens.access_token ? Date.now() + Math.max(0, (tokens.expires_in ?? 3600) - 60) * 1000 : 0,
  };
  await store.set(tokenKey, JSON.stringify(seed));
  // A successful callback can replace credentials while a client/engine from an earlier
  // signed-out or expired session is still memoized. Recreate both so the next operation reads
  // the just-persisted token set instead of spending a stale in-memory refresh token.
  settingsSync?.stop();
  settingsSync = null;
  settingsSyncKey = "";
  client = null;
  clientKey = "";
}

/** Forget the Connections connection entirely (memory + keychain). Used by "disconnect" / sign-out-all. */
export async function clearTokens(): Promise<void> {
  settingsSync?.stop();
  settingsSync = null;
  settingsSyncKey = "";
  memory = new Map();
  client = null;
  clientKey = "";
  keychainRefresh = null;
  await deleteSecret(CONNECTIONS_REFRESH_TOKEN);
}

// ── settings mapping (the allowlist) ─────────────────────────────────────────────
function collectPrefs(cfg: RepoYetiConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PREF_KEYS) {
    const v = cfg[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Apply an allowlisted prefs blob onto the live config (persisted). Ignores any key not on the
 *  allowlist, so a doc written by a newer/older app version can never inject arbitrary config. */
function applyPrefs(cfg: RepoYetiConfig, prefs: Record<string, unknown> | undefined): void {
  if (!prefs || typeof prefs !== "object") return;
  for (const k of PREF_KEYS) {
    if (k in prefs) {
      // Trusted-shape assignment: each key's type is fixed by RepoYetiConfig; the store only ever
      // holds values this same allowlist wrote. TS can't verify a heterogeneous-union write like
      // `cfg[k] = prefs[k]` is safe across a loop over `keyof RepoYetiConfig` even when `k`'s own
      // type is known (microsoft/TypeScript#30581) — the boundary cast is the honest option here.
      (cfg as unknown as Record<string, unknown>)[k] = prefs[k];
    }
  }
}

function ensureBlock(cfg: RepoYetiConfig): CloudSyncConfig {
  if (!cfg.cloudSync) cfg.cloudSync = {};
  return cfg.cloudSync;
}

// ── public sync operations ───────────────────────────────────────────────────────

export interface SyncStatus {
  enabled: boolean;
  /** The daemon holds a Connections credential (owner has signed in). */
  connected: boolean;
  lastSyncedAt: string | null;
  version: number;
  /** The last-synced appearance blob so a fresh web load can apply the synced look immediately. */
  appearance: Record<string, unknown> | null;
}

export function syncStatus(cfg: RepoYetiConfig): SyncStatus {
  const b = cfg.cloudSync ?? {};
  return {
    enabled: b.enabled === true,
    connected: hasConnection(),
    lastSyncedAt: b.lastSyncedAt ?? null,
    version: b.version ?? 0,
    appearance: b.appearance ?? null,
  };
}

function recordEngineStatus(cfg: RepoYetiConfig, status: SettingsSyncStatus): void {
  const block = ensureBlock(cfg);
  if (status.version !== null) block.version = status.version;
  if (status.lastSyncedAt !== null) {
    block.lastSyncedAt = new Date(status.lastSyncedAt).toISOString();
  }
  if (status.version !== null || status.lastSyncedAt !== null) saveConfig(cfg);
}

async function syncEngine(cfg: RepoYetiConfig, oauth: OAuthConfig): Promise<SettingsSync> {
  const key = `${oauth.issuer.replace(/\/+$/, "")}|${oauth.clientId}`;
  if (settingsSync && settingsSyncKey === key) return settingsSync;
  settingsSync?.stop();
  const { createSettingsSync } = await import("@cnct/connect");
  const connectClient = await connectFor(oauth);
  settingsSyncKey = key;
  settingsSync = createSettingsSync(connectClient.locker(), {
    // Preserve the existing { prefs, appearance } document used by real accounts.
    keys: ["prefs", "appearance"],
    read: () => {
      const block = ensureBlock(cfg);
      return {
        prefs: collectPrefs(cfg),
        ...(block.appearance ? { appearance: block.appearance } : {}),
      };
    },
    write: (patch) => {
      const block = ensureBlock(cfg);
      const prefs =
        patch.prefs && typeof patch.prefs === "object"
          ? (patch.prefs as Record<string, unknown>)
          : undefined;
      applyPrefs(cfg, prefs);
      if (patch.appearance && typeof patch.appearance === "object") {
        block.appearance = patch.appearance as Record<string, unknown>;
      }
      saveConfig(cfg);
      broadcast("settings_changed", { cloudSync: true });
    },
    onStatus: (status) => recordEngineStatus(cfg, status),
  });
  return settingsSync;
}

function requireSuccess(status: SettingsSyncStatus): SettingsSyncStatus {
  if (status.state === "synced") return status;
  if (status.state === "signed-out") {
    const error = new Error("not_signed_in") as Error & { code?: string };
    error.code = "not_signed_in";
    throw error;
  }
  throw status.error ?? new Error(`settings sync ended in ${status.state}`);
}

/** Flush the current allowlisted settings immediately. */
export async function pushNow(cfg: RepoYetiConfig, oauth: OAuthConfig): Promise<void> {
  requireSuccess(await (await syncEngine(cfg, oauth)).flush());
}

/** Pull the remote settings and apply the allowlisted subset locally. Returns whether anything was
 *  applied (a never-written remote doc has version 0 and applies nothing). */
export async function pullNow(cfg: RepoYetiConfig, oauth: OAuthConfig): Promise<{ applied: boolean; version: number }> {
  const status = requireSuccess(await (await syncEngine(cfg, oauth)).pull());
  const version = status.version ?? 0;
  return { applied: version > 0, version };
}

/** Turn sync on: pull the remote doc (applying it) or, if the remote is empty, seed it from local. */
export async function enable(cfg: RepoYetiConfig, oauth: OAuthConfig, appearance?: Record<string, unknown>): Promise<SyncStatus> {
  const b = ensureBlock(cfg);
  b.enabled = true;
  if (appearance) b.appearance = appearance;
  saveConfig(cfg);
  if (hasConnection()) {
    requireSuccess(await (await syncEngine(cfg, oauth)).hydrate({ seedIfEmpty: true }));
  }
  return syncStatus(cfg);
}

/** Turn sync off. `forget` also disconnects (revokes the grant server-side + clears tokens) and
 *  deletes the remote document. */
export async function disable(cfg: RepoYetiConfig, oauth: OAuthConfig, opts: { forget?: boolean } = {}): Promise<SyncStatus> {
  const b = ensureBlock(cfg);
  b.enabled = false;
  settingsSync?.stop();
  if (opts.forget) {
    if (hasConnection()) {
      try {
        await (settingsSync ?? (await syncEngine(cfg, oauth))).locker.delete();
      } catch {
        /* best-effort remote wipe — local disconnect proceeds regardless */
      }
      try {
        // RFC 7009 hygiene: kill the refresh-token family server-side, not just locally.
        await (await connectFor(oauth)).signOut({ revoke: true });
      } catch {
        /* best-effort — clearTokens below is the authoritative local cleanup */
      }
    }
    await clearTokens();
    b.version = 0;
    delete b.appearance;
    delete b.lastSyncedAt;
  }
  settingsSync = null;
  settingsSyncKey = "";
  saveConfig(cfg);
  return syncStatus(cfg);
}

/** The web changed appearance; the SDK engine owns debounce/coalescing. */
export async function updateAppearance(cfg: RepoYetiConfig, oauth: OAuthConfig, appearance: Record<string, unknown>): Promise<void> {
  const b = ensureBlock(cfg);
  b.appearance = appearance;
  saveConfig(cfg);
  if (b.enabled && hasConnection()) (await syncEngine(cfg, oauth)).push();
}

/** Flush a pending debounce before daemon shutdown/relaunch. */
export async function flushPending(cfg: RepoYetiConfig): Promise<void> {
  if (cfg.cloudSync?.enabled && cfg.oauth && hasConnection()) {
    requireSuccess(await (await syncEngine(cfg, cfg.oauth)).flushAndStop({ timeoutMs: 5_000 }));
  }
}
