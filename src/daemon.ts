/**
 * HTTP surface (Hono) + the SSE endpoint.
 *
 * Phase 1: read API + SSE. Phase 3 adds identity CRUD, repo-identity assignment,
 * and the safe git actions (fetch/pull/push) with first-class error codes. There
 * is still NO auth here — that's Phase 2's single middleware in front of /api/*
 * (MARCHING_ORDERS §7). The daemon binds to 127.0.0.1 only (see index.ts).
 */
import { join, normalize, dirname } from "node:path";
import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import {
  VERSION,
  authEnforced,
  accessMode,
  ownerConfigured,
  redactAi,
  saveConfig,
  AI_PROVIDERS,
  AI_CATALOG,
  resolveApiKey,
  resolveModel,
  effectiveDefaultProvider,
  type GitmobConfig,
  type AiProviderId,
  type CommitStyle,
} from "./config.ts";
import { listModels, generateCommitMessage, AiError } from "./ai.ts";
import {
  authMiddleware,
  handleLogin,
  handleComplete,
  handleLogout,
  handleContinueLocal,
  readSession,
  isRemoteRequest,
  hasLocalBypass,
} from "./auth.ts";
import { getTunnelUrl, tunnelActive, startManagedTunnel, stopManagedTunnel } from "./runtime.ts";
import {
  getRepos,
  getRepo,
  listIdentities,
  getIdentity,
  createIdentity,
  updateIdentity,
  deleteIdentity,
  setRepoIdentity,
  setRepoHidden,
  setRepoPinned,
  setRepoStarred,
} from "./db.ts";
import { addListener, removeListener, broadcast } from "./bus.ts";
import {
  fetchRepo,
  pullRepo,
  pushRepo,
  commitRepo,
  forceRefresh,
  getChanges,
  searchChangedContent,
  MIN_CONTENT_SEARCH,
  readFileContent,
  readFileDiff,
  writeFileContent,
  collectRepoDiff,
  registerRepo,
  createRepo,
  reorderRepos,
  refreshAllRepos,
  getDiffPatchBytes,
  setDiffPatchBytes,
  getDiffPatchEnabled,
  setDiffPatchEnabled,
  type ActionOutcome,
} from "./service.ts";
import { diffStatsEnabled, setDiffStatsEnabled } from "./diffstat.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "./contract.ts";
import { setSecret, deleteSecret, aiKeyName } from "./secrets.ts";

export function createApp(cfg: GitmobConfig): Hono {
  const app = new Hono();
  const MAX_SSE_QUEUE = 500;

  // Sync the runtime diff-stats flag to this daemon's config (off by default).
  setDiffStatsEnabled(!!cfg.diffStats);
  // Sync the file-viewer's large-file diff threshold (absent = built-in default; clamped).
  if (cfg.diffPatchBytes != null) setDiffPatchBytes(cfg.diffPatchBytes);
  // Sync the compact-diff on/off flag (absent = on; false = always side-by-side).
  if (typeof cfg.diffPatchEnabled === "boolean") setDiffPatchEnabled(cfg.diffPatchEnabled);

  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  app.use("/api/*", authMiddleware(cfg));

  // ── auth surface ───────────────────────────────────────────────────────────
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "gitmob", version: VERSION, ts: Date.now() }),
  );
  // Runtime status for the UI — access mode + the public tunnel URL (null until a
  // cloudflared tunnel yields one) so the web app can show the remote-access link/QR.
  app.get("/api/status", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      mode: accessMode(cfg),
      tunnelActive: tunnelActive(),
      tunnelUrl: getTunnelUrl(),
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      // Large-file Diff threshold (bytes) — owner setting; the viewer compares file size to it.
      diffPatchBytes: getDiffPatchBytes(),
      // Whether large files may use the compact patch view at all (false = always side-by-side).
      diffPatchEnabled: getDiffPatchEnabled(),
      // The min query length for "search content" — the single source of truth, so the UI
      // gate can never silently drift from the server's grep gate.
      minContentSearch: MIN_CONTENT_SEARCH,
    }),
  );

  // Owner UI settings. Currently just the diff-stats toggle: flipping it persists the
  // config, updates the runtime flag, tells every client over SSE, and re-reads all repos
  // so each card's aggregate stat appears/clears immediately.
  app.put("/api/settings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.diffStats === "boolean") {
      cfg.diffStats = b.diffStats;
      setDiffStatsEnabled(b.diffStats);
      saveConfig(cfg);
      broadcast("settings_changed", { diffStats: cfg.diffStats });
      refreshAllRepos();
    }
    if (typeof b.remoteEditing === "boolean") {
      cfg.remoteEditing = b.remoteEditing;
      saveConfig(cfg);
      broadcast("settings_changed", { remoteEditing: cfg.remoteEditing });
    }
    if (typeof b.diffPatchBytes === "number" && Number.isFinite(b.diffPatchBytes)) {
      // setDiffPatchBytes clamps → persist the clamped value, not the raw input.
      cfg.diffPatchBytes = setDiffPatchBytes(b.diffPatchBytes);
      saveConfig(cfg);
      broadcast("settings_changed", { diffPatchBytes: cfg.diffPatchBytes });
    }
    if (typeof b.diffPatchEnabled === "boolean") {
      cfg.diffPatchEnabled = b.diffPatchEnabled;
      setDiffPatchEnabled(b.diffPatchEnabled);
      saveConfig(cfg);
      broadcast("settings_changed", { diffPatchEnabled: cfg.diffPatchEnabled });
    }
    return c.json({
      ok: true,
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      diffPatchBytes: getDiffPatchBytes(),
      diffPatchEnabled: getDiffPatchEnabled(),
    });
  });
  // Public: lets the PWA decide whether to show the "Sign in with Connections" screen,
  // and whether to offer the "Continue local for now" escape hatch (loopback only).
  app.get("/api/auth/status", (c) => {
    const enforced = authEnforced(cfg);
    const session = enforced ? readSession(c, cfg.oauth!) : null;
    const local = !isRemoteRequest(c);
    return c.json({
      authEnforced: enforced,
      mode: accessMode(cfg),
      authenticated: enforced ? !!session : true,
      owner: session?.email || session?.sub || null,
      ownerClaimed: ownerConfigured(cfg),
      canContinueLocal: local,
      localBypass: local && hasLocalBypass(c),
    });
  });
  app.get("/api/auth/me", (c) => {
    const s = authEnforced(cfg) ? readSession(c, cfg.oauth!) : null;
    return c.json({ ok: true, sub: s?.sub ?? null, email: s?.email ?? null });
  });
  app.post("/api/auth/logout", (c) => handleLogout(c));
  // "Continue local for now" — grant a localhost-only bypass (refused over the tunnel).
  app.post("/api/auth/continue-local", (c) => handleContinueLocal(c));

  // Flip local ↔ remote. Enabling remote auto-manages the Cloudflare tunnel, but refuses
  // until an owner is claimed (a signed-in owner) so a stranger can't race TOFU over a
  // freshly-opened tunnel. Disabling tears the tunnel down.
  app.put("/api/mode", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mode = b.mode === "remote" ? "remote" : b.mode === "local" ? "local" : null;
    if (!mode) return jsonError(c, "BAD_MODE", "mode must be 'local' or 'remote'");
    if (mode === "remote") {
      if (!ownerConfigured(cfg)) {
        return jsonError(
          c,
          "NEEDS_OWNER",
          "Sign in with Connections once to claim this GitMob before enabling remote access.",
        );
      }
      cfg.mode = "remote";
      saveConfig(cfg);
      startManagedTunnel();
    } else {
      cfg.mode = "local";
      saveConfig(cfg);
      stopManagedTunnel();
    }
    return c.json({ ok: true, mode: cfg.mode, tunnelActive: tunnelActive(), tunnelUrl: getTunnelUrl() });
  });

  // OIDC dance (only meaningful when configured).
  const oauthGuard = (h: (c: Context) => Promise<Response>) => (c: Context) =>
    authEnforced(cfg) ? h(c) : c.text("Sign-in is not configured for this daemon.", 404);
  app.get("/oauth/login", oauthGuard((c) => handleLogin(c, cfg)));
  app.get("/oauth/finish", oauthGuard((c) => handleComplete(c, cfg)));
  app.get("/oauth/callback", oauthGuard((c) => handleComplete(c, cfg)));

  // ── repos ────────────────────────────────────────────────────────────────
  app.get("/api/repos", (c) => c.json({ repos: getRepos() }));

  // "Point to Folder" (register existing) + "Create New" (git init).
  const repoFromPath = (handler: (path: string) => Promise<{ ok: boolean; code: string; message: string }>) =>
    async (c: Context) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const path = String(b.path ?? "").trim();
      if (!path) return jsonError(c, "BAD_REQUEST", "path is required");
      const r = await handler(path);
      const status: ContentfulStatusCode = r.ok
        ? 201
        : r.code === "NOT_FOUND" || r.code === "NOT_A_REPO"
          ? 400
          : 409;
      return c.json(r, status);
    };
  app.post("/api/repos/register", repoFromPath(registerRepo));
  app.post("/api/repos/create", repoFromPath(createRepo));

  // Persist a drag-to-reorder of the repo list. Body: { order: string[] } (repo ids).
  app.post("/api/repos/reorder", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const order = b.order;
    if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) {
      return jsonError(c, "BAD_REQUEST", "order must be an array of repo ids");
    }
    if (order.length > 10_000) return jsonError(c, "BAD_REQUEST", "order list too long");
    reorderRepos(order as string[]);
    return c.json({ ok: true });
  });

  // ── identities (CRUD) ──────────────────────────────────────────────────────
  app.get("/api/identities", (c) => c.json({ identities: listIdentities() }));

  app.post("/api/identities", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const displayName = String(b.displayName ?? "").trim();
    const gitUsername = String(b.gitUsername ?? "").trim();
    const gitEmail = String(b.gitEmail ?? "").trim();
    if (!displayName || !gitUsername || !gitEmail) {
      return jsonError(c, "BAD_REQUEST", "displayName, gitUsername and gitEmail are required");
    }
    const sshKeyPath = b.sshKeyPath ? String(b.sshKeyPath) : null;
    const id = createIdentity({ displayName, gitUsername, gitEmail, sshKeyPath });
    return c.json({ identity: getIdentity(id) }, 201);
  });

  app.put("/api/identities/:id", async (c) => {
    const id = c.req.param("id");
    if (!getIdentity(id)) return jsonError(c, "NOT_FOUND", "identity not found");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    updateIdentity(id, {
      displayName: b.displayName != null ? String(b.displayName) : undefined,
      gitUsername: b.gitUsername != null ? String(b.gitUsername) : undefined,
      gitEmail: b.gitEmail != null ? String(b.gitEmail) : undefined,
      sshKeyPath: b.sshKeyPath === undefined ? undefined : b.sshKeyPath ? String(b.sshKeyPath) : null,
    });
    return c.json({ identity: getIdentity(id) });
  });

  app.delete("/api/identities/:id", (c) => {
    const id = c.req.param("id");
    return deleteIdentity(id) ? c.json({ ok: true }) : jsonError(c, "NOT_FOUND", "identity not found");
  });

  // ── assign identity to a repo ──────────────────────────────────────────────
  app.post("/api/repos/:id/identity", async (c) => {
    const repoId = c.req.param("id");
    if (!getRepo(repoId)) return jsonError(c, "NOT_FOUND", "repo not found");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const identityId = b.identityId == null ? null : String(b.identityId);
    if (identityId && !getIdentity(identityId)) return jsonError(c, "NOT_FOUND", "identity not found");
    setRepoIdentity(repoId, identityId);
    broadcast("repo_identity_changed", { id: repoId, identityId });
    return c.json({ ok: true, repo: getRepo(repoId) });
  });

  // ── hide / unhide a repo from the dashboard (display-only) ───────────────────
  app.post("/api/repos/:id/hidden", async (c) => {
    const repoId = c.req.param("id");
    if (!getRepo(repoId)) return jsonError(c, "NOT_FOUND", "repo not found");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const hidden = b.hidden === true;
    setRepoHidden(repoId, hidden);
    broadcast("repo_hidden_changed", { id: repoId, hidden });
    return c.json({ ok: true, repo: getRepo(repoId) });
  });

  // ── pin / unpin a repo (moves it into the "Pinned" section; display-only) ────
  app.post("/api/repos/:id/pinned", async (c) => {
    const repoId = c.req.param("id");
    if (!getRepo(repoId)) return jsonError(c, "NOT_FOUND", "repo not found");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const pinned = b.pinned === true;
    setRepoPinned(repoId, pinned);
    broadcast("repo_pinned_changed", { id: repoId, pinned });
    return c.json({ ok: true, repo: getRepo(repoId) });
  });

  // ── star / unstar a repo (moves it into the "Starred" section; display-only) ──
  app.post("/api/repos/:id/starred", async (c) => {
    const repoId = c.req.param("id");
    if (!getRepo(repoId)) return jsonError(c, "NOT_FOUND", "repo not found");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const starred = b.starred === true;
    setRepoStarred(repoId, starred);
    broadcast("repo_starred_changed", { id: repoId, starred });
    return c.json({ ok: true, repo: getRepo(repoId) });
  });

  // ── safe git actions ───────────────────────────────────────────────────────
  const action = (fn: (id: string) => Promise<ActionOutcome>) => async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const r = await fn(id);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  };
  app.post("/api/repos/:id/fetch", action(fetchRepo));
  app.post("/api/repos/:id/pull", action(pullRepo));
  app.post("/api/repos/:id/push", action(pushRepo));
  app.post("/api/repos/:id/commit", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const message = String(b.message ?? "").trim();
    if (!message) return jsonError(c, "NO_MESSAGE", "commit message required");
    const r = await commitRepo(id, message, b.amend === true);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  app.post("/api/repos/:id/refresh", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const repo = await forceRefresh(id);
    return repo ? c.json({ repo }) : jsonError(c, "NOT_FOUND", "repo not found");
  });

  app.get("/api/repos/:id/changes", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const result = await getChanges(id);
    if (result.ok)
      return c.json({ files: result.files ?? [], total: result.total, truncated: result.truncated });
    return jsonError(c, result.code as ApiErrorCode, result.message ?? "could not read changes");
  });

  // Read one changed file's contents for the read-only viewer drawer. Path is a query
  // param (?path=…); it's normalised + confined to the repo in readFileContent.
  app.get("/api/repos/:id/file", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const path = c.req.query("path") ?? "";
    const ref = c.req.query("ref") === "head" ? "head" : "work";
    const result = await readFileContent(id, path, ref);
    if (result.ok) return c.json(result);
    // A bad/escaping path is a client error (400), not a 500; a missing repo/file is 404.
    return c.json(result, result.code === "NOT_FOUND" ? 404 : 400);
  });

  // Content search across the repo's CHANGED files (the changes tree only shows those).
  // Drives the "Search content" toggle; returns the matching repo-relative paths.
  app.get("/api/repos/:id/search", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const result = await searchChangedContent(id, c.req.query("q") ?? "");
    if (result.ok) return c.json({ paths: result.paths ?? [] });
    return jsonError(c, result.code as ApiErrorCode, result.message ?? "search failed");
  });

  // Both sides (HEAD + working tree) of a changed file, for the viewer's Diff tab.
  app.get("/api/repos/:id/diff", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const path = c.req.query("path") ?? "";
    const result = await readFileDiff(id, path);
    if (result.ok) return c.json(result);
    return c.json(result, result.code === "NOT_FOUND" ? 404 : 400);
  });

  // Save an edited file back to the working tree (the viewer's Edit mode). Same /api/* auth
  // gate as every other mutation; the path is confined to the repo inside writeFileContent.
  app.put("/api/repos/:id/file", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing repo id" }, 400);
    if (isRemoteRequest(c) && cfg.remoteEditing === false) {
      return c.json(
        { ok: false, code: "EDIT_REMOTE_DISABLED", message: "editing over remote access is turned off" },
        403,
      );
    }
    const path = c.req.query("path") ?? "";
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.content !== "string") {
      return c.json({ ok: false, code: "NO_CONTENT", message: "content (string) is required" }, 400);
    }
    const result = await writeFileContent(id, path, b.content);
    if (!result.ok) {
      const status: ContentfulStatusCode =
        result.code === "NOT_FOUND" ? 404 : result.code === "TOO_LARGE" ? 413 : 400;
      return c.json(result, status);
    }
    await forceRefresh(id); // re-stat the repo so the change list + badges update right away
    return c.json(result);
  });

  // ── AI: bring-your-own-key commit messages ──────────────────────────────────
  // The daemon makes every provider call; the owner's key never reaches the browser.
  // `cfg` is mutated in place AND persisted so a running daemon picks up new keys.
  const parseProvider = (c: Context): AiProviderId | null => {
    const p = c.req.param("provider") ?? "";
    return (AI_PROVIDERS as readonly string[]).includes(p) ? (p as AiProviderId) : null;
  };
  const ensureAi = (): NonNullable<GitmobConfig["ai"]> => (cfg.ai ??= { providers: {} });
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
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ai = ensureAi();
    if (b.style != null) {
      const style = String(b.style) as CommitStyle;
      if (["conventional", "concise", "detailed"].includes(style)) ai.style = style;
    }
    if (b.defaultProvider !== undefined) {
      const dp = b.defaultProvider == null ? undefined : (String(b.defaultProvider) as AiProviderId);
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
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const apiKey = String(b.apiKey ?? "").trim();
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
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ai = ensureAi();
    const entry = ai.providers[provider];
    if (b.model !== undefined && entry) entry.model = b.model == null ? null : String(b.model);
    if (b.makeDefault) ai.defaultProvider = provider;
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
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const requested = b.provider == null ? undefined : (String(b.provider) as AiProviderId);
    const provider = requested ?? effectiveDefaultProvider(cfg);
    if (!provider) return jsonError(c, "NO_AI_PROVIDER", "no AI provider configured");
    const apiKey = resolveApiKey(cfg, provider);
    if (!apiKey) return jsonError(c, "NO_AI_PROVIDER", `${provider} is not configured`);
    const model = resolveModel(cfg, provider);
    if (!model) return jsonError(c, "NO_MODEL", `pick a model for ${provider} in Settings`);

    const collected = await collectRepoDiff(id);
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

  // ── SSE stream ─────────────────────────────────────────────────────────────
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      let aborted = false;

      const listener = (event: string, data: string): void => {
        queue.push({ event, data });
        if (queue.length > MAX_SSE_QUEUE) queue.splice(0, queue.length - MAX_SSE_QUEUE);
        wake?.();
        wake = null;
      };
      addListener(listener);
      stream.onAbort(() => {
        aborted = true;
        removeListener(listener);
        wake?.();
        wake = null;
      });

      await stream.writeSSE({ event: "hello", data: JSON.stringify({ ok: true, version: VERSION }) });

      while (!aborted) {
        if (queue.length === 0) {
          let timeout: ReturnType<typeof setTimeout> | null = null;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timeout = setTimeout(resolve, 25_000);
          });
          if (timeout) clearTimeout(timeout);
          if (aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: String(Date.now()) });
            continue;
          }
        }
        while (queue.length > 0 && !aborted) {
          const batch = queue.splice(0);
          for (const m of batch) {
            if (aborted) break;
            await stream.writeSSE({ event: m.event, data: m.data });
          }
        }
      }
    }),
  );

  // ── static PWA — LAST, so it only catches non-API routes ────────────────────
  mountWeb(app);

  return app;
}

/** Path to the built PWA (`web/dist`). Works in dev (relative to this source) and
 * when compiled (a `web/dist` shipped next to the binary). */
function resolveWebRoot(): string {
  const candidates = [
    normalize(join(import.meta.dir, "..", "web", "dist")), // dev: src/../web/dist
    normalize(join(dirname(process.execPath), "web", "dist")), // compiled: next to the binary
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return candidates[0]!;
}
const WEB_ROOT = resolveWebRoot();

const EXTRA_MIME: Record<string, string> = {
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
// Vite emits content-addressed (hash-in-name) files under /assets — cache them forever.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// Extensions we serve as static files. A miss on one of these 404s instead of falling back
// to index.html (see mountWeb). Matching a known extension — rather than "any dot in the
// last segment" — keeps a future deep-link route like /repos/my.repo from wrongly 404ing.
const STATIC_EXT =
  /\.(?:js|mjs|css|map|json|webmanifest|wasm|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|txt|xml)$/i;

/**
 * Serve the SPA + assets with traversal protection.
 *
 * The SPA fallback to index.html applies ONLY to navigation requests — extension-less paths
 * ("/", "/settings", …). A miss on an actual asset request (under /assets/ or with a known
 * static extension, e.g. "/assets/MonacoViewer-abc.js") returns a clean 404 — NEVER
 * index.html. Serving index.html for a missing .js chunk hands the browser text/html for a
 * module script ("Failed to load module script … MIME type text/html"), which is exactly what
 * bit us every time a rebuild renamed a hashed chunk while an old tab was still open. The
 * client recovers from that 404 via a vite:preloadError reload (see web/src/main.ts).
 *
 * Caching: hashed /assets/* are immutable; everything else (index.html, sw.js, registerSW.js,
 * the manifest, icon) is no-cache so a rebuild — most importantly the entry point and the
 * service worker — is always revalidated and picked up.
 */
function mountWeb(app: Hono): void {
  app.get("/*", async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const filePath = normalize(join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT)) return c.text("forbidden", 403);

    const lastSeg = pathname.slice(pathname.lastIndexOf("/") + 1);
    const isAssetRequest = pathname.startsWith("/assets/") || STATIC_EXT.test(lastSeg);

    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const headers: Record<string, string> = {
        "cache-control": pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : "no-cache",
      };
      if (EXTRA_MIME[ext]) headers["content-type"] = EXTRA_MIME[ext];
      return new Response(file, { headers });
    }

    // Missing asset → real 404, never the HTML fallback (avoids the module-MIME trap).
    if (isAssetRequest) return c.text("not found", 404, { "cache-control": "no-store" });

    // Navigation route → SPA fallback to index.html, always revalidated.
    const index = Bun.file(join(WEB_ROOT, "index.html"));
    if (!(await index.exists())) {
      return c.text("web app not built — run: bun run --cwd web build:fast", 503);
    }
    return new Response(index, { headers: { "cache-control": "no-cache" } });
  });
}
