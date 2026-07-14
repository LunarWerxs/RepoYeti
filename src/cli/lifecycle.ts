/**
 * Daemon-lifecycle CLI commands: `start` (boot the daemon), `add-root`, `status`.
 *
 * Extracted verbatim from the old monolithic src/index.ts so the CLI entry stays a thin
 * dispatcher (src/cli/main.ts) and the git/agent verbs (src/cli/git.ts, src/cli/token.ts)
 * can live beside these without one giant entry file.
 */
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import qrcode from "qrcode-terminal";
import {
  VERSION,
  loadConfig,
  saveConfig,
  addRoot,
  authEnforced,
  accessMode,
  tunnelStartProblem,
  hydrateSecrets,
  type RepoYetiConfig,
} from "../config.ts";
import { initDb, upsertRepo, getRepo, getRepos, getWatchableRepos, getLastIdentityMergeSummary } from "../db.ts";
import { discoverStream } from "../discovery.ts";
import { createApp } from "../http/app.ts";
import { initCloudSync, pullNow } from "../connections-sync.ts";
import { refreshRepo, startWatching, watchOne, stopWatching } from "../service/index.ts";
import { startRemoteSync, stopRemoteSync } from "../remote-sync.ts";
import { startAutoCommit, stopAutoCommit } from "../auto-commit.ts";
import { startAutoUpdate, stopAutoUpdate, setAutoUpdateHooks } from "../auto-update.ts";
import { broadcast } from "../bus.ts";
import { setServerPort, startManagedTunnel, stopManagedTunnel } from "../runtime.ts";
import {
  clearInstanceInfo,
  clearShutdownRequest,
  findLiveInstance,
  writeInstanceInfo,
} from "../instance.ts";
import { findFreePort } from "../find-free-port.mjs";

// ── commands ──────────────────────────────────────────────────────────────────

export function addRootCmd(path: string | undefined): void {
  if (!path) {
    console.error("usage: repoyeti add-root <path>");
    process.exit(1);
  }
  const cfg = addRoot(path);
  console.log(`Added root: ${resolve(path)}`);
  console.log(`Roots now: ${cfg.roots.join(", ") || "(none)"}`);
}

export function statusCmd(): void {
  const cfg = loadConfig();
  initDb();
  const repos = getRepos();
  console.log(`repoyeti ${VERSION}`);
  console.log(`Roots: ${cfg.roots.join(", ") || "(none — add one with: repoyeti add-root <path>)"}`);
  console.log(`Repos indexed: ${repos.length}`);
  for (const r of repos.slice(0, 50)) {
    const s = r.status;
    const summary = s
      ? `${s.branch ?? "?"}${s.dirty ? ` ~${s.dirty}` : ""}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}${s.error ? ` ERR` : ""}`
      : "(no status)";
    console.log(`  • ${r.name.padEnd(28)} ${summary}`);
  }
}

/**
 * Repoint config.json's identityRules[].requiredIdentityId through the id→id remap produced by
 * initDb()'s one-time duplicate-identity merge (src/db.ts mergeDuplicateIdentities). A no-op
 * (and no save) when nothing merged, the overwhelmingly common case on every boot after the
 * first. Must run AFTER initDb() (so the merge has already happened) and BEFORE anything reads
 * `cfg.identityRules` for enforcement (setIdentityRulesConfig in app.ts, wired further down).
 */
function applyIdentityMergeToConfig(cfg: RepoYetiConfig): void {
  const { remap } = getLastIdentityMergeSummary();
  if (Object.keys(remap).length === 0 || !cfg.identityRules?.length) return;
  let changed = false;
  for (const rule of cfg.identityRules) {
    const survivor = remap[rule.requiredIdentityId];
    if (survivor) {
      rule.requiredIdentityId = survivor;
      changed = true;
    }
  }
  if (changed) {
    saveConfig(cfg);
    console.log("[repoyeti] identityRules: repointed rule(s) onto a merged identity's survivor");
  }
}

// ── daemon ────────────────────────────────────────────────────────────────────

export async function start(rest: string[]): Promise<void> {
  const cfg = loadConfig();

  // flags
  let port = cfg.port;
  let wantTunnel = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root" && rest[i + 1]) {
      addRoot(rest[++i]!);
    } else if (rest[i] === "--port" && rest[i + 1]) {
      port = Number(rest[++i]) || port;
    } else if (rest[i] === "--tunnel") {
      wantTunnel = true;
    }
  }

  // Single instance: if a RepoYeti daemon is already serving, don't start a second
  // one — it would just hop to another port (see `listen()`) and the launcher,
  // tunnel, and MCP would disagree about which instance is "the" one. The dev
  // watcher sets REPOYETI_DEV=1 (scripts/dev.ts) and must be free to rebind its port
  // on every reload, so that flow is exempt from this guard.
  // The auto-update successor (REPOYETI_RELAUNCH=1) is exempt too: its predecessor is
  // still alive and answering /api/health during the ~800ms handoff, so probing here
  // would see "already running" and make the successor exit, leaving ZERO daemons.
  // It instead falls through to the REPOYETI_RELAUNCH port-wait below and takes over.
  if (process.env.REPOYETI_DEV !== "1" && process.env.REPOYETI_RELAUNCH !== "1") {
    const live = await findLiveInstance();
    if (live) {
      console.log(`\nRepoYeti is already running → ${live.url}\nNot starting a second instance.\n`);
      process.exit(0);
    }
  }

  const liveCfg = loadConfig();
  initDb();
  // initDb() just merged any duplicate identities it found (see db.ts mergeDuplicateIdentities).
  // repos.identity_id and account_identities.identity_id are repointed automatically (they're
  // SQLite rows), but identityRules[].requiredIdentityId lives in config.json instead, so it needs
  // its own repoint pass here using the id to id remap the merge just produced.
  applyIdentityMergeToConfig(liveCfg);
  // Pull AI keys / OAuth client_secret from the OS keychain into the in-memory config (and
  // migrate any legacy plaintext secrets out of config.json), before anything serves.
  await hydrateSecrets(liveCfg);

  // SECURITY: never expose a tunnel without app-layer auth.
  const tunnelProblem = wantTunnel ? tunnelStartProblem(liveCfg) : null;
  if (tunnelProblem === "auth") {
    console.error(
      "Refusing to open a tunnel without auth.\n" +
        "Configure \"oauth\" in ~/.repoyeti/config.json first (see docs/ARCHITECTURE.md §13),\n" +
        "so only you — signed in with Connections — can reach the daemon over the network.",
    );
    process.exit(1);
  }
  if (tunnelProblem === "owner") {
    console.error(
      "Refusing to open a tunnel before an owner is configured.\n" +
        "Set oauth.ownerSub or oauth.ownerEmail in ~/.repoyeti/config.json first, or complete\n" +
        "a local-only pairing flow before exposing this daemon over the network.",
    );
    process.exit(1);
  }

  // No scan roots is a valid state now: the dashboard's "Scan for projects" can sweep the whole
  // computer (or a specific folder) on demand, and the daemon still serves whatever repos the DB
  // already knows. So DON'T exit — just note it and carry on. (A hard exit here is what bricked the
  // tray's "Rebuild & Restart" whenever roots happened to be empty.)
  if (liveCfg.roots.length === 0) {
    console.log(
      "No scan roots configured — starting anyway. Use Scan for projects (whole computer or a\n" +
        "specific folder) in the app, or add a watched root: repoyeti add-root <path>",
    );
  }

  // 1) Serve immediately on whatever the DB already knows from a previous run — discovery
  //    (step 6) then runs in the BACKGROUND, so a large/slow root never blocks the daemon
  //    from coming up. On a fresh install the list starts empty and fills in live over SSE.
  const known = getWatchableRepos();
  const knownIds = new Set(known.map((r) => r.id));

  // 2) watch known repos → refresh on change → SSE. Set up BEFORE serving so a change during
  //    boot isn't missed. Repos found later by discovery are watched as they're indexed.
  startWatching(known);

  // 3) serve immediately.
  let server: Awaited<ReturnType<typeof listen>> | null = null;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopManagedTunnel();
    stopRemoteSync();
    stopAutoCommit();
    stopAutoUpdate();
    stopWatching();
    clearInstanceInfo();
    server?.stop(true);
    process.exit(0);
  };

  const app = createApp(liveCfg, { requestShutdown: shutdown });
  // A daemon relaunched by the auto-updater (REPOYETI_RELAUNCH=1) waits for its predecessor to free
  // the preferred port so it rebinds the SAME port — an open browser tab's SSE then reconnects
  // seamlessly instead of the daemon hopping to a port the tab can't reach.
  if (process.env.REPOYETI_RELAUNCH === "1") await waitForPortFree(port, 8000);
  server = await listen(app, port);
  const url = `http://127.0.0.1:${server.port}`;
  // Advertise where we actually landed (the port may have hopped) so the launcher
  // opens the right URL and a second launch can detect us. Cleared on clean exit. The extra
  // portableMode field lets the tray launcher pick an app-window vs. a normal tab on cold start,
  // before the daemon (and therefore /api/status) is reachable. hideTrayIcon likewise lets the
  // tray gate its NotifyIcon's .Visible on cold start before the daemon is reachable.
  writeInstanceInfo(server.port ?? port, {
    portableMode: liveCfg.portableMode === true,
    hideTrayIcon: liveCfg.hideTrayIcon === true,
  });
  // Clear any stale "full shutdown" sentinel from a previous (possibly hard-killed) run so a
  // leftover can't make a freshly-launched tray quit the instant it starts; only a genuine
  // in-session UI shutdown (POST /api/shutdown) writes a fresh one. See src/instance.ts.
  clearShutdownRequest();

  // "Sync my settings with Connections" — load the persisted refresh token, then (if the owner
  // enabled sync) pull the cloud copy in the BACKGROUND so a fresh machine converges without
  // blocking boot on the network. Runtime flags primed by createApp() pick up any pulled config on
  // the next start; the appearance applies live via the settings_changed broadcast pullNow emits.
  void initCloudSync().then(() => {
    // Best-effort: a failed pull leaves the local config as-is; the next scheduled sync retries.
    if (liveCfg.cloudSync?.enabled && liveCfg.oauth) return pullNow(liveCfg, liveCfg.oauth).catch(() => {});
  });

  console.log(`\nrepoyeti ${VERSION} daemon up`);
  console.log(`  local:  ${url}`);
  console.log(`  repos:  ${url}/api/repos`);
  console.log(`  events: ${url}/api/events  (SSE)`);
  console.log(
    `  auth:   ${authEnforced(liveCfg) ? "Sign in with Connections (enforced)" : "local only (no auth)"}`,
  );
  if (authEnforced(liveCfg) && !liveCfg.oauth?.ownerSub && !liveCfg.oauth?.ownerEmail) {
    console.log("  owner:  unclaimed — the first Connections sign-in becomes the owner");
  }

  // 5) remote access — auto-managed by runtime.ts (also driven by the Settings toggle via
  //    PUT /api/mode). Open a tunnel now for an explicit --tunnel, or because the saved mode
  //    is "remote" with an owner already claimed (never expose before TOFU is settled).
  setServerPort(server.port ?? port);
  const ownerClaimed = !!(liveCfg.oauth?.ownerSub || liveCfg.oauth?.ownerEmail);
  if (wantTunnel || (accessMode(liveCfg) === "remote" && ownerClaimed)) {
    console.log("\nStarting cloudflared tunnel…");
    startManagedTunnel(liveCfg, (tunnelUrl) => {
      console.log(`\n  ▸ Remote URL:  ${tunnelUrl}\n`);
      qrcode.generate(tunnelUrl, { small: true });
      console.log("  Scan to open on your phone, then Sign in with Connections.\n");
    });
  }

  // 6) progressive background hydration — readGate (see gitgate.ts) bounds the git fanout
  //    so this never floods the machine with children, and each repo broadcasts its status
  //    over SSE as it lands, so the dashboard fills in live without blocking startup.
  void hydrateInitialStatuses(known);

  // 6b) start the background remote-sync check (if enabled in config). It periodically fetches
  //     every repo so the dashboard can warn when one falls behind its remote, broadcasting
  //     `repo_behind` on a fresh fall-behind. Started here — after hydration is kicked off — so
  //     the first network fetch happens one interval later, not in the boot stampede.
  startRemoteSync();

  // 6c) start the auto-commit timer (if enabled in config). For each repo the owner opted in, it
  //     Smart-Commits uncommitted changes on a schedule and — configurably — pulls + pushes. Like
  //     the sync check, it's armed here (after boot) so the first round is one interval out, not in
  //     the boot stampede. Conflicted / mid-operation repos are always skipped (never committed).
  startAutoCommit();

  // 6d) auto-update loop (opt-in; see src/auto-update.ts). When it applies an update it must restart
  //     the daemon ITSELF — the tray is a bare supervisor that never relaunches us. So hand it a
  //     relaunch that spawns a DETACHED copy of this exact launch command (REPOYETI_RELAUNCH=1 so the
  //     successor waits for our port), then gracefully shuts THIS daemon down to free the port.
  setAutoUpdateHooks({
    relaunch: () => {
      try {
        const child = spawn(process.argv[0]!, process.argv.slice(1), {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, REPOYETI_RELAUNCH: "1" },
        });
        child.unref();
      } catch (e) {
        console.error("repoyeti: auto-update relaunch failed to spawn — staying on the running version.", e);
        return; // never shut down without a successor
      }
      console.log("repoyeti: auto-update applied — relaunching the daemon…");
      setTimeout(shutdown, 800); // let the successor start, then free the port (same teardown as Ctrl-C)
    },
  });
  startAutoUpdate();

  // 7) discover the filesystem in the BACKGROUND — index/watch/refresh each repo as it's
  //    found and broadcast `repo_added` so the dashboard fills in live. A huge or slow root
  //    can take a while, but the daemon has already been serving since step 3.
  console.log(`Scanning ${liveCfg.roots.length} root(s) (depth ≤ ${liveCfg.maxDepth}) in the background…`);
  void runDiscovery(liveCfg, knownIds);

  console.log(`Serving ${known.length} known repo(s); discovery running. Ctrl-C to stop.`);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Read every repo's initial status in the background, bounded by the git read gate and
 * broadcasting each over SSE as it lands. Fire-and-forget: a slow or hung repo can delay
 * its own row filling in, but never the daemon serving. Per-repo errors are swallowed
 * (readStatus already encodes them into the status row).
 */
async function hydrateInitialStatuses(
  repos: Array<{ id: string; absPath: string }>,
): Promise<void> {
  // Swallowed per-repo: readStatus already encodes failures into the status row, so a bad
  // repo can't crash the batch or block its siblings from hydrating.
  await Promise.all(repos.map((r) => refreshRepo(r.id, r.absPath).catch(() => {})));
}

/**
 * Background filesystem discovery: async (non-blocking) BFS that indexes, watches, and
 * status-reads each repo as it's found. A repo the daemon didn't already know about
 * (`knownIds`) is announced over SSE as `repo_added` so the dashboard appends it live.
 * Fire-and-forget — errors are swallowed so a bad root can't crash the running daemon.
 */
async function runDiscovery(cfg: RepoYetiConfig, knownIds: Set<string>): Promise<void> {
  let added = 0;
  try {
    const total = await discoverStream(cfg.roots, cfg.maxDepth, cfg.maxRepos, (f) => {
      const id = upsertRepo(f.absPath, f.name, "auto", f.isSubmodule, f.vcs);
      // null → refused (path is under the OS temp dir); SKIP_DIRS already prunes these during the
      // walk, so this should essentially never fire, but never watch/broadcast a null id.
      if (!id) return;
      watchOne(id, f.absPath);
      // Fire-and-forget: a bad repo can't halt discovery; its status row just stays stale.
      void refreshRepo(id, f.absPath).catch(() => {});
      if (!knownIds.has(id)) {
        const repo = getRepo(id);
        if (repo) {
          added++;
          broadcast("repo_added", { repo });
        }
      }
    });
    console.log(`Discovery complete: ${total} repo(s) found (${added} new).`);
  } catch (e) {
    console.error(`Discovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** True when something is already LISTENING on 127.0.0.1:port (a successful TCP connect). Used by
 *  the auto-update relaunch to wait for the predecessor to release the preferred port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (inUse: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolveFree(inUse);
    };
    sock.setTimeout(500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false)); // ECONNREFUSED → nothing there → free
  });
}
/** Poll until the preferred port is free (predecessor released it), up to timeoutMs. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Bind on 127.0.0.1, auto-incrementing the port if it's taken. */
async function listen(app: ReturnType<typeof createApp>, startPort: number) {
  // Race-free probe via the shared kit helper (synced in as find-free-port.mjs),
  // then bind for real. Same 20-candidate walk the old inline Bun.serve loop did.
  const port = await findFreePort(startPort, 20, "127.0.0.1");
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0, // long-lived SSE; we send our own keepalive
    fetch: app.fetch,
  });
}
