/**
 * OS keychain boundary — the one place owner secrets are read/written at rest.
 *
 * Backed by **`Bun.secrets`**, which is built into the Bun runtime and talks to the
 * platform credential store directly (Windows Credential Manager / macOS Keychain /
 * Linux libsecret). That means: no native addon to compile or ship, no `bun --compile`
 * caveat, and no bespoke crypto to maintain — exactly the "simple, low-maintenance"
 * posture we want. Secrets the daemon must persist (AI provider API keys, an optional
 * confidential OAuth `client_secret`) live HERE, never in `~/.repoyeti/config.json`.
 *
 * Graceful degradation: if the OS secret service isn't available (e.g. a headless Linux
 * box with no libsecret), every call becomes a no-op + a one-time warning and the daemon
 * keeps its previous plaintext-config behavior (see config.ts `stripSecretsForDisk`,
 * which only strips when `keychainAvailable()` is true). Nothing breaks; that host just
 * isn't keychain-protected.
 */
import { secrets } from "bun";

/** Keychain "service" namespace. Overridable so tests don't touch the real `repoyeti` store.
 *  Read per call (not at import) so a test can set it before exercising the boundary. */
const service = (): string => process.env.REPOYETI_KEYCHAIN_SERVICE ?? "repoyeti";
/** Escape hatch (tests / odd environments): force the plaintext-config fallback path. */
const disabled = (): boolean => process.env.REPOYETI_NO_KEYCHAIN === "1";

/**
 * The raw backing store the secret ops talk to. Normally `Bun.secrets` (the OS credential
 * store). `REPOYETI_KEYCHAIN_MEMORY=1` swaps in a process-local in-memory store so a headless
 * box with no OS secret service (CI) can still exercise the full set/get/delete + legacy-rehome
 * logic — the OS path stays covered by the keychain-gated tests on a host that has one.
 */
interface RawStore {
  get(svc: string, name: string): Promise<string | null | undefined>;
  set(svc: string, name: string, value: string): Promise<void>;
  delete(svc: string, name: string): Promise<void>;
}
const osStore: RawStore = {
  get: (svc, name) => secrets.get({ service: svc, name }),
  set: async (svc, name, value) => {
    await secrets.set({ service: svc, name, value });
  },
  delete: async (svc, name) => {
    await secrets.delete({ service: svc, name });
  },
};
const memMap = new Map<string, string>();
const memStore: RawStore = {
  get: async (svc, name) => memMap.get(`${svc}\0${name}`) ?? null,
  set: async (svc, name, value) => void memMap.set(`${svc}\0${name}`, value),
  delete: async (svc, name) => void memMap.delete(`${svc}\0${name}`),
};
const store = (): RawStore => (process.env.REPOYETI_KEYCHAIN_MEMORY === "1" ? memStore : osStore);

let warned = false;
// null = untested yet, true/false = last observed availability.
let available: boolean | null = null;

function warnOnce(op: string, e: unknown): void {
  available = false;
  if (warned) return;
  warned = true;
  console.warn(
    `repoyeti: OS keychain unavailable (${op}: ${e instanceof Error ? e.message : String(e)}). ` +
      `Storing secrets in plaintext ~/.repoyeti/config.json instead — install your platform's ` +
      `secret service (libsecret on Linux) for at-rest protection.`,
  );
}

/** True unless a keychain op has failed (or it was force-disabled). OPTIMISTIC: an untested
 *  keychain (no op run yet this process) reads as available. Fine for non-destructive decisions,
 *  NOT for deciding whether it's safe to delete the on-disk plaintext copy of a secret. */
export function keychainAvailable(): boolean {
  return !disabled() && available !== false;
}

/**
 * True ONLY after a keychain op has actually SUCCEEDED this process (available === true).
 *
 * The strict form, for the one decision that is irreversible: stripping a secret out of
 * config.json. keychainAvailable() reports an UNTESTED keychain (available === null) as available,
 * which is the right optimism for a read but a trap for a delete — a one-shot `repoyeti add-root`
 * never runs a keychain op, so on a host whose keychain is actually broken it would strip legacy
 * plaintext secrets it had never migrated anywhere, losing them for good. Requiring a confirmed
 * success means "untested" falls to the safe side: keep the plaintext (and ACL-protect it) until a
 * real daemon boot has proven the keychain and migrated the secrets. Every successful get/set/delete
 * sets available = true, so the normal daemon path (hydrateSecrets runs first) is unaffected. */
export function keychainConfirmed(): boolean {
  return !disabled() && available === true;
}

/** Pre-rename keychain namespace (back when RepoYeti was "GitMob"). On a default install
 *  we transparently read secrets still stored there and re-home them under the new
 *  service on first access, so a saved AI key survives the rename without re-entry. */
const LEGACY_SERVICE = "gitmob";

/** Read a secret by name. Returns null when absent or the keychain is unavailable. */
export async function getSecret(name: string): Promise<string | null> {
  if (disabled()) return null;
  try {
    const s = store();
    const v = await s.get(service(), name);
    available = true;
    if (v != null) return v;
    // Legacy fallback: a secret left under the old "gitmob" service (default install only).
    if (!process.env.REPOYETI_KEYCHAIN_SERVICE) {
      const legacy = await s.get(LEGACY_SERVICE, name);
      if (legacy != null) {
        try {
          await s.set(service(), name, legacy);
          await s.delete(LEGACY_SERVICE, name);
        } catch {
          /* best-effort re-home; returning the value is what matters */
        }
        return legacy;
      }
    }
    return null;
  } catch (e) {
    warnOnce("get", e);
    return null;
  }
}

/** Store a secret. Returns true on success; false (with a one-time warning) if unavailable. */
export async function setSecret(name: string, value: string): Promise<boolean> {
  if (disabled()) return false;
  try {
    await store().set(service(), name, value);
    available = true;
    return true;
  } catch (e) {
    warnOnce("set", e);
    return false;
  }
}

/** Remove a secret. Best-effort: a failure is warned once and otherwise ignored. */
export async function deleteSecret(name: string): Promise<void> {
  if (disabled()) return;
  try {
    await store().delete(service(), name);
    available = true;
  } catch (e) {
    warnOnce("delete", e);
  }
}

// ── secret-name scheme (one flat namespace under the SERVICE) ──────────────────
export const aiKeyName = (provider: string): string => `ai/${provider}`;
/** Additional (rotation-pool) keys for a provider, stored as a single JSON-array-of-strings
 *  secret alongside the primary `aiKeyName` one. See src/ai/credential-pool.ts for why a
 *  provider can hold more than one key - the primary key's own OS-keychain slot is untouched,
 *  so a config from before this feature existed keeps working unchanged. */
export const aiKeyPoolName = (provider: string): string => `ai/${provider}/pool`;
export const OAUTH_CLIENT_SECRET = "oauth/clientSecret";
/** Named-tunnel connector token — a credential that lets cloudflared run the owner's tunnel,
 *  so it's keychain-stored and stripped from config.json (see config.ts TunnelConfig). */
export const TUNNEL_TOKEN = "tunnel/token";
/** Optional, owner-minted API Bearer token — a LOCAL credential (never touches connections.icu)
 *  that lets a remote/headless agent authenticate over the tunnel. Off by default (absent ⇒ no
 *  behavior change); keychain-stored and stripped from config.json (see config.ts apiToken). */
export const API_TOKEN = "api/token";
/** Legacy location for the relay private key. New versions keep the complete pair together in the
 *  owner-only config file; hydrateSecrets() reads this once, validates it, then deletes it. */
export const RELAY_PRIVATE_KEY = "relay/privateKey";
/** The owner's Connections OAuth **refresh token** — obtained at "Sign in with Connections" and
 *  retained so the daemon (the BFF) can mint fresh access tokens to call the settings-sync store
 *  (studio.connections.icu/v1/app-data) server-to-server, without the browser ever holding a token.
 *  Sensitive → keychain-only, NEVER written to config.json. See src/connections-sync.ts. */
export const CONNECTIONS_REFRESH_TOKEN = "connections/refreshToken";
