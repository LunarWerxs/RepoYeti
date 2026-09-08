/**
 * HTTP surface (Hono) composition root + the SSE endpoint.
 *
 * This thin root wires per-domain route modules (src/http/routes/*) onto one Hono app behind
 * the single /api/* auth middleware, then mounts the static PWA last. The daemon binds to
 * 127.0.0.1 only (see index.ts). Auth is one middleware in front of /api/* (docs/ARCHITECTURE.md §7).
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { RepoYetiConfig } from "../config.ts";
import { jsonError } from "../contract.ts";
import { API_BODY_LIMIT } from "../schemas.ts";
import { authMiddleware, isRemoteRequest } from "../auth.ts";
import { createLoopbackGuard } from "../loopback-guard.mjs";
import { getServerPort } from "../runtime.ts";
import { asForeground } from "../gitgate.ts";
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
  setAutoCommitAiFallback,
  normalizeAiFallback,
  AUTO_COMMIT_INTERVAL_DEFAULT_S,
  AUTO_COMMIT_AT_DEFAULT,
} from "../auto-commit.ts";
import {
  setAutoUpdateEnabled,
  setUpdateNotifyEnabled,
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
import * as errors from "./routes/errors.ts";
import * as auth from "./routes/auth.ts";
import * as token from "./routes/token.ts";
import * as mode from "./routes/mode.ts";
import * as repos from "./routes/repos.ts";
import * as roots from "./routes/roots.ts";
import * as scan from "./routes/scan.ts";
import * as servers from "./routes/servers.ts";
import * as buzz from "./routes/buzz.ts";
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
import * as autoCommitIncidents from "./routes/auto-commit-incidents.ts";
import * as shares from "./routes/shares.ts";
import * as collaborations from "./routes/collaborations.ts";

export interface AppHooks {
  requestShutdown?: () => void;
}

/**
 * The Vite dev server's origins (web/vite.config.ts `server.port`, proxying /api → the daemon).
 * Only ever admitted under REPOYETI_DEV=1 — the flag scripts/dev.ts sets on the watched daemon —
 * because a browser fetch from the Vite page reaches the daemon with `Origin: http://localhost:4319`
 * and would otherwise be indistinguishable from the foreign-local-port attack below. Override or
 * extend with REPOYETI_DEV_ORIGINS (comma-separated) when the dev server runs somewhere else.
 */
const VITE_DEV_ORIGINS = ["http://localhost:4319", "http://127.0.0.1:4319"];

/**
 * The exact browser origins a loopback /api/* request may carry. This is the guard's opt-in
 * EXACT-ORIGIN mode (loopback-guard.mjs, AH-11), and it exists because the guard's default is too
 * loose for this daemon: by default any loopback Origin passes, whatever its port. Per the Fetch
 * spec a site ignores the port, so a page served from ANY other local port — a preview server, a
 * docs build, another daemon's dashboard, a tab a repo's own `npm run dev` opened — is "same-site"
 * with this API. Its browser stamps `Sec-Fetch-Site: same-site`, the guard's default accepts the
 * loopback Origin, and a simple text/plain POST from that page drives a mutating route with no
 * CORS preflight to stop it. In local mode that is an unauthenticated write; in remote mode the
 * owner's session cookie is host-scoped (cookies do not see ports) and rides along on it.
 *
 * So the allowlist is the daemon's OWN origin, in every spelling a browser can reach it by:
 * 127.0.0.1, localhost, and ::1 on the port it actually bound. A THUNK, read per request, because
 * that port is only known after listen() — `findFreePort` may have hopped off `cfg.port` — and
 * `createApp()` runs before it. Before the bind (a test, a CLI verb) the configured port stands in.
 *
 * Non-browser clients (curl, the tray probe, MCP over stdio, the CLI verbs) send no Origin and are
 * untouched by this: the guard only consults the allowlist when an Origin is present.
 */
export function trustedLocalOrigins(cfg: Pick<RepoYetiConfig, "port">): string[] {
  const port = getServerPort() || cfg.port;
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  if (process.env.REPOYETI_DEV === "1") {
    const extra = (process.env.REPOYETI_DEV_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    origins.push(...(extra.length ? extra : VITE_DEV_ORIGINS));
  }
  return origins;
}

export function createApp(cfg: RepoYetiConfig, hooks: AppHooks = {}): Hono {
  // Startup side-effects: prime the runtime flags from this daemon's config before serving.
  // Sync the runtime diff-stats flag to this daemon's config (off by default).
  setDiffStatsEnabled(!!cfg.diffStats);
  // Sync the file-viewer's large-file diff threshold (absent = built-in default; clamped).
  if (cfg.diffPatchBytes != null) setDiffPatchBytes(cfg.diffPatchBytes);
  // Sync the compact-diff on/off flag (absent = on; false = always side-by-side).
  if (typeof cfg.diffPatchEnabled === "boolean") setDiffPatchEnabled(cfg.diffPatchEnabled);
  // Sync the background remote-sync check (opt-in) + its cadence (absent = built-in default).
  // The timer itself only starts once the daemon has booted (startRemoteSync in index.ts), so
  // this just primes the runtime flags — createApp() in tests never spins a real timer.
  setSyncCheckEnabled(cfg.syncCheck === true);
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
  setAutoCommitAiFallback(normalizeAiFallback(cfg.autoCommitAiFallback)); // absent = "skip"
  // Auto-update. The timer only STARTS after boot (startAutoUpdate in lifecycle.ts); this just
  // primes the runtime flags. Two halves, two defaults: silent apply is opt-IN (it restarts the daemon), announcing an
  // update is opt-OUT (it only tells you). See src/auto-update.ts.
  setAutoUpdateEnabled(cfg.autoUpdate === true);
  setUpdateNotifyEnabled(cfg.updateNotify !== false);
  setAutoUpdateIntervalSecs(cfg.autoUpdateIntervalSecs ?? AUTO_UPDATE_INTERVAL_DEFAULT_S);
  // ⭐ Agent Safety Rail: gate defaults ON (absent = gated); timeouts default to 120s. Auto-deny
  // defaults ON (absent = the historic always-times-out behavior); auto-approve is opt-in (off).
  setApprovalGateEnabled(cfg.mcpApprovalGate !== false);
  setApprovalTimeoutSecs(cfg.mcpApprovalTimeoutSecs ?? APPROVAL_TIMEOUT_DEFAULT_S);
  // Auto-deny and auto-approve are mutually exclusive (see routes/health.ts). A config written
  // before that rule existed can still carry both, which would leave two timers racing to
  // opposite verdicts on the same pending approval. Normalise on the safe side: deny wins, so a
  // stale config can never silently start auto-APPROVING agent writes.
  const autoDeny = cfg.mcpAutoDeny !== false;
  const autoApprove = !autoDeny && cfg.mcpAutoApprove === true;
  setAutoDenyEnabled(autoDeny);
  setAutoApproveEnabled(autoApprove);
  setApproveTimeoutSecs(cfg.mcpAutoApproveTimeoutSecs ?? APPROVAL_TIMEOUT_DEFAULT_S);
  // ⭐ Identity Firewall: hand the module the live config so every preflight check
  // (runAction / smartCommitRepo / commitSelectedRepo) reads the current `identityRules`.
  setIdentityRulesConfig(cfg);

  const app = new Hono();

  // CSRF / drive-by-RCE guard for the OPEN loopback path. In local mode the /api/* surface is
  // unauthenticated, so a malicious web page the owner visits could POST /api/repos/:id/remote,
  // /api/repos/clone, a commit + push, etc. and drive `git` with the owner's credentials — a
  // drive-by RCE. The guard rejects browser cross-site requests (Sec-Fetch-Site: cross-site,
  // non-loopback Host — also catches the simple-request CORS bypass and DNS-rebinding) and, in the
  // exact-origin mode wired here, any Origin that is not this daemon's own (trustedLocalOrigins
  // above: a page on ANOTHER loopback port is same-site, not same-origin, and the guard's default
  // would have let it through). It runs ONLY on the local path: a genuine tunnel request
  // (isRemoteRequest) legitimately carries a non-loopback Host/Origin and is already CSRF-gated by
  // the SameSite session cookie + authMiddleware, so the loopback guard must skip it. Registered
  // BEFORE the auth gate so the cheap provenance check fronts it. See src/loopback-guard.mjs.
  const guard = createLoopbackGuard({ allowedOrigins: () => trustedLocalOrigins(cfg) });
  app.use("/api/*", (c, next) => (isRemoteRequest(c) ? next() : guard(c, next)));
  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  // MUST be registered first so it fronts every /api/* route below.
  app.use("/api/*", authMiddleware(cfg));

  // Default request-body ceiling for the whole API. Without one, every JSON route falls back to
  // Bun's ~128 MB default and fully buffers + JSON.parses the body BEFORE its zod schema ever
  // runs — so the validation that bounds each field does nothing to bound the allocation. Two of
  // those routes (stage, commit) are reachable by a share-link guest, who is by definition the
  // least-trusted caller the daemon has.
  //
  // 8 MB, not 1: the largest legitimate body is a 2 MB file write or conflict resolution
  // (MAX_FILE_BYTES / CONFLICT_APPLY_BODY_LIMIT), and JSON escaping inflates text on the way in.
  // This is a backstop against absurd bodies, not a per-route policy — routes that need a
  // tighter, exact bound still declare their own (see routes/files.ts conflict-apply), and
  // registering this AFTER the auth gate keeps an anonymous caller's answer a plain 401.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT,
      onError: (c) => jsonError(c, "BAD_REQUEST", "request body is too large", 413),
    }),
  );

  // Everything below this line is work someone is waiting on. Marking the whole /api/* surface
  // foreground lets those reads jump the git read gate ahead of boot hydration, the watcher's
  // coalesced refreshes and the remote-sync check — none of which reach Hono, so nothing that
  // isn't user-initiated can pick up the marker by accident. See src/gitgate.ts for the lanes.
  app.use("/api/*", (_c, next) => asForeground(next));

  const deps: Deps = { cfg, requestShutdown: hooks.requestShutdown };

  // Register every route module, preserving the original route registration order.
  health.register(app, deps);
  errors.register(app, deps);
  auth.register(app, deps);
  token.register(app, deps);
  mode.register(app, deps);
  repos.register(app, deps);
  roots.register(app, deps);
  scan.register(app, deps);
  servers.register(app, deps);
  buzz.register(app, deps);
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
  autoCommitIncidents.register(app, deps);
  collaborations.register(app, deps);
  // Share links: /api/shares/* (owner-gated like everything under /api/*) plus the public
  // GET /s/:token redemption. Registered before mountWeb so /s/... isn't eaten by the SPA fallback.
  shares.register(app, deps);

  // Static PWA — LAST, so the /* catch-all only catches non-API routes.
  mountWeb(app);

  return app;
}
