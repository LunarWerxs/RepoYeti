/**
 * Per-provider API key rotation pool.
 *
 * WHY: every AI provider in AI_ADAPTERS (src/ai/adapters.ts) held exactly ONE bring-your-own key
 * (config.ts `AiProviderCfg.apiKey`). An owner on a free tier (Groq, OpenRouter, Gemini — the
 * providers AI_CATALOG marks `free`) who hits that tier's daily/per-minute cap had no fallback:
 * Smart Commit, commit-message drafting and conflict-resolve all block on the same 429 until the
 * provider's own window resets, even though an owner juggling several free accounts could add a
 * second key and keep going. Adapted from Hermes Agent's per-account credential pool
 * (agent/credential_pool.py + agent/account_usage.py, MIT, Copyright Nous Research) — the idea
 * (round-robin over a pool, cool a credential down by the error class it actually hit rather than
 * retrying it immediately) reimplemented fresh against RepoYeti's own config/secrets model and
 * error taxonomy (AiError/AiCode in ./commit-message.ts), not a port of Hermes's Python. Sibling
 * app ReDesign proves a close relative of this shape in the same stack (src/keyManager.ts).
 *
 * Deliberately IN-MEMORY only (no keyState.json-style persisted health file, unlike ReDesign's
 * KeyManager): a cooldown that resets on daemon restart is the right failure mode here — RepoYeti
 * restarts far less often than a rate-limit window closes, and inventing a new non-secret-fact
 * file under ~/.repoyeti/ for this is not worth the extra surface for an M-effort feature. The
 * secret material itself never lives here longer than one call's closure; only a non-secret
 * fingerprint is retained for health tracking.
 */
import type { AiProviderId } from "../config.ts";
import { AiError, type AiCode } from "./commit-message.ts";

/** Cooldown per outcome class, ms. A 429 backs off briefly — the provider's own window is
 *  usually what's exhausted, not the credential, and it may well recover inside a minute. An
 *  auth failure means the key itself is wrong/revoked, so it sits out far longer: retrying it
 *  every call would just spend a round trip re-learning what is already known. Any other AiCode
 *  (AI_UNREACHABLE, AI_BAD_REQUEST, AI_ERROR) is not this credential's fault — see the
 *  ROTATABLE set in withKeyRotation — so it has no entry here at all. */
const COOLDOWN_MS: Partial<Record<AiCode, number>> = {
  AI_RATE_LIMITED: 60_000,
  AI_AUTH_FAILED: 24 * 60 * 60 * 1000,
};

/** Outcome classes that mean THIS credential — not the request — is the reason the call failed,
 *  and so are worth spending the next key in the pool on. A bad request or an unreachable
 *  provider would fail identically on every key in the pool; rotating on those would just turn
 *  one failure into N identical ones. */
const ROTATABLE: ReadonlySet<AiCode> = new Set(["AI_RATE_LIMITED", "AI_AUTH_FAILED"]);

interface KeyHealth {
  key: string;
  /** Non-secret fingerprint — a few leading chars (providers' own key prefixes, e.g. "sk-",
   *  "gsk_", are not secret) plus a short hash, so two different keys practically never collide
   *  but the fingerprint alone can never be turned back into the key. Used as the pool's stable
   *  identity across rebuilds and as the handle callers report an outcome against. */
  id: string;
  cooldownUntil: number;
  status: "untested" | "ok" | "cooldown" | "dead";
  successes: number;
  failures: number;
  lastError: string | null;
  lastUsedAt: number | null;
}

interface Pool {
  entries: KeyHealth[];
  /** Round-robin cursor: the index to start FROM on the next acquireKeys() call. */
  rr: number;
}

const pools = new Map<AiProviderId, Pool>();

/** djb2 over the key, rendered as 8 hex chars. Not cryptographic — it only has to make two
 *  different real-world API keys collide about as often as picking the same random 32-bit value
 *  twice, which is plenty for a health-tracking handle that is never treated as a secret. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

function fingerprint(key: string): string {
  const prefix = key.slice(0, 4).replace(/[^\w-]/g, "");
  return `${prefix}…${shortHash(key)}`;
}

/** Rebuild `provider`'s pool from its currently-configured keys, carrying over health for any
 *  key that survives the rebuild (matched by fingerprint). Cheap — safe to call on every
 *  resolution so an owner editing the key list in Settings takes effect on the very next call
 *  with no daemon restart. A key dropped from `keys` (owner removed it) simply does not appear
 *  in the rebuilt `entries`; nothing needs to actively evict it. */
function syncPool(provider: AiProviderId, keys: readonly string[]): Pool {
  const existing = pools.get(provider);
  const byId = new Map(existing?.entries.map((e) => [e.id, e] as const));
  const entries: KeyHealth[] = keys.map((key) => {
    const id = fingerprint(key);
    const prior = byId.get(id);
    if (prior && prior.key === key) return prior;
    return {
      key,
      id,
      cooldownUntil: 0,
      status: "untested",
      successes: 0,
      failures: 0,
      lastError: null,
      lastUsedAt: null,
    };
  });
  const pool: Pool = { entries, rr: existing && entries.length ? existing.rr % entries.length : 0 };
  pools.set(provider, pool);
  return pool;
}

export interface AcquiredKey {
  key: string;
  id: string;
}

/**
 * Every key in `provider`'s pool NOT currently cooling down, ordered starting from the
 * round-robin cursor (so repeated calls spread load across the pool rather than always
 * hammering entries[0]). When every key is cooling, falls back to the single soonest-to-clear
 * one — a request that goes out and gets the provider's own honest error is a better answer to
 * the owner than refusing to try a key that does exist.
 */
export function acquireKeys(provider: AiProviderId, keys: readonly string[]): AcquiredKey[] {
  const pool = syncPool(provider, keys);
  const n = pool.entries.length;
  if (!n) return [];
  const now = Date.now();
  const ordered = Array.from({ length: n }, (_, step) => pool.entries[(pool.rr + step) % n]!);
  const available = ordered.filter((e) => e.cooldownUntil <= now);
  const chosen = available.length ? available : [ordered.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b))];
  // Advance the cursor past whichever entry will be tried FIRST, so the next independent
  // acquireKeys() call (a later, unrelated generation request) starts from a different key
  // instead of always favoring entries[0].
  const usedIdx = pool.entries.indexOf(chosen[0]!);
  pool.rr = (usedIdx + 1) % n;
  return chosen.map((e) => ({ key: e.key, id: e.id }));
}

/** Record the outcome of one attempt against a specific key (by the `id` acquireKeys() handed
 *  back). A no-op if the pool was rebuilt since (e.g. the owner removed that key) — there is
 *  nothing left to update. */
export function reportKeyOutcome(
  provider: AiProviderId,
  keyId: string,
  outcome: "ok" | { code: AiCode; message?: string },
): void {
  const entry = pools.get(provider)?.entries.find((e) => e.id === keyId);
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  if (outcome === "ok") {
    entry.successes++;
    entry.status = "ok";
    entry.cooldownUntil = 0;
    entry.lastError = null;
    return;
  }
  entry.failures++;
  entry.lastError = (outcome.message ?? outcome.code).slice(0, 300);
  const cooldown = COOLDOWN_MS[outcome.code];
  if (cooldown) {
    entry.cooldownUntil = Date.now() + cooldown;
    entry.status = outcome.code === "AI_AUTH_FAILED" ? "dead" : "cooldown";
  }
  // Any other code (AI_BAD_REQUEST, AI_UNREACHABLE, AI_ERROR) never penalizes the credential —
  // see the ROTATABLE doc comment above; status/cooldown are left exactly as they were.
}

/**
 * Run `attempt` against each usable key in `provider`'s pool, in rotation order, until one
 * succeeds. Rotates to the next key ONLY on an outcome the ROTATABLE set says is the
 * credential's fault (rate-limited or rejected); any other failure is this request's problem,
 * not the key's, so it is rethrown immediately rather than repeated N times for nothing. An
 * empty pool (the no-auth loopback `compatible` case) makes exactly one attempt with `""`,
 * matching every call site's pre-pool behavior for that path.
 */
export async function withKeyRotation<T>(
  provider: AiProviderId,
  apiKeys: readonly string[],
  attempt: (key: string) => Promise<T>,
): Promise<T> {
  if (apiKeys.length === 0) return attempt("");
  const ordered = acquireKeys(provider, apiKeys);
  let lastErr: unknown;
  for (let i = 0; i < ordered.length; i++) {
    const { key, id } = ordered[i]!;
    try {
      const result = await attempt(key);
      reportKeyOutcome(provider, id, "ok");
      return result;
    } catch (e) {
      lastErr = e;
      const code: AiCode = e instanceof AiError ? e.code : "AI_ERROR";
      reportKeyOutcome(provider, id, { code, message: e instanceof Error ? e.message : undefined });
      const isLast = i === ordered.length - 1;
      if (!ROTATABLE.has(code) || isLast) throw e;
    }
  }
  // Unreachable in practice (the loop above always either returns or throws), but keeps the
  // return type honest for a pool that somehow yielded zero attempts.
  throw lastErr ?? new AiError("AI_ERROR", "no usable API key");
}

/** Sanitized snapshot for diagnostics/Settings — fingerprints and health only, never a key. */
export interface KeyPoolSnapshot {
  provider: AiProviderId;
  total: number;
  available: number;
  entries: Array<Omit<KeyHealth, "key">>;
}

/** Sync + snapshot in one call, so GET-ing the pool status reflects the CURRENT configured keys
 *  even before any generation call has run this process. */
export function snapshotPool(provider: AiProviderId, keys: readonly string[]): KeyPoolSnapshot {
  const pool = syncPool(provider, keys);
  const now = Date.now();
  return {
    provider,
    total: pool.entries.length,
    available: pool.entries.filter((e) => e.cooldownUntil <= now).length,
    entries: pool.entries.map(({ key: _key, ...rest }) => rest),
  };
}

/** Test-only: drop all in-memory pool state so tests don't leak cooldowns into each other. */
export function resetCredentialPools(): void {
  pools.clear();
}
