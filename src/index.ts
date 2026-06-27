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
import { VERSION, loadConfig, addRoot, authEnforced } from "./config.ts";
import { initDb, upsertRepo, getRepos, getWatchableRepos } from "./db.ts";
import { discover } from "./discovery.ts";
import { createApp } from "./daemon.ts";
import { refreshRepo, startWatching, stopWatching } from "./service.ts";
import { startTunnel, type TunnelHandle } from "./tunnel.ts";
import { broadcast } from "./bus.ts";

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

  const liveCfg = loadConfig();
  initDb();

  // SECURITY: never expose a tunnel without app-layer auth.
  if (wantTunnel && !authEnforced(liveCfg)) {
    console.error(
      "Refusing to open a tunnel without auth.\n" +
        "Configure \"oauth\" in ~/.gitmob/config.json first (see MARCHING_ORDERS §13),\n" +
        "so only you — signed in with Connections — can reach the daemon over the network.",
    );
    process.exit(1);
  }

  if (liveCfg.roots.length === 0) {
    console.error(
      "No scan roots configured. Add one and restart:\n  gitmob add-root <path>\n  (or)  gitmob start --root <path>",
    );
    process.exit(1);
  }

  // 1) discover + index
  console.log(`Scanning ${liveCfg.roots.length} root(s) (depth ≤ ${liveCfg.maxDepth})…`);
  const found = discover(liveCfg.roots, liveCfg.maxDepth, liveCfg.maxRepos);
  for (const f of found) upsertRepo(f.absPath, f.name, "auto", f.isSubmodule);
  console.log(`Indexed ${found.length} repo(s).`);

  // 2) initial status read for every watchable repo (serialized per repo)
  const repos = getWatchableRepos();
  await Promise.all(repos.map((r) => refreshRepo(r.id, r.absPath)));

  // 3) watch each repo → refresh on change → SSE (registry lives in the service so
  //    repos registered/created at runtime get watched too)
  startWatching(repos);

  // 4) serve
  const app = createApp(liveCfg);
  const server = listen(app, port);
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`\ngitmob ${VERSION} daemon up`);
  console.log(`  local:  ${url}`);
  console.log(`  repos:  ${url}/api/repos`);
  console.log(`  events: ${url}/api/events  (SSE)`);
  console.log(
    `  auth:   ${authEnforced(liveCfg) ? "Sign in with Connections (enforced)" : "local only (no auth)"}`,
  );

  // 5) optional zero-config tunnel (auth already verified above)
  let tunnel: TunnelHandle | null = null;
  if (wantTunnel) {
    console.log("\nStarting cloudflared tunnel…");
    tunnel = startTunnel(
      server.port ?? port,
      (tunnelUrl) => {
        console.log(`\n  ▸ Remote URL:  ${tunnelUrl}\n`);
        qrcode.generate(tunnelUrl, { small: true });
        console.log("  Scan to open on your phone, then Sign in with Connections.\n");
        broadcast("daemon_status", { tunnelUrl });
      },
      (msg) => console.warn(`  ! tunnel: ${msg} (local access still works)`),
    );
  }

  console.log(`Watching ${repos.length} repo(s). Ctrl-C to stop.`);

  const shutdown = (): void => {
    tunnel?.stop();
    stopWatching();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
