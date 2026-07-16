/**
 * HTTP surface (Hono) composition root + the SSE endpoint.
 *
 * This thin root wires per-domain route modules (src/http/routes/*) onto one Hono app behind
 * the single /api/* auth middleware, then mounts the static PWA last. The daemon binds to
 * 127.0.0.1 only (see index.ts). Auth is one middleware in front of /api/* (docs/ARCHITECTURE.md §7).
 */
import { Hono } from "hono";
import type { RepoYetiConfig } from "../config.ts";
import { authMiddleware, isRemoteRequest } from "../auth.ts";
import { loopbackGuard } from "../loopback-guard.mjs";
import { mountWeb } from "./web.ts";
import type { Deps } from "./deps.ts";
import { setDiffStatsEnabled } from "../read/diffstat.ts";
import { setDiffPatchBytes, setDiffPatchEnabled } from "../service/index.ts";
import {
  setSyncCheckEnabled,
  setKeepInSync,
  setSyncIntervalSecs,
  SYNC_INTERVAL_DEFAULT_S,
} from "../remote-sync.ts";
import {
  setAutoCommitConfig,
  setAutoCommitEnabled,
  setAutoCommitMode,
  setAutoCommitIntervalSecs,
  setAutoCommitAt,
  setAutoCommitPull,
  setAutoCommitPush,
  AUTO_COMMIT_INTERVAL_DEFAULT_S,
  AUTO_COMMIT_AT_DEFAULT,
} from "../auto-commit.ts";
import {
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
} from "../auto-update.ts";
import {
  setApprovalGateEnabled,
  setApprovalTimeoutSecs,
  setAutoDenyEnabled,
  setAutoApproveEnabled,
  setApproveTimeoutSecs,
  APPROVAL_TIMEOUT_DEFAULT_S,
} from "../approvals.ts";
import { setIdentityRulesConfig } from "../identity.ts";
import * as health from "./routes/health.ts";
import * as auth from "./routes/auth.ts";
import * as token from "./routes/token.ts";
import * as mode from "./routes/mode.ts";
import * as repos from "./routes/repos.ts";
import * as roots from "./routes/roots.ts";
import * as scan from "./routes/scan.ts";
import * as servers from "./routes/servers.ts";
import * as identities from "./routes/identities.ts";
import * as identityRules from "./routes/identity-rules.ts";
import * as accounts from "./routes/accounts.ts";
import * as repoFlags from "./routes/repo-flags.ts";
import * as gitOps from "./routes/git-ops.ts";
import * as branches from "./routes/branches.ts";
import * as log from "./routes/log.ts";
import * as stash from "./routes/stash.ts";
import * as tags from "./routes/tags.ts";
import * as remote from "./routes/remote.ts";
import * as files from "./routes/files.ts";
import * as editors from "./routes/editors.ts";
import * as ai from "./routes/ai.ts";
import * as updates from "./routes/updates.ts";
import * as events from "./routes/events.ts";
import * as openapi from "./routes/openapi.ts";
import * as mcp from "./routes/mcp.ts";
import * as sync from "./routes/sync.ts";
import * as approvals from "./routes/approvals.ts";
import * as shares from "./routes/shares.ts";

export interface AppHooks {
  requestShutdown?: () => void;
}

export function createApp(cfg: RepoYetiConfig, hooks: AppHooks = {}): Hono {
  // Startup side-effects: prime the runtime flags from this daemon's config before serving.
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
  // Auto-commit timer: hand the module the live config (for AI provider resolution) + prime its
  // runtime flags. Like the sync check, the timer only STARTS after boot (startAutoCommit in
  // lifecycle.ts), so this just primes flags — createApp() in tests never spins a real timer.
  setAutoCommitConfig(cfg);
  setAutoCommitEnabled(cfg.autoCommit === true); // opt-in (it pushes) → absent/false = off
  setAutoCommitMode(cfg.autoCommitMode === "daily" ? "daily" : "interval");
  setAutoCommitIntervalSecs(cfg.autoCommitIntervalSecs ?? AUTO_COMMIT_INTERVAL_DEFAULT_S);
  setAutoCommitAt(cfg.autoCommitAt ?? AUTO_COMMIT_AT_DEFAULT);
  setAutoCommitPull(cfg.autoCommitPull !== false); // absent = on
  setAutoCommitPush(cfg.autoCommitPush !== false); // absent = on
  // Auto-update: opt-in (it restarts the daemon) → absent/false = off. The timer only STARTS after
  // boot (startAutoUpdate in lifecycle.ts); this just primes the runtime flags.
  setAutoUpdateEnabled(cfg.autoUpdate === true);
  setAutoUpdateIntervalSecs(cfg.autoUpdateIntervalSecs ?? AUTO_UPDATE_INTERVAL_DEFAULT_S);
  // ⭐ Agent Safety Rail: gate defaults ON (absent = gated); timeouts default to 120s. Auto-deny
  // defaults ON (absent = the historic always-times-out behavior); auto-approve is opt-in (off).
  setApprovalGateEnabled(cfg.mcpApprovalGate !== false);
  setApprovalTimeoutSecs(cfg.mcpApprovalTimeoutSecs ?? APPROVAL_TIMEOUT_DEFAULT_S);
  setAutoDenyEnabled(cfg.mcpAutoDeny !== false);
  setAutoApproveEnabled(cfg.mcpAutoApprove === true);
  setApproveTimeoutSecs(cfg.mcpAutoApproveTimeoutSecs ?? APPROVAL_TIMEOUT_DEFAULT_S);
  // ⭐ Identity Firewall: hand the module the live config so every preflight check
  // (runAction / smartCommitRepo / commitSelectedRepo) reads the current `identityRules`.
  setIdentityRulesConfig(cfg);

  const app = new Hono();

  // CSRF / drive-by-RCE guard for the OPEN loopback path. In local mode the /api/* surface is
  // unauthenticated, so a malicious web page the owner visits could POST /api/repos/:id/remote,
  // /api/repos/clone, a commit + push, etc. and drive `git` with the owner's credentials — a
  // drive-by RCE. loopbackGuard rejects browser cross-site requests (Sec-Fetch-Site: cross-site,
  // non-loopback Origin, non-loopback Host — also catches the simple-request CORS bypass and
  // DNS-rebinding). It runs ONLY on the local path: a genuine tunnel request (isRemoteRequest)
  // legitimately carries a non-loopback Host/Origin and is already CSRF-gated by the SameSite
  // session cookie + authMiddleware, so the loopback guard must skip it. Registered BEFORE the auth
  // gate so the cheap provenance check fronts it. See src/http/loopback-guard.ts.
  app.use("/api/*", (c, next) => (isRemoteRequest(c) ? next() : loopbackGuard(c, next)));
  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  // MUST be registered first so it fronts every /api/* route below.
  app.use("/api/*", authMiddleware(cfg));

  const deps: Deps = { cfg, requestShutdown: hooks.requestShutdown };

  // Register every route module, preserving the original route registration order.
  health.register(app, deps);
  auth.register(app, deps);
  token.register(app, deps);
  mode.register(app, deps);
  repos.register(app, deps);
  roots.register(app, deps);
  scan.register(app, deps);
  servers.register(app, deps);
  identities.register(app, deps);
  identityRules.register(app, deps);
  accounts.register(app, deps);
  repoFlags.register(app, deps);
  gitOps.register(app, deps);
  branches.register(app, deps);
  log.register(app, deps);
  stash.register(app, deps);
  tags.register(app, deps);
  remote.register(app, deps);
  files.register(app, deps);
  editors.register(app, deps);
  ai.register(app, deps);
  updates.register(app, deps);
  events.register(app, deps);
  openapi.register(app, deps);
  mcp.register(app, deps);
  sync.register(app, deps);
  approvals.register(app, deps);
  // Share links: /api/shares/* (owner-gated like everything under /api/*) plus the public
  // GET /s/:token redemption. Registered before mountWeb so /s/... isn't eaten by the SPA fallback.
  shares.register(app, deps);

  // Static PWA — LAST, so the /* catch-all only catches non-API routes.
  mountWeb(app);

  return app;
}
