/**
 * HTTP surface (Hono) + the SSE endpoint.
 *
 * Phase 1: read API + SSE. Phase 3 adds identity CRUD, repo-identity assignment,
 * and the safe git actions (fetch/pull/push) with first-class error codes. There
 * is still NO auth here — that's Phase 2's single middleware in front of /api/*
 * (MARCHING_ORDERS §7). The daemon binds to 127.0.0.1 only (see index.ts).
 */
import { join, normalize, dirname, resolve } from "node:path";
import { pathWithin } from "./paths.ts";
import { existsSync, statSync } from "node:fs";
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
  type RepoYetiConfig,
  type AiProviderId,
} from "./config.ts";
import { listModels, generateCommitMessage, generateCommitPlan, heuristicPlan, AiError } from "./ai.ts";
import {
  authMiddleware,
  handleLogin,
  handleComplete,
  handleLogout,
  handleLogoutAll,
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
  checkoutRepo,
  createBranchRepo,
  deleteBranchRepo,
  stashSaveRepo,
  stashPopRepo,
  stashDropRepo,
  getBranches,
  getLog,
  getStashes,
  getTags,
  setRemoteRepo,
  removeRemoteRepo,
  createTagRepo,
  discardFile,
  planCommitInput,
  smartCommitRepo,
  forceRefresh,
  getChanges,
  searchChangedContent,
  MIN_CONTENT_SEARCH,
  readFileContent,
  readFileDiff,
  writeFileContent,
  collectRepoDiff,
  collectRepoPathsDiff,
  registerRepo,
  createRepo,
  cloneRepo,
  cloneLoreRepo,
  reorderRepos,
  fetchAllRepos,
  discoverRoot,
  forgetReposUnder,
  refreshAllRepos,
  getDiffPatchBytes,
  setDiffPatchBytes,
  getDiffPatchEnabled,
  setDiffPatchEnabled,
  type ActionOutcome,
} from "./service.ts";
import { diffStatsEnabled, setDiffStatsEnabled } from "./diffstat.ts";
import {
  syncCheckEnabled,
  keepInSyncEnabled,
  getSyncIntervalSecs,
  setSyncCheckEnabled,
  setKeepInSync,
  setSyncIntervalSecs,
  SYNC_INTERVAL_DEFAULT_S,
} from "./remote-sync.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "./contract.ts";
import { setSecret, deleteSecret, aiKeyName } from "./secrets.ts";
import {
  parseBody,
  IdentityCreateSchema,
  IdentityUpdateSchema,
  AssignIdentitySchema,
  RepoPathSchema,
  RootPathSchema,
  CloneSchema,
  ServerAddSchema,
  ServerCloneSchema,
  ReorderSchema,
  CommitSchema,
  CheckoutSchema,
  CreateBranchSchema,
  DeleteBranchSchema,
  StashSaveSchema,
  StashRefSchema,
  DiscardSchema,
  RemoteSetSchema,
  RemoteDeleteSchema,
  TagCreateSchema,
  ConnectSchema,
  AiSettingsSchema,
  ProviderUpdateSchema,
  CommitMessageSchema,
  CommitPlanSchema,
  SmartCommitSchema,
} from "./schemas.ts";

export function createApp(cfg: RepoYetiConfig): Hono {
  const app = new Hono();
  const MAX_SSE_QUEUE = 500;

  // Sync the runtime diff-stats flag to this daemon's config (off by default).
  setDiffStatsEnabled(!!cfg.diffStats);
  // Sync the file-viewer's large-file diff threshold (absent = built-in default; clamped).
  if (cfg.diffPatchBytes != null) setDiffPatchBytes(cfg.diffPatchBytes);
  // Sync the compact-diff on/off flag (absent = on; false = always side-by-side).
  if (typeof cfg.diffPatchEnabled === "boolean") setDiffPatchEnabled(cfg.diffPatchEnabled);
  // Sync the background remote-sync check (absent = on) + its cadence (absent = built-in default).
  // The timer itself only starts once the daemon has booted (startRemoteSync in index.ts), so
  // this just primes the runtime flags — createApp() in tests never spins a real timer.
  setSyncCheckEnabled(cfg.syncCheck !== false);
  setSyncIntervalSecs(cfg.syncIntervalSecs ?? SYNC_INTERVAL_DEFAULT_S);
  // "Keep in sync" (auto fast-forward) is opt-in → absent/false = off.
  setKeepInSync(cfg.keepInSync === true);

  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  app.use("/api/*", authMiddleware(cfg));

  // ── auth surface ───────────────────────────────────────────────────────────
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "repoyeti", version: VERSION, ts: Date.now() }),
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
      // Background remote-sync check: whether it runs + how often (seconds), so the Settings
      // UI reflects the live state on first load without a separate request.
      syncCheck: syncCheckEnabled(),
      syncIntervalSecs: getSyncIntervalSecs(),
      // "Keep in sync": whether the check also auto fast-forwards safe repos.
      keepInSync: keepInSyncEnabled(),
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
    if (typeof b.syncCheck === "boolean") {
      // Toggling the check starts/stops the daemon-wide fetch timer (see remote-sync.ts).
      cfg.syncCheck = b.syncCheck;
      setSyncCheckEnabled(b.syncCheck);
      saveConfig(cfg);
      broadcast("settings_changed", { syncCheck: cfg.syncCheck });
    }
    if (typeof b.syncIntervalSecs === "number" && Number.isFinite(b.syncIntervalSecs)) {
      // setSyncIntervalSecs clamps to [30, 3600] → persist the clamped value, not the raw input.
      cfg.syncIntervalSecs = setSyncIntervalSecs(b.syncIntervalSecs);
      saveConfig(cfg);
      broadcast("settings_changed", { syncIntervalSecs: cfg.syncIntervalSecs });
    }
    if (typeof b.keepInSync === "boolean") {
      cfg.keepInSync = b.keepInSync;
      setKeepInSync(b.keepInSync);
      saveConfig(cfg);
      broadcast("settings_changed", { keepInSync: cfg.keepInSync });
    }
    return c.json({
      ok: true,
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      diffPatchBytes: getDiffPatchBytes(),
      diffPatchEnabled: getDiffPatchEnabled(),
      syncCheck: syncCheckEnabled(),
      syncIntervalSecs: getSyncIntervalSecs(),
      keepInSync: keepInSyncEnabled(),
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
  // "Sign out everywhere" — rotate the signing key so every device's session cookie is
  // invalidated at once (sessions are stateless signed cookies; there is no row to revoke).
  app.post("/api/auth/logout-all", (c) => handleLogoutAll(c));
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
          "Sign in with Connections once to claim this RepoYeti before enabling remote access.",
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
      const p = await parseBody(c, RepoPathSchema);
      if (!p.ok) return p.res;
      const r = await handler(p.data.path);
      const status: ContentfulStatusCode = r.ok
        ? 201
        : r.code === "NOT_FOUND" || r.code === "NOT_A_REPO"
          ? 400
          : 409;
      return c.json(r, status);
    };
  app.post("/api/repos/register", repoFromPath(registerRepo));
  app.post("/api/repos/create", repoFromPath(createRepo));

  // Clone a remote into a folder under a scan root. Validated hard (URL scheme, target name,
  // and parent-under-root) before any git runs; the SSH key is injected per-op in cloneRepo.
  app.post("/api/repos/clone", async (c) => {
    const p = await parseBody(c, CloneSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeGitUrl(url)) return jsonError(c, "BAD_REQUEST", "not a recognizable git URL");
    const parentAbs = resolve(p.data.parentPath.trim());
    try {
      if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
        return jsonError(c, "BAD_REQUEST", "destination folder does not exist");
      }
    } catch {
      return jsonError(c, "BAD_REQUEST", "destination folder is not accessible");
    }
    if (!cfg.roots.some((r) => pathWithin(resolve(r), parentAbs))) {
      return jsonError(c, "BAD_REQUEST", "destination must be inside a scan folder");
    }
    const name = (p.data.name?.trim() || deriveCloneName(url));
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      return jsonError(c, "BAD_REQUEST", "invalid target folder name");
    }
    if (existsSync(join(parentAbs, name))) {
      return jsonError(c, "EXISTS", "a folder with that name already exists");
    }
    const result = await cloneRepo(parentAbs, name, url, p.data.identityId || null);
    if (result.ok) return c.json(result, 201);
    return c.json(result, statusForCode(result.code as ApiErrorCode));
  });

  // Persist a drag-to-reorder of the repo list. Body: { order: string[] } (repo ids).
  app.post("/api/repos/reorder", async (c) => {
    const p = await parseBody(c, ReorderSchema);
    if (!p.ok) return p.res;
    reorderRepos(p.data.order);
    return c.json({ ok: true });
  });

  // Fetch every repo that has a remote (bounded by the network gate). Returns a summary.
  app.post("/api/repos/fetch-all", async (c) => c.json(await fetchAllRepos()));

  // ── scan roots (list / add / remove a discovery root from the dashboard) ─────
  app.get("/api/roots", (c) => c.json({ roots: cfg.roots }));
  app.post("/api/roots", async (c) => {
    const p = await parseBody(c, RootPathSchema);
    if (!p.ok) return p.res;
    const abs = resolve(p.data.path);
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return jsonError(c, "BAD_REQUEST", "path does not exist or is not a directory");
      }
    } catch {
      return jsonError(c, "BAD_REQUEST", "path is not accessible");
    }
    if (!cfg.roots.includes(abs)) {
      cfg.roots.push(abs);
      saveConfig(cfg);
    }
    // Discover in the background (a big root can take a while); repos stream in over SSE.
    void discoverRoot(abs, cfg.maxDepth, cfg.maxRepos).catch(() => {});
    return c.json({ ok: true, roots: cfg.roots });
  });
  app.delete("/api/roots", async (c) => {
    const p = await parseBody(c, RootPathSchema);
    if (!p.ok) return p.res;
    const abs = resolve(p.data.path);
    cfg.roots = cfg.roots.filter((r) => resolve(r) !== abs);
    saveConfig(cfg);
    const removed = forgetReposUnder(abs); // drop auto-discovered repos under it (live, over SSE)
    return c.json({ ok: true, roots: cfg.roots, removed });
  });

  // ── lore servers (registry + clone-from-server) ──────────────────────────────
  // A registered Lore server is just a server-of-record URL + display name; auth is delegated
  // to the Lore CLI's own session (`lore login`), so NO credentials are stored here.
  app.get("/api/servers", (c) => c.json({ servers: cfg.servers ?? [] }));
  app.post("/api/servers", async (c) => {
    const p = await parseBody(c, ServerAddSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeLoreUrl(url)) return jsonError(c, "BAD_REQUEST", "expected a lore:// or https:// server URL");
    const server = { id: crypto.randomUUID(), name: p.data.name?.trim() || url, url };
    cfg.servers = [...(cfg.servers ?? []), server];
    saveConfig(cfg);
    return c.json({ ok: true, server, servers: cfg.servers }, 201);
  });
  app.delete("/api/servers/:id", (c) => {
    const id = c.req.param("id");
    cfg.servers = (cfg.servers ?? []).filter((s) => s.id !== id);
    saveConfig(cfg);
    return c.json({ ok: true, servers: cfg.servers });
  });
  // Clone a Lore repo from a server URL into a folder under a scan root (mirrors /api/repos/clone).
  app.post("/api/servers/clone", async (c) => {
    const p = await parseBody(c, ServerCloneSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeLoreUrl(url)) return jsonError(c, "BAD_REQUEST", "expected a lore:// or https:// server URL");
    const parentAbs = resolve(p.data.parentPath.trim());
    try {
      if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
        return jsonError(c, "BAD_REQUEST", "destination folder does not exist");
      }
    } catch {
      return jsonError(c, "BAD_REQUEST", "destination folder is not accessible");
    }
    if (!cfg.roots.some((r) => pathWithin(resolve(r), parentAbs))) {
      return jsonError(c, "BAD_REQUEST", "destination must be inside a scan folder");
    }
    const name = p.data.name?.trim() || deriveCloneName(url);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      return jsonError(c, "BAD_REQUEST", "invalid target folder name");
    }
    if (existsSync(join(parentAbs, name))) return jsonError(c, "EXISTS", "a folder with that name already exists");
    const result = await cloneLoreRepo(parentAbs, name, url);
    return result.ok ? c.json(result, 201) : c.json(result, statusForCode(result.code as ApiErrorCode));
  });

  // ── identities (CRUD) ──────────────────────────────────────────────────────
  app.get("/api/identities", (c) => c.json({ identities: listIdentities() }));

  app.post("/api/identities", async (c) => {
    const p = await parseBody(c, IdentityCreateSchema);
    if (!p.ok) return p.res;
    const { displayName, gitUsername, gitEmail } = p.data;
    const id = createIdentity({ displayName, gitUsername, gitEmail, sshKeyPath: p.data.sshKeyPath || null });
    return c.json({ identity: getIdentity(id) }, 201);
  });

  app.put("/api/identities/:id", async (c) => {
    const id = c.req.param("id");
    if (!getIdentity(id)) return jsonError(c, "NOT_FOUND", "identity not found");
    const p = await parseBody(c, IdentityUpdateSchema);
    if (!p.ok) return p.res;
    const b = p.data;
    updateIdentity(id, {
      displayName: b.displayName,
      gitUsername: b.gitUsername,
      gitEmail: b.gitEmail,
      // undefined = leave unchanged; null or "" = clear it.
      sshKeyPath: b.sshKeyPath === undefined ? undefined : b.sshKeyPath || null,
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
    const p = await parseBody(c, AssignIdentitySchema);
    if (!p.ok) return p.res;
    const identityId = p.data.identityId || null;
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
    const p = await parseBody(c, CommitSchema);
    if (!p.ok) return p.res;
    const message = (p.data.message ?? "").trim();
    if (!message) return jsonError(c, "NO_MESSAGE", "commit message required");
    const r = await commitRepo(id, message, p.data.amend === true);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  // Smart commit: execute an (owner-edited) multi-commit plan — stage each group's files and
  // commit it in order, optionally syncing after. The body is validated against the live tree
  // in the service layer (PLAN_STALE / PLAN_PATHS_INVALID). See docs/SMART_COMMIT.md.
  app.post("/api/repos/:id/smart-commit", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, SmartCommitSchema);
    if (!p.ok) return p.res;
    const r = await smartCommitRepo(id, p.data.commits, p.data.sync === true);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  app.post("/api/repos/:id/refresh", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const repo = await forceRefresh(id);
    return repo ? c.json({ repo }) : jsonError(c, "NOT_FOUND", "repo not found");
  });

  // ── branches (list / switch / create / delete) ───────────────────────────────
  app.get("/api/repos/:id/branches", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(id)) return jsonError(c, "NOT_FOUND", "repo not found");
    return c.json(await getBranches(id));
  });
  app.post("/api/repos/:id/checkout", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, CheckoutSchema);
    if (!p.ok) return p.res;
    const r = await checkoutRepo(id, p.data.branch.trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/branch", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, CreateBranchSchema);
    if (!p.ok) return p.res;
    const r = await createBranchRepo(id, p.data.name.trim(), p.data.switch !== false);
    return c.json(r, r.ok ? 201 : statusForCode(r.code));
  });
  app.delete("/api/repos/:id/branch", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, DeleteBranchSchema);
    if (!p.ok) return p.res;
    const r = await deleteBranchRepo(id, p.data.name.trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  // ── commit history (read-only, paginated) ────────────────────────────────────
  app.get("/api/repos/:id/log", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(id)) return jsonError(c, "NOT_FOUND", "repo not found");
    const limit = Number(c.req.query("limit"));
    const skip = Number(c.req.query("skip"));
    return c.json(
      await getLog(
        id,
        Number.isFinite(limit) ? limit : undefined,
        Number.isFinite(skip) ? skip : undefined,
      ),
    );
  });

  // ── stash (list / save / pop / drop) ─────────────────────────────────────────
  app.get("/api/repos/:id/stashes", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(id)) return jsonError(c, "NOT_FOUND", "repo not found");
    return c.json(await getStashes(id));
  });
  app.post("/api/repos/:id/stash", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, StashSaveSchema);
    if (!p.ok) return p.res;
    const r = await stashSaveRepo(id, p.data.message);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/stash/pop", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, StashRefSchema);
    if (!p.ok) return p.res;
    const r = await stashPopRepo(id, p.data.index ?? 0);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/stash/drop", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, StashRefSchema);
    if (!p.ok) return p.res;
    const r = await stashDropRepo(id, p.data.index ?? 0);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  // ── tags (read-only) ─────────────────────────────────────────────────────────
  app.get("/api/repos/:id/tags", async (c) => {
    const id = c.req.param("id");
    if (!getRepo(id)) return jsonError(c, "NOT_FOUND", "repo not found");
    return c.json(await getTags(id));
  });
  // Create a tag (annotated when a message is given), optionally pushing it to origin.
  app.post("/api/repos/:id/tag", async (c) => {
    const id = c.req.param("id");
    const repo = getRepo(id);
    if (!repo) return jsonError(c, "NOT_FOUND", "repo not found");
    if (repo.vcs !== "git") return jsonError(c, "BAD_REQUEST", "tags are only available for git repos");
    const p = await parseBody(c, TagCreateSchema);
    if (!p.ok) return p.res;
    const r = await createTagRepo(id, p.data.name.trim(), p.data.message, p.data.push === true);
    return c.json(r, r.ok ? 201 : statusForCode(r.code));
  });

  // ── remote (set-url / add-or-update origin, remove) — local config, no network ──
  app.post("/api/repos/:id/remote", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, RemoteSetSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeGitUrl(url)) return jsonError(c, "BAD_REQUEST", "not a recognizable git URL");
    const r = await setRemoteRepo(id, (p.data.name || "origin").trim(), url);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.delete("/api/repos/:id/remote", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    const p = await parseBody(c, RemoteDeleteSchema);
    if (!p.ok) return p.res;
    const r = await removeRemoteRepo(id, (p.data.name || "origin").trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
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

  // Discard one changed file's working-tree changes (the changes-tree "Discard" action).
  // Destructive → gated behind the same remote-editing toggle as file writes (loopback always allowed).
  app.post("/api/repos/:id/discard", async (c) => {
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
    if (isRemoteRequest(c) && cfg.remoteEditing === false) {
      return c.json(
        { ok: false, code: "EDIT_REMOTE_DISABLED", message: "editing over remote access is turned off" },
        403,
      );
    }
    const p = await parseBody(c, DiscardSchema);
    if (!p.ok) return p.res;
    const result = await discardFile(id, p.data.path);
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode = result.code === "NOT_FOUND" ? 404 : statusForCode(result.code as ApiErrorCode);
    return c.json(result, status);
  });

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
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
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
    // whole working tree (the normal "✨ Generate" button).
    const collected =
      p.data.paths && p.data.paths.length
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
    const id = c.req.param("id");
    if (!id) return jsonError(c, "BAD_REQUEST", "missing repo id");
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

/** A conservative git-URL check: a known scheme, or the scp-like `user@host:path` form. Rejects
 *  a leading dash (flag injection) and bare local paths (which would dodge the root confinement). */
function looksLikeGitUrl(u: string): boolean {
  if (!u || u.startsWith("-")) return false;
  if (/^(https?|ssh|git|file):\/\/.+/i.test(u)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/.test(u)) return true; // git@github.com:org/repo.git
  return false;
}

/** A Lore server/repo URL: a lore:// or http(s):// URL. Rejects a leading dash (flag injection). */
function looksLikeLoreUrl(u: string): boolean {
  if (!u || u.startsWith("-")) return false;
  return /^(lore|https?):\/\/.+/i.test(u);
}

/** Derive a target folder name from a clone URL: last path segment, sans a trailing `.git`. */
function deriveCloneName(url: string): string {
  const cleaned = url.replace(/[/\\]+$/, "");
  const seg = cleaned.split(/[/\\:]/).pop() ?? "repo";
  return seg.replace(/\.git$/i, "") || "repo";
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
