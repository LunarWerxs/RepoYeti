/**
 * Best-effort startup liveness check for the owner's configured AI keys.
 *
 * A key stored in the OS keychain can go dead between runs — revoked, expired, quota-reset. Without
 * this, that's only discovered the next time the owner clicks "Generate" and gets a cryptic failure.
 * This probes each configured provider's model-list endpoint once at boot; a confirmed auth failure
 * (401/403 → AI_AUTH_FAILED) broadcasts `ai_key_invalid` AND is recorded (see invalidAiKeys) so the
 * dashboard raises a notification even if it opens after boot.
 *
 * Only AI_AUTH_FAILED triggers a notification; a transient/unreachable failure (provider down, a
 * boot-time network blip) is swallowed. Fire-and-forget: runs AFTER the server is serving, never
 * blocks boot, never throws.
 */
import {
  AI_CATALOG,
  resolveAiBaseUrl,
  type AiProviderId,
  type RepoYetiConfig,
} from "./config.ts";
import { listModels, AiError, type FetchFn } from "./ai.ts";
import { broadcast } from "./bus.ts";

const labelFor = (id: AiProviderId): string => AI_CATALOG.find((x) => x.id === id)?.label ?? id;

/** One provider whose key the last liveness check found dead (401/403). */
export interface InvalidAiKey {
  provider: AiProviderId;
  label: string;
}

// Persisted result of the last checkAiKeys run. Exposed on GET /api/status so a dashboard that
// opens AFTER the boot-time check (the common case — the daemon runs headless) still surfaces the
// dead key, not just a browser that happened to be connected during the one-shot SSE broadcast.
let invalid: InvalidAiKey[] = [];

/** The providers whose keys were dead at the last check — hydrated into /api/status. */
export function invalidAiKeys(): InvalidAiKey[] {
  return invalid;
}

async function probe(
  id: AiProviderId,
  apiKey: string,
  label: string,
  fetchImpl: FetchFn,
  baseUrl?: string,
): Promise<void> {
  try {
    await listModels(id, apiKey, fetchImpl, { baseUrl });
  } catch (e) {
    if (e instanceof AiError && e.code === "AI_AUTH_FAILED") {
      invalid.push({ provider: id, label });
      broadcast("ai_key_invalid", { provider: id, label }); // live path (browser connected at boot)
    }
    // else: swallow — only a confirmed auth failure should nag the owner.
  }
}

export async function checkAiKeys(cfg: RepoYetiConfig, fetchImpl: FetchFn = fetch): Promise<void> {
  invalid = []; // fresh each run — a reconnected/fixed key clears
  const providers = cfg.ai?.providers ?? {};
  for (const [id, p] of Object.entries(providers) as Array<[AiProviderId, { apiKey?: string } | undefined]>) {
    const apiKey = p?.apiKey;
    if (!apiKey) continue;
    await probe(id, apiKey, labelFor(id), fetchImpl, resolveAiBaseUrl(cfg, id) ?? undefined);
  }
}
