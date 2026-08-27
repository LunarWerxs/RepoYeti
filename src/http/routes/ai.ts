import type { Hono, Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.ts";
import {
  redactAi,
  saveConfig,
  AI_PROVIDERS,
  AI_CATALOG,
  resolveApiKey,
  resolveModel,
  resolveAiBaseUrl,
  aiProviderUsesNoAuth,
  isAiProviderConfigured,
  effectiveDefaultProvider,
  DEFAULT_DIFF_DETAIL,
  type RepoYetiConfig,
  type AiProviderId,
} from "../../config.ts";
import {
  listModels,
  generateCommitMessage,
  generateCommitPlan,
  generateConflictResolution,
  heuristicPlan,
  clearRateGate,
  looksSmallTierModel,
  normalizeCompatibleBaseUrl,
  isCompatibleLoopbackBaseUrl,
  AiError,
  type AiModel,
  type AiCode,
} from "../../ai.ts";
import { jsonError, type ApiErrorCode } from "../../contract.ts";
import { setSecret, deleteSecret, aiKeyName } from "../../secrets.ts";
import {
  parseBody,
  AiSettingsSchema,
  ProviderUpdateSchema,
  ConnectSchema,
  CommitMessageSchema,
  CommitPlanSchema,
  ConflictResolveSchema,
} from "../../schemas.ts";
import {
  collectRepoDiff,
  collectRepoPathsDiff,
  planCommitInput,
  readConflictFile,
} from "../../service/index.ts";
import { requireId } from "../respond.ts";
import { effectiveGuest } from "../../auth.ts";
import type { Share } from "../../db.ts";

const GUEST_AI_WINDOW_MS = 60_000;
const GUEST_AI_MAX_PER_WINDOW = 10;
const GUEST_AI_MAX_CONCURRENT = 2;
const GUEST_AI_USAGE_MAX = 1_000;

interface GuestAiUsage {
  windowStartedAt: number;
  used: number;
  active: number;
}

// ── AI: bring-your-own-key commit messages ──────────────────────────────────
// The daemon makes every provider call; the owner's key never reaches the browser.
// `cfg` is mutated in place AND persisted so a running daemon picks up new keys.

function parseProvider(c: Context): AiProviderId | null {
  const p = c.req.param("provider") ?? "";
  return (AI_PROVIDERS as readonly string[]).includes(p) ? (p as AiProviderId) : null;
}

function ensureAi(cfg: RepoYetiConfig): NonNullable<RepoYetiConfig["ai"]> {
  return (cfg.ai ??= { providers: {} });
}

function providerLabel(id: AiProviderId): string {
  return AI_CATALOG.find((e) => e.id === id)?.label ?? id;
}

function runtimeFor(cfg: RepoYetiConfig, id: AiProviderId): { baseUrl?: string } {
  return id === "compatible" ? { baseUrl: resolveAiBaseUrl(cfg, id) ?? undefined } : {};
}

/**
 * Whether the model that would actually run LOOKS like a small/fast tier.
 *
 * Computed here rather than in the browser so the heuristic has exactly one definition
 * (src/ai/conflict-resolve.ts). The conflict UI leans on it to escalate its warning, and a
 * second copy in the web app would be a second copy to drift.
 */
function modelTier(cfg: RepoYetiConfig): "small" | "unknown" | null {
  const provider = effectiveDefaultProvider(cfg);
  const model = provider ? resolveModel(cfg, provider) : null;
  if (!model) return null;
  return looksSmallTierModel(model) ? "small" : "unknown";
}

/** The settings payload every AI settings route returns — redacted config plus the derived
 *  bits the UI needs. One helper so a PUT can never answer with a differently-shaped body
 *  than the GET the client loaded on boot. */
function aiPayload(cfg: RepoYetiConfig) {
  return { ...redactAi(cfg), modelTier: modelTier(cfg) };
}

function pruneGuestAiUsage(guestAiUsage: Map<string, GuestAiUsage>, now: number): void {
  for (const [id, usage] of guestAiUsage) {
    if (usage.active === 0 && now - usage.windowStartedAt >= GUEST_AI_WINDOW_MS * 2) {
      guestAiUsage.delete(id);
    }
  }
  while (guestAiUsage.size >= GUEST_AI_USAGE_MAX) {
    const idle = [...guestAiUsage].find(([, usage]) => usage.active === 0);
    if (!idle) break;
    guestAiUsage.delete(idle[0]);
  }
}

function guestAiErrorMessage(code: ApiErrorCode): string {
  switch (code) {
    case "AI_AUTH_FAILED":
      return "The configured AI service rejected authentication.";
    case "AI_RATE_LIMITED":
      return "The configured AI service is temporarily rate limited.";
    case "AI_BAD_REQUEST":
      return "The configured AI service could not process this request.";
    case "AI_UNREACHABLE":
      return "The configured AI service could not be reached.";
    default:
      return "The configured AI service returned an error.";
  }
}

function enterGuestAi(
  c: Context,
  cfg: RepoYetiConfig,
  guestAiUsage: Map<string, GuestAiUsage>,
): Response | (() => void) | null {
  const guest = effectiveGuest(c, cfg);
  if (!guest) return null;
  if (cfg.ai?.commitEnabled === false) {
    return jsonError(c, "FORBIDDEN", "AI commit generation is disabled by the owner", 403);
  }
  const now = Date.now();
  pruneGuestAiUsage(guestAiUsage, now);
  let usage = guestAiUsage.get(guest.id);
  if (!usage && guestAiUsage.size >= GUEST_AI_USAGE_MAX) {
    return jsonError(c, "AI_RATE_LIMITED", "too many guest AI sessions are active; retry shortly");
  }
  if (!usage || now - usage.windowStartedAt >= GUEST_AI_WINDOW_MS) {
    usage = { windowStartedAt: now, used: 0, active: 0 };
    guestAiUsage.set(guest.id, usage);
  }
  if (usage.active >= GUEST_AI_MAX_CONCURRENT) {
    return jsonError(c, "AI_RATE_LIMITED", "too many AI requests are already running for this share link");
  }
  if (usage.used >= GUEST_AI_MAX_PER_WINDOW) {
    return jsonError(c, "AI_RATE_LIMITED", "this share link has reached its AI request limit; retry shortly");
  }
  usage.used++;
  usage.active++;
  return () => {
    usage!.active = Math.max(0, usage!.active - 1);
  };
}

// Turn a raw AiError into a client message. A 401/403 (AI_AUTH_FAILED) is enriched with WHICH
// provider's key failed, so the owner isn't left staring at a bare "invalid or unauthorized key"
// wondering what to fix.
function aiErr(c: Context, cfg: RepoYetiConfig, e: unknown, provider?: AiProviderId) {
  const guest = effectiveGuest(c, cfg);
  if (e instanceof AiError) {
    if (guest) {
      return jsonError(
        c,
        e.code as ApiErrorCode,
        guestAiErrorMessage(e.code as ApiErrorCode),
      );
    }
    if (e.code === "AI_AUTH_FAILED" && provider) {
      const label = providerLabel(provider);
      return jsonError(c, e.code as ApiErrorCode, `${label} rejected the API key. Update your ${label} key in Settings → AI.`);
    }
    return jsonError(c, e.code as ApiErrorCode, e.message);
  }
  return jsonError(
    c,
    "AI_ERROR",
    guest
      ? guestAiErrorMessage("AI_ERROR")
      : e instanceof Error
        ? e.message
        : String(e),
  );
}

// Static provider catalog — safe display metadata (no secrets).
// Separate endpoint so the UI can cache it independently of per-user settings.
function getAiCatalog(c: Context) {
  return c.json({ catalog: AI_CATALOG });
}

// Minimal capability projection for share-link guests. It answers only whether the owner's
// daemon can generate and whether the feature is enabled; provider/model/key identity remains
// owner-only. The actual provider call below already happens here, never in the guest browser.
function getAiAvailability(c: Context, cfg: RepoYetiConfig) {
  const provider = effectiveDefaultProvider(cfg);
  return c.json({
    usable: !!(provider && isAiProviderConfigured(cfg, provider) && resolveModel(cfg, provider)),
    commitEnabled: cfg.ai?.commitEnabled !== false,
  });
}

// Redacted settings — NEVER includes any apiKey.
function getAiSettings(c: Context, cfg: RepoYetiConfig) {
  return c.json(aiPayload(cfg));
}

// Update commit style and/or the default provider.
async function putAiSettings(c: Context, cfg: RepoYetiConfig) {
  const p = await parseBody(c, AiSettingsSchema);
  if (!p.ok) return p.res;
  const ai = ensureAi(cfg);
  if (p.data.style != null) ai.style = p.data.style;
  if (p.data.diffDetail != null) ai.diffDetail = p.data.diffDetail;
  if (typeof p.data.yolo === "boolean") ai.yolo = p.data.yolo;
  if (typeof p.data.commitEnabled === "boolean") ai.commitEnabled = p.data.commitEnabled;
  if (typeof p.data.conflictEnabled === "boolean") ai.conflictEnabled = p.data.conflictEnabled;
  if (p.data.defaultProvider !== undefined) {
    const dp = p.data.defaultProvider == null ? undefined : (p.data.defaultProvider as AiProviderId);
    if (dp !== undefined && !isAiProviderConfigured(cfg, dp)) {
      return jsonError(c, "NOT_CONFIGURED", `${dp} is not configured`);
    }
    ai.defaultProvider = dp;
  }
  saveConfig(cfg);
  return c.json(aiPayload(cfg));
}

type CompatibleConnectionResult = { ok: true; baseUrl: string } | { ok: false; res: Response };

/**
 * Validate the extra requirements an OpenAI-compatible connection has on top of every other
 * provider: a manual model id, a normalized base URL, and — unless the endpoint is loopback —
 * an API key.
 */
function resolveCompatibleConnection(
  c: Context,
  manualModel: string,
  rawBaseUrl: string | undefined,
  apiKey: string,
): CompatibleConnectionResult {
  if (!manualModel) {
    return { ok: false, res: jsonError(c, "AI_BAD_REQUEST", "Model ID required for an OpenAI-compatible provider") };
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeCompatibleBaseUrl(rawBaseUrl ?? "");
  } catch (e) {
    return {
      ok: false,
      res: jsonError(c, "AI_BAD_REQUEST", e instanceof Error ? e.message : "Invalid OpenAI-compatible base URL"),
    };
  }
  if (!apiKey && !isCompatibleLoopbackBaseUrl(baseUrl)) {
    return {
      ok: false,
      res: jsonError(c, "NO_KEY", "API key required unless the OpenAI-compatible endpoint is on loopback"),
    };
  }
  return { ok: true, baseUrl };
}

// Discover models for a provider connect. Only a confirmed rejection blocks connection;
// everything else can mean only that this otherwise-compatible endpoint omits /models, so
// discovery is marked unavailable and the explicit manual model is kept.
async function discoverModelsForConnect(
  provider: AiProviderId,
  apiKey: string,
  baseUrl: string | undefined,
  compatible: boolean,
  manualModel: string,
): Promise<{ models: AiModel[]; discoveryAvailable: boolean }> {
  let discoveryAvailable = true;
  let models: AiModel[];
  try {
    models = await listModels(provider, apiKey, fetch, { baseUrl });
  } catch (e) {
    if (!compatible || (e instanceof AiError && e.code === "AI_AUTH_FAILED")) throw e;
    discoveryAvailable = false;
    models = [];
  }
  if (compatible && !models.some((m) => m.id === manualModel)) {
    models.unshift({ id: manualModel, label: manualModel });
  }
  return { models, discoveryAvailable };
}

// Auto-pick a model so it works immediately: keep a still-valid prior choice, else the
// provider's curated `recommended` model (config.ts AI_CATALOG) when the live list has it,
// else the first CHAT model (non-chat models are already filtered out in adapters.ts, so
// models[0] is a safe fallback — no more Groq → Whisper default).
function pickModelForConnect(
  compatible: boolean,
  manualModel: string,
  prev: string | null,
  models: AiModel[],
  recommended: string | undefined,
): string | null {
  if (compatible) return manualModel;
  if (prev && models.some((m) => m.id === prev)) return prev;
  if (recommended && models.some((m) => m.id === recommended)) return recommended;
  return models[0]?.id ?? null;
}

// Save the connected provider: key to the OS keychain, model/baseUrl to config.json, and
// promote it to default when nothing usable is already set.
async function persistProviderConnection(
  cfg: RepoYetiConfig,
  ai: NonNullable<RepoYetiConfig["ai"]>,
  provider: AiProviderId,
  apiKey: string,
  model: string | null,
  baseUrl: string | undefined,
  compatible: boolean,
): Promise<void> {
  // The key bytes go to the OS keychain; config.json (written by saveConfig) keeps only
  // the model. apiKey stays in the in-memory cfg so this running daemon can use it.
  if (apiKey) await setSecret(aiKeyName(provider), apiKey);
  else await deleteSecret(aiKeyName(provider));
  ai.providers[provider] = {
    ...(apiKey ? { apiKey } : {}),
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(!apiKey && compatible ? { noAuth: true as const } : {}),
  };
  if (
    !ai.defaultProvider ||
    !isAiProviderConfigured(cfg, ai.defaultProvider) ||
    !resolveModel(cfg, ai.defaultProvider)
  ) {
    ai.defaultProvider = provider;
  }
  // A new key is exactly how an owner fixes a spent quota (upgraded tier / different account),
  // so drop any rate-limit pause we're holding for this provider — otherwise the fix would
  // look like it didn't work until the pause aged out.
  clearRateGate(provider);
  saveConfig(cfg);
}

// Connect a provider: validate the key by listing models, then SAVE it. The generic compatible
// provider treats discovery as optional because OpenAI-compatible generation does not imply
// that GET /models exists; its manually entered model remains usable when discovery is absent.
async function postProviderConnect(c: Context, cfg: RepoYetiConfig) {
  const provider = parseProvider(c);
  if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
  const p = await parseBody(c, ConnectSchema);
  if (!p.ok) return p.res;
  const apiKey = (p.data.apiKey ?? "").trim();

  const compatible = provider === "compatible";
  if (!compatible && !apiKey) return jsonError(c, "NO_KEY", "API key required");
  const manualModel = (p.data.model ?? "").trim();
  let baseUrl: string | undefined;
  if (compatible) {
    const resolved = resolveCompatibleConnection(c, manualModel, p.data.baseUrl, apiKey);
    if (!resolved.ok) return resolved.res;
    baseUrl = resolved.baseUrl;
  }

  try {
    const { models, discoveryAvailable } = await discoverModelsForConnect(
      provider,
      apiKey,
      baseUrl,
      compatible,
      manualModel,
    );
    const ai = ensureAi(cfg);
    const prev = ai.providers[provider]?.model ?? null;
    const recommended = AI_CATALOG.find((e) => e.id === provider)?.recommended;
    const model = pickModelForConnect(compatible, manualModel, prev, models, recommended);
    await persistProviderConnection(cfg, ai, provider, apiKey, model, baseUrl, compatible);
    return c.json({ ok: true, models, discoveryAvailable, settings: aiPayload(cfg) });
  } catch (e) {
    return aiErr(c, cfg, e, provider);
  }
}

// Re-list models for an already-connected provider (refresh the dropdown).
async function getProviderModels(c: Context, cfg: RepoYetiConfig) {
  const provider = parseProvider(c);
  if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
  const apiKey =
    resolveApiKey(cfg, provider) ?? (aiProviderUsesNoAuth(cfg, provider) ? "" : null);
  // 404 (not the default 400): the named provider has no stored key to list models for.
  if (apiKey === null || !isAiProviderConfigured(cfg, provider)) {
    return jsonError(c, "NOT_CONFIGURED", "provider is not fully configured", 404);
  }
  try {
    try {
      const models = await listModels(provider, apiKey, fetch, runtimeFor(cfg, provider));
      const saved = resolveModel(cfg, provider);
      if (provider === "compatible" && saved && !models.some((m) => m.id === saved)) {
        models.unshift({ id: saved, label: saved });
      }
      return c.json({ ok: true, models, discoveryAvailable: true });
    } catch (e) {
      if (
        provider !== "compatible" ||
        (e instanceof AiError && e.code === "AI_AUTH_FAILED")
      ) {
        throw e;
      }
      const saved = resolveModel(cfg, provider);
      return c.json({
        ok: true,
        models: saved ? [{ id: saved, label: saved }] : [],
        discoveryAvailable: false,
      });
    }
  } catch (e) {
    return aiErr(c, cfg, e, provider);
  }
}

// Set the selected model and/or mark this provider the default.
async function putProvider(c: Context, cfg: RepoYetiConfig) {
  const provider = parseProvider(c);
  if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
  if (!isAiProviderConfigured(cfg, provider)) {
    return jsonError(c, "NOT_CONFIGURED", "connect this provider first", 404);
  }
  const p = await parseBody(c, ProviderUpdateSchema);
  if (!p.ok) return p.res;
  if (
    provider === "compatible" &&
    p.data.model !== undefined &&
    !(p.data.model ?? "").trim()
  ) {
    return jsonError(c, "AI_BAD_REQUEST", "Model ID required for an OpenAI-compatible provider");
  }
  const ai = ensureAi(cfg);
  const entry = ai.providers[provider];
  if (p.data.model !== undefined && entry) {
    entry.model =
      provider === "compatible" ? (p.data.model ?? "").trim() : (p.data.model ?? null);
  }
  if (p.data.makeDefault) ai.defaultProvider = provider;
  saveConfig(cfg);
  return c.json(aiPayload(cfg));
}

// Remove a provider's key (and re-home the default if it pointed here).
async function deleteProvider(c: Context, cfg: RepoYetiConfig) {
  const provider = parseProvider(c);
  if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
  if (cfg.ai?.providers) delete cfg.ai.providers[provider];
  await deleteSecret(aiKeyName(provider)); // drop the key from the OS keychain too
  if (cfg.ai && cfg.ai.defaultProvider === provider) {
    cfg.ai.defaultProvider = undefined;
    cfg.ai.defaultProvider = effectiveDefaultProvider(cfg) ?? undefined;
  }
  saveConfig(cfg);
  return c.json(aiPayload(cfg));
}

type ProviderResolution =
  | { ok: true; provider: AiProviderId; apiKey: string; model: string }
  | { ok: false; res: Response };

// Given an already-selected (or undefined) provider id, resolve its API key + model, or the
// error Response to return instead. This exact validation chain was duplicated across
// postCommitMessage, postCommitPlan, and postConflictResolve before this extraction.
function resolveProviderConfig(
  c: Context,
  cfg: RepoYetiConfig,
  provider: AiProviderId | null | undefined,
): ProviderResolution {
  if (!provider) {
    return { ok: false, res: jsonError(c, "NO_AI_PROVIDER", "no AI provider configured") };
  }
  const apiKey = resolveApiKey(cfg, provider) ?? (aiProviderUsesNoAuth(cfg, provider) ? "" : null);
  if (apiKey === null || !isAiProviderConfigured(cfg, provider)) {
    return { ok: false, res: jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`) };
  }
  const model = resolveModel(cfg, provider);
  if (!model) {
    return { ok: false, res: jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`) };
  }
  return { ok: true, provider, apiKey, model };
}

// Draft a commit message from the repo's diff using the default (or a chosen) provider.
async function postCommitMessage(c: Context, cfg: RepoYetiConfig, guestAiUsage: Map<string, GuestAiUsage>) {
  const id = requireId(c);
  if (id instanceof Response) return id;
  const p = await parseBody(c, CommitMessageSchema);
  if (!p.ok) return p.res;
  const guest = effectiveGuest(c, cfg);
  if (guest && cfg.ai?.commitEnabled === false) {
    return jsonError(c, "FORBIDDEN", "AI commit generation is disabled by the owner", 403);
  }
  // Share guests may spend only the provider/model the owner selected as default. Provider
  // overrides and provider identity remain owner-only.
  const requested = guest || p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
  const resolved = resolveProviderConfig(c, cfg, requested ?? effectiveDefaultProvider(cfg));
  if (!resolved.ok) return resolved.res;
  const { provider, apiKey, model } = resolved;

  // With `paths`, draft from only those files (smart-commit per-group regenerate); else the
  // whole working tree (the normal "Generate" button). Both honor the owner's diff-detail dial.
  const msgDetail = cfg.ai?.diffDetail ?? DEFAULT_DIFF_DETAIL;
  const collected =
    p.data.paths?.length
      ? await collectRepoPathsDiff(id, p.data.paths, msgDetail)
      : await collectRepoDiff(id, msgDetail);
  if (!collected.ok) {
    const status: ContentfulStatusCode =
      collected.code === "NOT_FOUND" ? 404 : collected.code === "NOTHING_TO_COMMIT" ? 409 : 400;
    return c.json(collected, status);
  }
  const admission = enterGuestAi(c, cfg, guestAiUsage);
  if (admission instanceof Response) return admission;
  try {
    const message = await generateCommitMessage(
      provider,
      apiKey,
      model,
      collected.diff!,
      cfg.ai?.style ?? "conventional",
      undefined,
      collected.files ?? 0, // anchors the body's bullet floor to the real file count
      runtimeFor(cfg, provider),
    );
    return c.json(guest ? { ok: true, message } : { ok: true, message, provider, model });
  } catch (e) {
    return aiErr(c, cfg, e, provider);
  } finally {
    admission?.();
  }
}

// Build the { code, message } reason attached to a heuristic fallback plan when AI generation
// failed for a reason other than a bad key (provider down, rate limit, garbage response). Pulled
// out of postCommitPlan's catch block: it was itself the densest branch of that function, and its
// job — pick the code, then pick the guest-safe or real message — is self-contained.
function commitPlanFallbackReason(
  e: unknown,
  guest: Share | null,
): { code: AiCode; message: string } {
  if (e instanceof AiError) {
    return {
      code: e.code,
      message: guest ? guestAiErrorMessage(e.code as ApiErrorCode) : e.message,
    };
  }
  return {
    code: "AI_ERROR",
    message: guest
      ? guestAiErrorMessage("AI_ERROR")
      : e instanceof Error
        ? e.message
        : String(e),
  };
}

// Propose a multi-commit plan from the repo's working tree (read-only — commits NOTHING).
// On an AI failure other than a bad key we fall back to a deterministic grouping so Smart
// Commit always yields an editable plan; a rejected key surfaces so the owner can fix it.
async function postCommitPlan(c: Context, cfg: RepoYetiConfig, guestAiUsage: Map<string, GuestAiUsage>) {
  const id = requireId(c);
  if (id instanceof Response) return id;
  const p = await parseBody(c, CommitPlanSchema);
  if (!p.ok) return p.res;
  const guest = effectiveGuest(c, cfg);
  if (guest && cfg.ai?.commitEnabled === false) {
    return jsonError(c, "FORBIDDEN", "AI commit generation is disabled by the owner", 403);
  }
  const requested = guest || p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
  const resolved = resolveProviderConfig(c, cfg, requested ?? effectiveDefaultProvider(cfg));
  if (!resolved.ok) return resolved.res;
  const { provider, apiKey, model } = resolved;

  // Empty selection means "nothing checked" → plan the whole tree, so an empty array is
  // treated the same as omitting `paths` entirely (never an accidental empty-scope plan).
  const collected = await planCommitInput(
    id,
    p.data.paths?.length ? p.data.paths : undefined,
    cfg.ai?.diffDetail ?? DEFAULT_DIFF_DETAIL,
  );
  if (!collected.ok) {
    const status: ContentfulStatusCode =
      collected.code === "NOT_FOUND" ? 404 : collected.code === "NOTHING_TO_COMMIT" ? 409 : 400;
    return c.json(collected, status);
  }
  const style = cfg.ai?.style ?? "conventional";
  const admission = enterGuestAi(c, cfg, guestAiUsage);
  if (admission instanceof Response) return admission;
  try {
    const plan = await generateCommitPlan(
      provider,
      apiKey,
      model,
      collected.input!,
      style,
      undefined,
      runtimeFor(cfg, provider),
    );
    return c.json(guest ? { ok: true, plan } : { ok: true, plan, provider, model });
  } catch (e) {
    // A bad/rejected key is worth surfacing (the owner must fix it); anything else
    // (provider down, rate limit, garbage response) still falls back to the deterministic
    // plan so Smart Commit never dead-ends — but the REASON rides along. It used to be
    // dropped here, which made a rate-limited request (where the model never ran at all)
    // render as "AI couldn't structure this" — a wrong answer to a question the owner can
    // actually act on ("your daily token cap is spent; retry at X / switch provider").
    if (e instanceof AiError && e.code === "AI_AUTH_FAILED") return aiErr(c, cfg, e, provider);
    const reason = commitPlanFallbackReason(e, guest);
    const plan = heuristicPlan(collected.input!, reason);
    return c.json(
      guest
        ? { ok: true, plan, fallback: true }
        : { ok: true, plan, provider, model, fallback: true },
    );
  } finally {
    admission?.();
  }
}

// Propose a resolution for every conflict in ONE file (read-only — writes NOTHING).
//
// OWNER-ONLY, unlike every other AI route here, and the asymmetry is deliberate. A share-link
// guest drafting a commit message spends the owner's tokens on prose the owner still reads
// before it lands. A guest resolving a merge would be spending them on the owner's SOURCE, in
// a repo they cannot see the rest of, to produce a change whose blast radius they cannot
// assess. There is no guest budget that makes that a good trade, so there isn't one.
//
// The proposal reaches disk only through POST /api/repos/:id/conflict-apply
// (src/http/routes/files.ts), which re-validates everything here independently.
async function postConflictResolve(c: Context, cfg: RepoYetiConfig) {
  const id = requireId(c);
  if (id instanceof Response) return id;
  if (effectiveGuest(c, cfg)) {
    return jsonError(c, "FORBIDDEN", "AI conflict resolution is owner-only", 403);
  }
  if (cfg.ai?.conflictEnabled === false) {
    return jsonError(c, "FORBIDDEN", "AI conflict resolution is disabled in Settings → AI", 403);
  }
  const p = await parseBody(c, ConflictResolveSchema);
  if (!p.ok) return p.res;

  const requestedProvider =
    p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
  const resolved = resolveProviderConfig(c, cfg, requestedProvider ?? effectiveDefaultProvider(cfg));
  if (!resolved.ok) return resolved.res;
  const { provider, apiKey, model } = resolved;

  const file = await readConflictFile(id, p.data.path);
  if (!file.ok || !file.parsed) {
    const status: ContentfulStatusCode = file.code === "NOT_FOUND" ? 404 : file.code === "NOT_CONFLICTED" ? 409 : 400;
    return c.json({ ok: false, code: file.code, message: file.message }, status);
  }

  try {
    const resolution = await generateConflictResolution(
      provider,
      apiKey,
      model,
      file.path!,
      file.text!,
      file.parsed,
      undefined,
      runtimeFor(cfg, provider),
    );
    return c.json({
      ok: true,
      ...resolution,
      // Echoed back so the apply call can prove it is resolving the same bytes, and so the
      // UI can render ours/theirs beside each proposal without a second round trip.
      hash: file.hash,
      hasBase: file.hasBase,
      hunks: file.hunks,
      provider,
      model,
      // Repeated per response rather than read once at page load: the owner can switch models
      // in Settings between generating two files, and a stale banner is worse than no banner.
      modelTier: looksSmallTierModel(model) ? "small" : "unknown",
    });
  } catch (e) {
    // No heuristic fallback here, deliberately — see generateConflictResolution's doc comment.
    // The honest degraded state for a failed merge resolution is the conflict markers the
    // owner already has, not a machine-made guess wearing the same UI as a real proposal.
    return aiErr(c, cfg, e, provider);
  }
}

export function register(app: Hono, { cfg }: Deps): void {
  const guestAiUsage = new Map<string, GuestAiUsage>();

  app.get("/api/ai/catalog", getAiCatalog);
  app.get("/api/ai/availability", (c) => getAiAvailability(c, cfg));
  app.get("/api/ai/settings", (c) => getAiSettings(c, cfg));
  app.put("/api/ai/settings", (c) => putAiSettings(c, cfg));
  app.post("/api/ai/providers/:provider/connect", (c) => postProviderConnect(c, cfg));
  app.get("/api/ai/providers/:provider/models", (c) => getProviderModels(c, cfg));
  app.put("/api/ai/providers/:provider", (c) => putProvider(c, cfg));
  app.delete("/api/ai/providers/:provider", (c) => deleteProvider(c, cfg));
  app.post("/api/repos/:id/commit-message", (c) => postCommitMessage(c, cfg, guestAiUsage));
  app.post("/api/repos/:id/commit-plan", (c) => postCommitPlan(c, cfg, guestAiUsage));
  app.post("/api/repos/:id/conflict-resolve", (c) => postConflictResolve(c, cfg));
}
