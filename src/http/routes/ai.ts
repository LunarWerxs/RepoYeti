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
  effectiveDefaultProvider,
  type RepoYetiConfig,
  type AiProviderId,
} from "../../config.ts";
import {
  listModels,
  generateCommitMessage,
  generateCommitPlan,
  heuristicPlan,
  AiError,
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

export function register(app: Hono, { cfg }: Deps): void {
  // ── AI: bring-your-own-key commit messages ──────────────────────────────────
  // The daemon makes every provider call; the owner's key never reaches the browser.
  // `cfg` is mutated in place AND persisted so a running daemon picks up new keys.
  const parseProvider = (c: Context): AiProviderId | null => {
    const p = c.req.param("provider") ?? "";
    return (AI_PROVIDERS as readonly string[]).includes(p) ? (p as AiProviderId) : null;
  };
  const ensureAi = (): NonNullable<RepoYetiConfig["ai"]> => (cfg.ai ??= { providers: {} });
  const aiErr = (c: Context, e: unknown) =>
    e instanceof AiError
      ? jsonError(c, e.code as ApiErrorCode, e.message)
      : jsonError(c, "AI_ERROR", e instanceof Error ? e.message : String(e));

  // Static provider catalog — safe display metadata (no secrets).
  // Separate endpoint so the UI can cache it independently of per-user settings.
  app.get("/api/ai/catalog", (c) => c.json({ catalog: AI_CATALOG }));

  // Redacted settings — NEVER includes any apiKey.
  app.get("/api/ai/settings", (c) => c.json(redactAi(cfg)));

  // Update commit style and/or the default provider.
  app.put("/api/ai/settings", async (c) => {
    const p = await parseBody(c, AiSettingsSchema);
    if (!p.ok) return p.res;
    const ai = ensureAi();
    if (p.data.style != null) ai.style = p.data.style;
    if (typeof p.data.yolo === "boolean") ai.yolo = p.data.yolo;
    if (p.data.defaultProvider !== undefined) {
      const dp = p.data.defaultProvider == null ? undefined : (p.data.defaultProvider as AiProviderId);
      if (dp !== undefined && !resolveApiKey(cfg, dp)) {
        return jsonError(c, "NOT_CONFIGURED", `${dp} has no key`);
      }
      ai.defaultProvider = dp;
    }
    saveConfig(cfg);
    return c.json(redactAi(cfg));
  });

  // Connect a provider: validate the key by listing models, then SAVE it.
  app.post("/api/ai/providers/:provider/connect", async (c) => {
    const provider = parseProvider(c);
    if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
    const p = await parseBody(c, ConnectSchema);
    if (!p.ok) return p.res;
    const apiKey = (p.data.apiKey ?? "").trim();
    if (!apiKey) return jsonError(c, "NO_KEY", "API key required");
    try {
      const models = await listModels(provider, apiKey);
      const ai = ensureAi();
      const prev = ai.providers[provider]?.model ?? null;
      // Keep a still-valid prior choice, else auto-pick one so it works immediately.
      const model = prev && models.some((m) => m.id === prev) ? prev : (models[0]?.id ?? null);
      // The key bytes go to the OS keychain; config.json (written by saveConfig) keeps only
      // the model. apiKey stays in the in-memory cfg so this running daemon can use it.
      await setSecret(aiKeyName(provider), apiKey);
      ai.providers[provider] = { apiKey, model };
      if (!ai.defaultProvider) ai.defaultProvider = provider;
      saveConfig(cfg);
      return c.json({ ok: true, models, settings: redactAi(cfg) });
    } catch (e) {
      return aiErr(c, e);
    }
  });

  // Re-list models for an already-connected provider (refresh the dropdown).
  app.get("/api/ai/providers/:provider/models", async (c) => {
    const provider = parseProvider(c);
    if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
    const apiKey = resolveApiKey(cfg, provider);
    // 404 (not the default 400): the named provider has no stored key to list models for.
    if (!apiKey) return jsonError(c, "NOT_CONFIGURED", "no key for this provider", 404);
    try {
      return c.json({ ok: true, models: await listModels(provider, apiKey) });
    } catch (e) {
      return aiErr(c, e);
    }
  });

  // Set the selected model and/or mark this provider the default.
  app.put("/api/ai/providers/:provider", async (c) => {
    const provider = parseProvider(c);
    if (!provider) return jsonError(c, "BAD_PROVIDER", "unknown provider");
    if (!resolveApiKey(cfg, provider)) {
      return jsonError(c, "NOT_CONFIGURED", "connect this provider first", 404);
    }
    const p = await parseBody(c, ProviderUpdateSchema);
    if (!p.ok) return p.res;
    const ai = ensureAi();
    const entry = ai.providers[provider];
    if (p.data.model !== undefined && entry) entry.model = p.data.model ?? null;
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
      cfg.ai.defaultProvider = AI_PROVIDERS.find((p) => cfg.ai!.providers?.[p]?.apiKey);
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
    const requested = p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
    const provider = requested ?? effectiveDefaultProvider(cfg);
    if (!provider) return jsonError(c, "NO_AI_PROVIDER", "no AI provider configured");
    const apiKey = resolveApiKey(cfg, provider);
    if (!apiKey) return jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`);
    const model = resolveModel(cfg, provider);
    if (!model) return jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`);

    // With `paths`, draft from only those files (smart-commit per-group regenerate); else the
    // whole working tree (the normal "Generate" button).
    const collected =
      p.data.paths?.length
        ? await collectRepoPathsDiff(id, p.data.paths)
        : await collectRepoDiff(id);
    if (!collected.ok) {
      const status: ContentfulStatusCode =
        collected.code === "NOT_FOUND" ? 404 : collected.code === "NOTHING_TO_COMMIT" ? 409 : 400;
      return c.json(collected, status);
    }
    try {
      const message = await generateCommitMessage(
        provider,
        apiKey,
        model,
        collected.diff!,
        cfg.ai?.style ?? "conventional",
      );
      return c.json({ ok: true, message, provider, model });
    } catch (e) {
      return aiErr(c, e);
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
    const requested = p.data.provider == null ? undefined : (p.data.provider as AiProviderId);
    const provider = requested ?? effectiveDefaultProvider(cfg);
    if (!provider) return jsonError(c, "NO_AI_PROVIDER", "no AI provider configured");
    const apiKey = resolveApiKey(cfg, provider);
    if (!apiKey) return jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`);
    const model = resolveModel(cfg, provider);
    if (!model) return jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`);

    const collected = await planCommitInput(id);
    if (!collected.ok) {
      const status: ContentfulStatusCode =
        collected.code === "NOT_FOUND" ? 404 : collected.code === "NOTHING_TO_COMMIT" ? 409 : 400;
      return c.json(collected, status);
    }
    const style = cfg.ai?.style ?? "conventional";
    try {
      const plan = await generateCommitPlan(provider, apiKey, model, collected.input!, style);
      return c.json({ ok: true, plan, provider, model });
    } catch (e) {
      // A bad/rejected key is worth surfacing (the owner must fix it); anything else
      // (provider down, garbage response) falls back to the deterministic plan.
      if (e instanceof AiError && e.code === "AI_AUTH_FAILED") return aiErr(c, e);
      const plan = heuristicPlan(collected.input!);
      return c.json({ ok: true, plan, provider, model, fallback: true });
    }
  });
}
