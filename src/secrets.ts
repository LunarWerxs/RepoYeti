/**
 * OS keychain boundary — the one place owner secrets are read/written at rest.
 *
 * Backed by **`Bun.secrets`**, which is built into the Bun runtime and talks to the
 * platform credential store directly (Windows Credential Manager / macOS Keychain /
 * Linux libsecret). That means: no native addon to compile or ship, no `bun --compile`
 * caveat, and no bespoke crypto to maintain — exactly the "simple, low-maintenance"
 * posture we want. Secrets the daemon must persist (AI provider API keys, an optional
 * confidential OAuth `client_secret`) live HERE, never in `~/.gitmob/config.json`.
 *
 * Graceful degradation: if the OS secret service isn't available (e.g. a headless Linux
 * box with no libsecret), every call becomes a no-op + a one-time warning and the daemon
 * keeps its previous plaintext-config behavior (see config.ts `stripSecretsForDisk`,
 * which only strips when `keychainAvailable()` is true). Nothing breaks; that host just
 * isn't keychain-protected.
 */
import { secrets } from "bun";

/** Keychain "service" namespace. Overridable so tests don't touch the real `gitmob` store.
 *  Read per call (not at import) so a test can set it before exercising the boundary. */
const service = (): string => process.env.GITMOB_KEYCHAIN_SERVICE ?? "gitmob";
/** Escape hatch (tests / odd environments): force the plaintext-config fallback path. */
const disabled = (): boolean => process.env.GITMOB_NO_KEYCHAIN === "1";

let warned = false;
// null = untested yet, true/false = last observed availability.
let available: boolean | null = null;

function warnOnce(op: string, e: unknown): void {
  available = false;
  if (warned) return;
  warned = true;
  console.warn(
    `gitmob: OS keychain unavailable (${op}: ${e instanceof Error ? e.message : String(e)}). ` +
      `Storing secrets in plaintext ~/.gitmob/config.json instead — install your platform's ` +
      `secret service (libsecret on Linux) for at-rest protection.`,
  );
}

/** True unless a keychain op has failed (or it was force-disabled). Drives disk stripping. */
export function keychainAvailable(): boolean {
  return !disabled() && available !== false;
}

/** Read a secret by name. Returns null when absent or the keychain is unavailable. */
export async function getSecret(name: string): Promise<string | null> {
  if (disabled()) return null;
  try {
    const v = await secrets.get({ service: service(), name });
    available = true;
    return v ?? null;
  } catch (e) {
    warnOnce("get", e);
    return null;
  }
}

/** Store a secret. Returns true on success; false (with a one-time warning) if unavailable. */
export async function setSecret(name: string, value: string): Promise<boolean> {
  if (disabled()) return false;
  try {
    await secrets.set({ service: service(), name, value });
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
    await secrets.delete({ service: service(), name });
    available = true;
  } catch (e) {
    warnOnce("delete", e);
  }
}

// ── secret-name scheme (one flat namespace under the SERVICE) ──────────────────
export const aiKeyName = (provider: string): string => `ai/${provider}`;
export const OAUTH_CLIENT_SECRET = "oauth/clientSecret";
