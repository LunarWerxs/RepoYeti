/**
 * HTTP surface (Hono) composition root + the SSE endpoint.
 *
 * This thin root wires per-domain route modules (src/http/routes/*) onto one Hono app behind
 * the single /api/* auth middleware, then mounts the static PWA last. The daemon binds to
 * 127.0.0.1 only (see index.ts). Auth is one middleware in front of /api/* (ARCHITECTURE.md §7).
 */
import { Hono } from "hono";
import type { RepoYetiConfig } from "../config.ts";
import { authMiddleware } from "../auth.ts";
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
import * as health from "./routes/health.ts";
import * as auth from "./routes/auth.ts";
import * as mode from "./routes/mode.ts";
import * as repos from "./routes/repos.ts";
import * as roots from "./routes/roots.ts";
import * as servers from "./routes/servers.ts";
import * as identities from "./routes/identities.ts";
import * as repoFlags from "./routes/repo-flags.ts";
import * as gitOps from "./routes/git-ops.ts";
import * as branches from "./routes/branches.ts";
import * as log from "./routes/log.ts";
import * as stash from "./routes/stash.ts";
import * as tags from "./routes/tags.ts";
import * as remote from "./routes/remote.ts";
import * as files from "./routes/files.ts";
import * as ai from "./routes/ai.ts";
import * as events from "./routes/events.ts";
import * as openapi from "./routes/openapi.ts";

export function createApp(cfg: RepoYetiConfig): Hono {
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

  const app = new Hono();

  // Auth gate — applies to /api/* only; no-op when OIDC isn't configured (local mode).
  // MUST be registered first so it fronts every /api/* route below.
  app.use("/api/*", authMiddleware(cfg));

  const deps: Deps = { cfg };

  // Register every route module, preserving the original route registration order.
  health.register(app, deps);
  auth.register(app, deps);
  mode.register(app, deps);
  repos.register(app, deps);
  roots.register(app, deps);
  servers.register(app, deps);
  identities.register(app, deps);
  repoFlags.register(app, deps);
  gitOps.register(app, deps);
  branches.register(app, deps);
  log.register(app, deps);
  stash.register(app, deps);
  tags.register(app, deps);
  remote.register(app, deps);
  files.register(app, deps);
  ai.register(app, deps);
  events.register(app, deps);
  openapi.register(app, deps);

  // Static PWA — LAST, so the /* catch-all only catches non-API routes.
  mountWeb(app);

  return app;
}
