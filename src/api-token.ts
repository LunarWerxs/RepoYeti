/**
 * Mint and revoke the OPTIONAL owner API Bearer token, durably and honestly.
 *
 * The token has two homes: the in-memory `cfg.apiToken` slot the auth gate compares against, and
 * a durable copy — the OS keychain normally, config.json (0600 / ACL'd) on a host whose keychain is
 * unavailable. Before this module the two routes touched only the first home and ASSUMED the
 * second: `deleteSecret` swallowed a refused delete and the route answered `ok`, so a revoked token
 * came straight back out of the keychain at the next boot; `setSecret`'s boolean was discarded, so
 * a mint could hand out a token that died with the process while the OLD one lived on in the
 * keychain; and neither route ever saved the config, so on a keychain-less host a mint was not
 * durable at all until some unrelated setting happened to be saved (audit item 5).
 *
 * The rules now:
 *   - Live access changes FIRST, in memory, before anything that can fail. A revoke ends the old
 *     token's validity even if every durable step below is refused.
 *   - Then the durable copy is written or deleted, and the RESULT is kept, not assumed.
 *   - Then `saveConfig()` runs. It strips the token from disk when the keychain is confirmed and
 *     keeps it there otherwise (the documented degraded mode), and it is also where the revocation
 *     TOMBSTONE lands: when the store refuses a delete, `apiTokenRevoked` is persisted so boot-time
 *     hydration never reloads that slot and retries the delete instead (config.ts hydrateApiToken).
 *   - The response says what actually happened. "Durable" means a restart cannot bring the old
 *     token back / cannot lose the new one; `keychainCleared` and `store` report the mechanism.
 */
import { randomBytes } from "node:crypto";
import { saveConfig, type RepoYetiConfig } from "./config.ts";
import { API_TOKEN, deleteSecret, setSecret } from "./secrets.ts";

export type ApiTokenStore = "keychain" | "config";

export type MintApiTokenResult =
  | { ok: true; token: string; store: ApiTokenStore }
  /** Neither the credential store nor the config file accepted the new token. Nothing changed:
   *  the previous token (if any) still stands, in memory and on disk. */
  | { ok: false; message: string };

export interface RevokeApiTokenResult {
  /** A restart cannot bring the token back: the durable copy is gone, or a tombstone prevents
   *  hydration from loading it. False only when config.json itself could not be written. */
  durable: boolean;
  /** The credential store confirmed the delete (or holds nothing: keychain disabled). When false
   *  the bytes are still in the store, disabled by the tombstone, and deleted on a later boot. */
  keychainCleared: boolean;
  /** Human-readable note for the non-clean cases; absent when everything succeeded. */
  warning?: string;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Mint (or replace) the token. The plaintext value is returned exactly once, from here. */
export async function mintApiToken(cfg: RepoYetiConfig): Promise<MintApiTokenResult> {
  const previous = cfg.apiToken;
  const previousTombstone = cfg.apiTokenRevoked;
  const token = randomBytes(32).toString("base64url");
  const stored = await setSecret(API_TOKEN, token);
  cfg.apiToken = token;
  // The keychain now holds the NEW token, so a tombstone left by an earlier failed revoke is
  // retired — it would otherwise make the next boot delete the token that was just minted.
  if (stored) delete cfg.apiTokenRevoked;
  try {
    saveConfig(cfg);
  } catch (e) {
    if (stored) {
      // Durable in the keychain; the config write is bookkeeping (strip / tombstone) and boot
      // hydration converges it. Report the keychain as the store and move on.
      return { ok: true, token, store: "keychain" };
    }
    // Nowhere durable took the token. Put the previous state back rather than hand out a
    // credential that evaporates at the next restart while the old one quietly survives.
    if (previous === undefined) delete cfg.apiToken;
    else cfg.apiToken = previous;
    if (previousTombstone) cfg.apiTokenRevoked = previousTombstone;
    return {
      ok: false,
      message: `the credential store refused the new token and config.json could not be written (${describe(e)}); the existing token is unchanged`,
    };
  }
  return { ok: true, token, store: stored ? "keychain" : "config" };
}

/**
 * Revoke the token. Live access ends immediately and unconditionally; the durable steps report
 * their own outcome. Shared by DELETE /api/auth/token and "sign out everywhere".
 */
export async function revokeApiToken(cfg: RepoYetiConfig): Promise<RevokeApiTokenResult> {
  delete cfg.apiToken;
  const keychainCleared = await deleteSecret(API_TOKEN);
  if (keychainCleared) delete cfg.apiTokenRevoked;
  else cfg.apiTokenRevoked = true;
  try {
    saveConfig(cfg);
  } catch (e) {
    return {
      durable: false,
      keychainCleared,
      warning: `the token is disabled for this process, but config.json could not be written (${describe(e)}); a restart may restore it — revoke again once the config directory is writable`,
    };
  }
  if (!keychainCleared) {
    return {
      durable: true,
      keychainCleared: false,
      warning:
        "the credential store refused to delete the old token; it is disabled and will not be loaded again, and the daemon retries the delete at each start",
    };
  }
  return { durable: true, keychainCleared: true };
}
