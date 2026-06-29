#!/usr/bin/env bun
/**
 * gitmob CLI + daemon orchestration.
 *
 *   gitmob start [--root <path>] [--port <n>]   boot the daemon
 *   gitmob add-root <path>                       register a scan root
 *   gitmob status                                print config + repo count
 *
 * Phase 1 wiring: discover → watch (.git/HEAD,.git/index,logs) → status read
 * (serialized per repo) → SQLite → SSE. No auth, no tunnel yet.
 */
import { resolve } from "node:path";
import qrcode from "qrcode-terminal";
import {
  VERSION,
  loadConfig,
  addRoot,
  authEnforced,
  accessMode,
  tunnelStartProblem,
  hydrateSecrets,
  type GitmobConfig,
} from "./config.ts";
import { initDb, upsertRepo, getRepo, getRepos, getWatchableRepos } from "./db.ts";
import { discoverStream } from "./discovery.ts";
import { createApp } from "./daemon.ts";
import { refreshRepo, startWatching, watchOne, stopWatching } from "./service.ts";
import { broadcast } from "./bus.ts";
import { setServerPort, startManagedTunnel, stopManagedTunnel } from "./runtime.ts";
import { clearInstanceInfo, findLiveInstance, writeInstanceInfo } from "./instance.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "start";

switch (cmd) {
  case "start":
    await start(args.slice(1));
    break;
  case "add-root":
    addRootCmd(args[1]);
    break;
  case "status":
    statusCmd();
    break;
  case "-h":
  case "--help":
  case "help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
}

// ── commands ──────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`gitmob ${VERSION}

Usage:
  gitmob start [--root <path>] [--port <n>]   Boot the daemon
  gitmob add-root <path>                       Register a directory to scan
  gitmob status                                Show config + discovered repos
`);
}

function addRootCmd(path: string | undefined): void {
  if (!path) {
    console.error("usage: gitmob add-root <path>");
    process.exit(1);
  }
  const cfg = addRoot(path);
  console.log(`Added root: ${resolve(path)}`);
  console.log(`Roots now: ${cfg.roots.join(", ") || "(none)"}`);
}

function statusCmd(): void {
  const cfg = loadConfig();
  initDb();
  const repos = getRepos();
  console.log(`gitmob ${VERSION}`);
  console.log(`Roots: ${cfg.roots.join(", ") || "(none — add one with: gitmob add-root <path>)"}`);
  console.log(`Repos indexed: ${repos.length}`);
  for (const r of repos.slice(0, 50)) {
    const s = r.status;
    const summary = s
      ? `${s.branch ?? "?"}${s.dirty ? ` ~${s.dirty}` : ""}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}${s.error ? ` ERR` : ""}`
      : "(no status)";
    console.log(`  • ${r.name.padEnd(28)} ${summary}`);
  }
}

// ── daemon ────────────────────────────────────────────────────────────────────

async function start(rest: string[]): Promise<void> {
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

  // Single instance: if a GitMob daemon is already serving, don't start a second
  // one — it would just hop to another port (see `listen()`) and the launcher,
  // tunnel, and MCP would disagree about which instance is "the" one. The dev
  // watcher sets GITMOB_DEV=1 (scripts/dev.ts) and must be free to rebind its port
  // on every reload, so that flow is exempt from this guard.
  if (process.env.GITMOB_DEV !== "1") {
    const live = await findLiveInstance();
    if (live) {
      console.log(`\nGitMob is already running → ${live.url}\nNot starting a second instance.\n`);
      process.exit(0);
    }
  }

  const liveCfg = loadConfig();
  initDb();
  // Pull AI keys / OAuth client_secret from the OS keychain into the in-memory config (and
  // migrate any legacy plaintext secrets out of config.json), before anything serves.
  await hydrateSecrets(liveCfg);

  // SECURITY: never expose a tunnel without app-layer auth.
  const tunnelProblem = wantTunnel ? tunnelStartProblem(liveCfg) : null;
  if (tunnelProblem === "auth") {
    console.error(
      "Refusing to open a tunnel without auth.\n" +
        "Configure \"oauth\" in ~/.gitmob/config.json first (see MARCHING_ORDERS §13),\n" +
        "so only you — signed in with Connections — can reach the daemon over the network.",
    );
    process.exit(1);
  }
  if (tunnelProblem === "owner") {
    console.error(
      "Refusing to open a tunnel before an owner is configured.\n" +
        "Set oauth.ownerSub or oauth.ownerEmail in ~/.gitmob/config.json first, or complete\n" +
        "a local-only pairing flow before exposing this daemon over the network.",
    );
    process.exit(1);
  }

  if (liveCfg.roots.length === 0) {
    console.error(
      "No scan roots configured. Add one and restart:\n  gitmob add-root <path>\n  (or)  gitmob start --root <path>",
    );
    process.exit(1);
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
  const app = createApp(liveCfg);
  const server = listen(app, port);
  const url = `http://127.0.0.1:${server.port}`;
  // Advertise where we actually landed (the port may have hopped) so the launcher
  // opens the right URL and a second launch can detect us. Cleared on clean exit.
  writeInstanceInfo(server.port ?? port);
  console.log(`\ngitmob ${VERSION} daemon up`);
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
    startManagedTunnel((tunnelUrl) => {
      console.log(`\n  ▸ Remote URL:  ${tunnelUrl}\n`);
      qrcode.generate(tunnelUrl, { small: true });
      console.log("  Scan to open on your phone, then Sign in with Connections.\n");
    });
  }

  // 6) progressive background hydration — readGate (see gitgate.ts) bounds the git fanout
  //    so this never floods the machine with children, and each repo broadcasts its status
  //    over SSE as it lands, so the dashboard fills in live without blocking startup.
  void hydrateInitialStatuses(known);

  // 7) discover the filesystem in the BACKGROUND — index/watch/refresh each repo as it's
  //    found and broadcast `repo_added` so the dashboard fills in live. A huge or slow root
  //    can take a while, but the daemon has already been serving since step 3.
  console.log(`Scanning ${liveCfg.roots.length} root(s) (depth ≤ ${liveCfg.maxDepth}) in the background…`);
  void runDiscovery(liveCfg, knownIds);

  console.log(`Serving ${known.length} known repo(s); discovery running. Ctrl-C to stop.`);

  const shutdown = (): void => {
    stopManagedTunnel();
    stopWatching();
    clearInstanceInfo();
    server.stop(true);
    process.exit(0);
  };
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
  await Promise.all(repos.map((r) => refreshRepo(r.id, r.absPath).catch(() => {})));
}

/**
 * Background filesystem discovery: async (non-blocking) BFS that indexes, watches, and
 * status-reads each repo as it's found. A repo the daemon didn't already know about
 * (`knownIds`) is announced over SSE as `repo_added` so the dashboard appends it live.
 * Fire-and-forget — errors are swallowed so a bad root can't crash the running daemon.
 */
async function runDiscovery(cfg: GitmobConfig, knownIds: Set<string>): Promise<void> {
  let added = 0;
  try {
    const total = await discoverStream(cfg.roots, cfg.maxDepth, cfg.maxRepos, (f) => {
      const id = upsertRepo(f.absPath, f.name, "auto", f.isSubmodule);
      watchOne(id, f.absPath);
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

/** Bind on 127.0.0.1, auto-incrementing the port if it's taken. */
function listen(app: ReturnType<typeof createApp>, startPort: number) {
  let lastErr: unknown;
  for (let p = startPort; p < startPort + 20; p++) {
    try {
      return Bun.serve({
        port: p,
        hostname: "127.0.0.1",
        idleTimeout: 0, // long-lived SSE; we send our own keepalive
        fetch: app.fetch,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("no free port");
}
