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
  heuristicPlan,
  clearRateGate,
  normalizeCompatibleBaseUrl,
  isCompatibleLoopbackBaseUrl,
  AiError,
  type AiModel,
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
} from "../../schemas.ts";
import { collectRepoDiff, collectRepoPathsDiff, planCommitInput } from "../../service/index.ts";
import { requireId } from "../respond.ts";
import { effectiveGuest } from "../../auth.ts";

const GUEST_AI_WINDOW_MS = 60_000;
const GUEST_AI_MAX_PER_WINDOW = 10;
const GUEST_AI_MAX_CONCURRENT = 2;
const GUEST_AI_USAGE_MAX = 1_000;

interface GuestAiUsage {
  windowStartedAt: number;
  used: number;
  active: number;
}

export function register(app: Hono, { cfg }: Deps): void {
  // ── AI: bring-your-own-key commit messages ──────────────────────────────────
  // The daemon makes every provider call; the owner's key never reaches the browser.
  // `cfg` is mutated in place AND persisted so a running daemon picks up new keys.
  const parseProvider = (c: Context): AiProviderId | null => {
    const p = c.req.param("provider") ?? "";
    return (AI_PROVIDERS as readonly string[]).includes(p) ? (p as AiProviderId) : null;
  };
  const ensureAi = (): NonNullable<RepoYetiConfig["ai"]> => (cfg.ai ??= { providers: {} });
  const providerLabel = (id: AiProviderId): string => AI_CATALOG.find((e) => e.id === id)?.label ?? id;
  const runtimeFor = (id: AiProviderId): { baseUrl?: string } =>
    id === "compatible" ? { baseUrl: resolveAiBaseUrl(cfg, id) ?? undefined } : {};
  const guestAiUsage = new Map<string, GuestAiUsage>();
  const pruneGuestAiUsage = (now: number): void => {
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
  };
  const guestAiErrorMessage = (code: ApiErrorCode): string => {
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
  };
  const enterGuestAi = (c: Context): Response | (() => void) | null => {
    const guest = effectiveGuest(c, cfg);
    if (!guest) return null;
    if (cfg.ai?.commitEnabled === false) {
      return jsonError(c, "FORBIDDEN", "AI commit generation is disabled by the owner", 403);
    }
    const now = Date.now();
    pruneGuestAiUsage(now);
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
  };
  // Turn a raw AiError into a client message. A 401/403 (AI_AUTH_FAILED) is enriched with WHICH
  // provider's key failed, so the owner isn't left staring at a bare "invalid or unauthorized key"
  // wondering what to fix.
  const aiErr = (c: Context, e: unknown, provider?: AiProviderId) => {
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
  };

  // Static provider catalog — safe display metadata (no secrets).
  // Separate endpoint so the UI can cache it independently of per-user settings.
  app.get("/api/ai/catalog", (c) => c.json({ catalog: AI_CATALOG }));

  // Minimal capability projection for share-link guests. It answers only whether the owner's
  // daemon can generate and whether the feature is enabled; provider/model/key identity remains
  // owner-only. The actual provider call below already happens here, never in the guest browser.
  app.get("/api/ai/availability", (c) => {
    const provider = effectiveDefaultProvider(cfg);
    return c.json({
      usable: !!(provider && isAiProviderConfigured(cfg, provider) && resolveModel(cfg, provider)),
      commitEnabled: cfg.ai?.commitEnabled !== false,
    });
  });

  // Redacted settings — NEVER includes any apiKey.
  app.get("/api/ai/settings", (c) => c.json(redactAi(cfg)));

  // Update commit style and/or the default provider.
  app.put("/api/ai/settings", async (c) => {
    const p = await parseBody(c, AiSettingsSchema);
    if (!p.ok) return p.res;
    const ai = ensureAi();
    if (p.data.style != null) ai.style = p.data.style;
    if (p.data.diffDetail != null) ai.diffDetail = p.data.diffDetail;
    if (typeof p.data.yolo === "boolean") ai.yolo = p.data.yolo;
    if (typeof p.data.commitEnabled === "boolean") ai.commitEnabled = p.data.commitEnabled;
    if (p.data.defaultProvider !== undefined) {
      const dp = p.data.defaultProvider == null ? undefined : (p.data.defaultProvider as AiProviderId);
      if (dp !== undefined && !isAiProviderConfigured(cfg, dp)) {
        return jsonError(c, "NOT_CONFIGURED", `${dp} is not configured`);
      }
      ai.defaultProvider = dp;
    }
    saveConfig(cfg);
    return c.json(redactAi(cfg));
  });

  // Connect a provider: validate the key by listing models, then SAVE it. The generic compatible
  // provider treats discovery as optional because OpenAI-compatible generation does not imply
  // that GET /models exists; its manually entered model remains usable when discovery is absent.
  app.post("/api/ai/providers/:provider/connect", async (c) => {
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
      if (!manualModel) {
        return jsonError(c, "AI_BAD_REQUEST", "Model ID required for an OpenAI-compatible provider");
      }
      try {
        baseUrl = normalizeCompatibleBaseUrl(p.data.baseUrl ?? "");
      } catch (e) {
        return jsonError(
          c,
          "AI_BAD_REQUEST",
          e instanceof Error ? e.message : "Invalid OpenAI-compatible base URL",
        );
      }
      if (!apiKey && !isCompatibleLoopbackBaseUrl(baseUrl ?? "")) {
        return jsonError(
          c,
          "NO_KEY",
          "API key required unless the OpenAI-compatible endpoint is on loopback",
        );
      }
    }

    try {
      let discoveryAvailable = true;
      let models: AiModel[];
      try {
        models = await listModels(provider, apiKey, fetch, { baseUrl });
      } catch (e) {
        // A confirmed rejection still blocks connection. Everything else can mean only that this
        // otherwise-compatible endpoint omits /models, so retain the explicit manual model.
        if (!compatible || (e instanceof AiError && e.code === "AI_AUTH_FAILED")) throw e;
        discoveryAvailable = false;
        models = [];
      }
      if (compatible && !models.some((m) => m.id === manualModel)) {
        models.unshift({ id: manualModel, label: manualModel });
      }
      const ai = ensureAi();
      const prev = ai.providers[provider]?.model ?? null;
      // Auto-pick a model so it works immediately: keep a still-valid prior choice, else the
      // provider's curated `recommended` model (config.ts AI_CATALOG) when the live list has it,
      // else the first CHAT model (non-chat models are already filtered out in adapters.ts, so
      // models[0] is a safe fallback — no more Groq → Whisper default).
      const recommended = AI_CATALOG.find((e) => e.id === provider)?.recommended;
      const model = compatible
        ? manualModel
        : prev && models.some((m) => m.id === prev)
          ? prev
          : recommended && models.some((m) => m.id === recommended)
            ? recommended
            : (models[0]?.id ?? null);
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
      return c.json({ ok: true, models, discoveryAvailable, settings: redactAi(cfg) });
    } catch (e) {
      return aiErr(c, e, provider);
    }
  });

  // Re-list models for an already-connected provider (refresh the dropdown).
  app.get("/api/ai/providers/:provider/models", async (c) => {
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
        const models = await listModels(provider, apiKey, fetch, runtimeFor(provider));
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
      return aiErr(c, e, provider);
    }
  });

  // Set the selected model and/or mark this provider the default.
  app.put("/api/ai/providers/:provider", async (c) => {
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
    const ai = ensureAi();
    const entry = ai.providers[provider];
    if (p.data.model !== undefined && entry) {
      entry.model =
        provider === "compatible" ? (p.data.model ?? "").trim() : (p.data.model ?? null);
    }
    if (p.data.makeDefault) ai.defaultProvider = provider;
    saveConfig(cfg);
    return c.json(redactAi(cfg));
  });

  // Remove a provider's key (and re-home the default if it pointed here).
  app.delete("/api/ai/providers/:provider", async (c) => {
    const provider = parseProvider(c);
    if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
    if (cfg.ai?.providers) delete cfg.ai.providers[provider];
    await deleteSecret(aiKeyName(provider)); // drop the key from the OS keychain too
    if (cfg.ai && cfg.ai.defaultProvider === provider) {
      cfg.ai.defaultProvider = undefined;
      cfg.ai.defaultProvider = effectiveDefaultProvider(cfg) ?? undefined;
    }
    saveConfig(cfg);
    return c.json(redactAi(cfg));
  });

  // Draft a commit message from the repo's diff using the default (or a chosen) provider.
  app.post("/api/repos/:id/commit-message", async (c) => {
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
    const provider = requested ?? effectiveDefaultProvider(cfg);
    if (!provider) return jsonError(c, "NO_AI_PROVIDER", "no AI provider configured");
    const apiKey =
      resolveApiKey(cfg, provider) ?? (aiProviderUsesNoAuth(cfg, provider) ? "" : null);
    if (apiKey === null || !isAiProviderConfigured(cfg, provider)) {
      return jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`);
    }
    const model = resolveModel(cfg, provider);
    if (!model) return jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`);

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
    const admission = enterGuestAi(c);
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
        runtimeFor(provider),
      );
      return c.json(guest ? { ok: true, message } : { ok: true, message, provider, model });
    } catch (e) {
      return aiErr(c, e, provider);
    } finally {
      admission?.();
    }
  });

  // Propose a multi-commit plan from the repo's working tree (read-only — commits NOTHING).
  // On an AI failure other than a bad key we fall back to a deterministic grouping so Smart
  // Commit always yields an editable plan; a rejected key surfaces so the owner can fix it.
  app.post("/api/repos/:id/commit-plan", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CommitPlanSchema);
    if (!p.ok) return p.res;
    const guest = effectiveGuest(c, cfg);
    if (guest && cfg.ai?.commitEnabled === false) {
      return jsonError(c, "FORBIDDEN", "AI commit generation is disabled by the owner", 403);
    }
    const requested = guest || p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
    const provider = requested ?? effectiveDefaultProvider(cfg);
    if (!provider) return jsonError(c, "NO_AI_PROVIDER", "no AI provider configured");
    const apiKey =
      resolveApiKey(cfg, provider) ?? (aiProviderUsesNoAuth(cfg, provider) ? "" : null);
    if (apiKey === null || !isAiProviderConfigured(cfg, provider)) {
      return jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`);
    }
    const model = resolveModel(cfg, provider);
    if (!model) return jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`);

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
    const admission = enterGuestAi(c);
    if (admission instanceof Response) return admission;
    try {
      const plan = await generateCommitPlan(
        provider,
        apiKey,
        model,
        collected.input!,
        style,
        undefined,
        runtimeFor(provider),
      );
      return c.json(guest ? { ok: true, plan } : { ok: true, plan, provider, model });
    } catch (e) {
      // A bad/rejected key is worth surfacing (the owner must fix it); anything else
      // (provider down, rate limit, garbage response) still falls back to the deterministic
      // plan so Smart Commit never dead-ends — but the REASON rides along. It used to be
      // dropped here, which made a rate-limited request (where the model never ran at all)
      // render as "AI couldn't structure this" — a wrong answer to a question the owner can
      // actually act on ("your daily token cap is spent; retry at X / switch provider").
      if (e instanceof AiError && e.code === "AI_AUTH_FAILED") return aiErr(c, e, provider);
      const reason =
        e instanceof AiError
          ? {
              code: e.code,
              message: guest
                ? guestAiErrorMessage(e.code as ApiErrorCode)
                : e.message,
            }
          : {
              code: "AI_ERROR" as const,
              message: guest
                ? guestAiErrorMessage("AI_ERROR")
                : e instanceof Error
                  ? e.message
                  : String(e),
            };
      const plan = heuristicPlan(collected.input!, reason);
      return c.json(
        guest
          ? { ok: true, plan, fallback: true }
          : { ok: true, plan, provider, model, fallback: true },
      );
    } finally {
      admission?.();
    }
  });
}
