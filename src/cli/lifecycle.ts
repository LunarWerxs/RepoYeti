/**
 * Daemon-lifecycle CLI commands: `start` (boot the daemon), `add-root`, `status`.
 *
 * Extracted verbatim from the old monolithic src/index.ts so the CLI entry stays a thin
 * dispatcher (src/cli/main.ts) and the git/agent verbs (src/cli/git.ts, src/cli/token.ts)
 * can live beside these without one giant entry file.
 */
import { spawn } from "node:child_process";
import { buildDetachedSpawn } from "../detached-spawn.mjs";
import { connect } from "node:net";
import { resolve } from "node:path";
import qrcode from "qrcode-terminal";
import { checkAiKeys } from "../ai-keycheck.ts";
import { fireBootPing } from "../app-ping.ts";
import { startAutoCommit, stopAutoCommit } from "../auto-commit.ts";
import { setAutoUpdateHooks, startAutoUpdate, stopAutoUpdate } from "../auto-update.ts";
import { addListener, broadcast, removeListener, type BusListener } from "../bus.ts";
import { startCollaborationSync, stopCollaborationSync } from "../collaboration.ts";
import {
  accessMode,
  addRoot,
  authEnforced,
  hydrateSecrets,
  loadConfig,
  relayEffective,
  type RepoYetiConfig,
  saveConfig,
  tunnelStartProblem,
  VERSION,
} from "../config.ts";
import { flushPending, initCloudSync, pullNow } from "../connections-sync.ts";
import {
  getLastIdentityMergeSummary,
  getRepo,
  getRepos,
  getWatchableRepos,
  initDb,
  upsertRepo,
} from "../db.ts";
import { discoverStream } from "../discovery.ts";
import { findFreePort } from "../find-free-port.mjs";
import { checkForUpdate as checkGithubReleasePing } from "../github-updater.ts";
import { createApp } from "../http/app.ts";
import {
  clearInstanceInfo,
  clearShutdownRequest,
  findLiveInstance,
  writeInstanceInfo,
} from "../instance.ts";
import { openUi } from "../open-ui.ts";
import { startRemoteSync, stopRemoteSync } from "../remote-sync.ts";
import { setServerPort, startManagedTunnel, stopManagedTunnel } from "../runtime.ts";
import {
  coalescedRefresh,
  refreshRepo,
  startWatching,
  stopWatching,
  watchOne,
} from "../service/index.ts";
import { cleanupStaleUpdateArtifacts } from "../updater.ts";

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

/** The relaunch signal, carried BOTH as this CLI flag and as REPOYETI_RELAUNCH=1. The flag is what
 *  survives the win32 WMI launch (which drops the env block); the env var covers the POSIX path and
 *  anything that reads it directly. `start`'s own flag loop ignores unknown flags, so the extra
 *  token is harmless to arg parsing. */
const RELAUNCH_FLAG = "--relaunch";
function isRelaunch(): boolean {
  return process.env.REPOYETI_RELAUNCH === "1" || process.argv.includes(RELAUNCH_FLAG);
}

/**
 * The argv that relaunches THIS build of RepoYeti, pinned to the port it is actually serving on.
 * Returns `[command, ...args]` ready for buildDetachedSpawn(). Pure + exported so the contract is
 * locked by tests/relaunch-argv.test.ts instead of being discovered in the field — all three things
 * below were wrong at once, and every one of them fails SILENTLY (the spawn still succeeds; the
 * successor is what dies), so the caller's catch never fires and this daemon shuts down 800ms later
 * believing a replacement is on the way.
 *
 * 1. THE EXECUTABLE. `process.argv[0..1]` is only the runtime + script in a source checkout. Inside
 *    a `bun build --compile` binary it is the placeholder pair ["bun", "B:/~BUN/root/repoyeti.exe"]:
 *    argv[0] is the literal string "bun", not a path, and argv[1] is a virtual path that exists only
 *    inside the running binary. Respawning it dies with `Module not found "B:/~BUN/root/repoyeti.exe"`
 *    where Bun happens to be installed, and cannot resolve "bun" at all on the machines a compiled
 *    release exists FOR ("no runtime to install" is the whole pitch). process.execPath is the real
 *    exe in both modes; only the script argument differs.
 *
 * 2. THE COMMAND TOKEN. `start` is IMPLICIT when no args are given (`main()` defaults to it), which
 *    is exactly how the documented "just run repoyeti-windows-x64.exe" path launches. Appending
 *    flags to that empty arg list puts a FLAG in the command slot, so the successor dispatched on
 *    "--relaunch", printed `Unknown command: --relaunch`, and exited 1. Name the command explicitly.
 *
 * 3. THE PORT. `--port` here is the port we BOUND, not the one we preferred; they diverge for every
 *    daemon that has ever hopped. The successor uses it for both waitForPortFree() and the bind, so
 *    the preferred port makes it wait out its full 8s on a socket nobody is releasing and then bind
 *    a port the user's open tab isn't on. Any inherited `--port` is dropped rather than trusted to
 *    last-wins parsing, and RELAUNCH_FLAG is re-appended rather than accumulated, so argv stays the
 *    same length no matter how many updates a daemon lives through.
 */
export function buildRelaunchArgv(
  argv: readonly string[],
  execPath: string,
  isCompiled: boolean,
  boundPort: number,
): string[] {
  const cliArgs = argv.slice(2);
  // A leading token that starts with "-" is a flag, not a command — `start` is implied.
  const hasCommand = cliArgs.length > 0 && !cliArgs[0]!.startsWith("-");
  const command = hasCommand ? cliArgs[0]! : "start";
  const rest = hasCommand ? cliArgs.slice(1) : cliArgs;

  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    // Mirror start()'s own flag loop, so a flag's VALUE can never be mistaken for a flag: --root
    // takes a path, and a path is allowed to be the literal string "--port".
    if (token === "--root" && rest[i + 1] !== undefined) {
      kept.push(token, rest[++i]!);
      continue;
    }
    if (token === "--port" && rest[i + 1] !== undefined) {
      i++; // drop the stale pair; the bound port is appended below
      continue;
    }
    if (token === RELAUNCH_FLAG) continue; // re-appended below, never accumulated
    kept.push(token);
  }

  const relaunchCli = [command, ...kept, "--port", String(boundPort), RELAUNCH_FLAG];
  return isCompiled ? [execPath, ...relaunchCli] : [execPath, argv[1]!, ...relaunchCli];
}

export async function start(rest: string[], options: { openUi?: boolean } = {}): Promise<void> {
  cleanupStaleUpdateArtifacts();
  const cfg = loadConfig();

  // flags
  let port = Number(process.env.REPOYETI_PORT) || cfg.port;
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
  if (process.env.REPOYETI_DEV !== "1" && !isRelaunch()) {
    // Three probes, not one. instance-pointer.mjs's own docstring calls a single probe "a COIN
    // FLIP" here and says spawn-deciding callers must pass attempts >= 2: a live daemon that
    // happens to be mid-scan can miss one 1s health probe, and the answer to "is one already
    // running?" is then wrong in the expensive direction. writeInstanceInfo() overwrites the
    // runtime pointer unconditionally, so the second daemon takes ownership of it while the
    // first keeps serving and both write the same SQLite file — and the tray, launcher and MCP
    // all follow whichever one wrote last.
    const live = await findLiveInstance(1000, 3);
    if (live) {
      console.log(`\nRepoYeti is already running → ${live.url}\nNot starting a second instance.\n`);
      if (options.openUi) openUi(live.url);
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
      "First run: no watched folders yet. RepoYeti is ready; use Scan for projects (whole\n" +
        "computer or a specific folder) in the dashboard, or run: repoyeti add-root <path>",
    );
  }

  // 1) Serve immediately on whatever the DB already knows from a previous run — discovery
  //    (step 6) then runs in the BACKGROUND, so a large/slow root never blocks the daemon
  //    from coming up. On a fresh install the list starts empty and fills in live over SSE.
  const known = getWatchableRepos();
  const knownIds = new Set(known.map((r) => r.id));

  // 2) watch known repos → refresh on change → SSE. Set up BEFORE serving so a change during
  //    boot isn't missed. Repos found later by discovery are watched as they're indexed.
  await startWatching(known);

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
    stopCollaborationSync();
    stopWatching();
    void Promise.race([
      flushPending(liveCfg).catch((error) => {
        console.error(
          `repoyeti: final settings sync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]).finally(() => {
      clearInstanceInfo();
      server?.stop(true);
      process.exit(0);
    });
  };

  const app = createApp(liveCfg, { requestShutdown: shutdown });
  // A daemon relaunched by the auto-updater (REPOYETI_RELAUNCH=1) waits for its predecessor to free
  // the preferred port so it rebinds the SAME port — an open browser tab's SSE then reconnects
  // seamlessly instead of the daemon hopping to a port the tab can't reach.
  if (isRelaunch()) await waitForPortFree(port, 8000);
  server = await listen(app, port);
  // Where we ACTUALLY landed. `port` above is only the preference; these two diverge the moment
  // anything else holds it, and everything downstream (the runtime pointer, the tunnel, the
  // auto-update handoff) has to follow the bound one or it points at a port nobody is serving.
  const boundPort = server.port ?? port;
  const url = `http://127.0.0.1:${boundPort}`;
  // Advertise where we actually landed (the port may have hopped) so the launcher
  // opens the right URL and a second launch can detect us. Cleared on clean exit. The extra
  // portableMode field lets the tray launcher pick an app-window vs. a normal tab on cold start,
  // before the daemon (and therefore /api/status) is reachable. hideTrayIcon likewise lets the
  // tray gate its NotifyIcon's .Visible on cold start before the daemon is reachable.
  writeInstanceInfo(boundPort, {
    portableMode: liveCfg.portableMode === true,
    hideTrayIcon: liveCfg.hideTrayIcon === true,
  });
  // Clear any stale "full shutdown" sentinel from a previous (possibly hard-killed) run so a
  // leftover can't make a freshly-launched tray quit the instant it starts; only a genuine
  // in-session UI shutdown (POST /api/shutdown) writes a fresh one. See src/instance.ts.
  clearShutdownRequest();

  // Anonymous install/update-check ping to Connections Studio (see src/app-ping.ts) — fired here,
  // in the DAEMON boot path, so a headless/tray-only daemon nobody ever dashboards into still gets
  // counted. Fire-and-forget: never awaited, so it cannot delay anything below; throttled to at
  // most once per 24h via a persisted timestamp, and skipped entirely under REPOYETI_NO_PING=1,
  // NODE_ENV=test, CI, or REPOYETI_DEV=1. Calls github-updater.ts's checkForUpdate directly (not
  // src/updater.ts's compiled/source dispatch) so a source checkout — which has no
  // api.github.com-based check of its own — still gets pinged, not only compiled releases.
  fireBootPing(() => checkGithubReleasePing({ fresh: true }));

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
  if (options.openUi && !openUi(url)) {
    console.error(`Could not open a browser automatically. Open ${url} manually.`);
  }

  // 5) remote access — auto-managed by runtime.ts (also driven by the Settings toggle via
  //    PUT /api/mode). Open a tunnel now for an explicit --tunnel, or because the saved mode
  //    is "remote" with an owner already claimed (never expose before TOFU is settled).
  setServerPort(boundPort);
  const ownerClaimed = !!(liveCfg.oauth?.ownerSub || liveCfg.oauth?.ownerEmail);
  if (wantTunnel || (accessMode(liveCfg) === "remote" && ownerClaimed)) {
    console.log("\nStarting cloudflared tunnel…");
    const showQr = (label: string, url: string): void => {
      console.log(`\n  ▸ ${label}  ${url}\n`);
      qrcode.generate(url, { small: true });
      console.log("  Scan to open on your phone, then Sign in with Connections.\n");
    };
    startManagedTunnel(
      liveCfg,
      (tunnelUrl) => {
        // With the relay on (the default), the scannable code must be the STABLE
        // `<relay>/r/<id>` address, not the raw quick-tunnel URL: the raw hostname rotates on
        // every restart, so a phone that bookmarks it loses access the moment the daemon is
        // updated (issue #15). The stable address only goes live once the relay announce is
        // accepted, which runtime.ts reports over the bus as a `daemon_status` event carrying
        // `relayAnnounced` — subscribe here, BEFORE publishRemoteRoutes fires (onReady runs
        // synchronously inside onUrl), so the terminal state can't be missed.
        if (!relayEffective(liveCfg).enabled) {
          // Named tunnel or explicit opt-out: the URL is already the one to keep (named) or the
          // one the owner chose (opted out) — QR it immediately, exactly as before.
          showQr("Remote URL:", tunnelUrl);
          return;
        }
        console.log(`\n  ▸ Remote URL:  ${tunnelUrl}  (rotates on every restart)\n`);
        let settled = false;
        const finish = (print: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          removeListener(onStatus);
          print();
        };
        // Belt and braces: announce retries run 1s+3s+10s, so if no terminal relay state has
        // arrived well past that, print the raw QR rather than leave nothing scannable.
        const fallback = setTimeout(() => finish(() => showQr("Remote URL:", tunnelUrl)), 20_000);
        const onStatus: BusListener = (event, _data, payload) => {
          if (event !== "daemon_status" || typeof payload !== "object" || payload === null) return;
          const p = payload as { relayAnnounced?: boolean; relayUrl?: string | null; relayError?: string | null };
          // Tunnel-only status broadcasts carry no relayAnnounced; only a terminal announce does.
          if (typeof p.relayAnnounced !== "boolean") return;
          finish(() => {
            if (p.relayAnnounced && p.relayUrl) {
              showQr("Stable URL:", p.relayUrl);
              console.log("  This address survives restarts and updates — safe to bookmark.\n");
            } else {
              showQr("Remote URL:", tunnelUrl);
              console.error(
                `  ⚠ Stable address unavailable (${p.relayError ?? "announce failed"}) — this URL changes on restart.\n`,
              );
            }
          });
        };
        addListener(onStatus);
      },
      // The daemon keeps serving locally when the tunnel dies, so this is a warning, not a fatal
      // error — but it must reach the terminal, or --tunnel just appears to hang.
      (message) => {
        console.error(`\n  ⚠ Tunnel not started: ${message}\n`);
        console.error("  RepoYeti is still running locally at the address above.\n");
      },
    );
  }

  // 6) progressive background hydration — readGate (see gitgate.ts) bounds the git fanout
  //    so this never floods the machine with children, and each repo broadcasts its status
  //    over SSE as it lands, so the dashboard fills in live without blocking startup.
  const initialHydration = hydrateInitialStatuses(known);
  void initialHydration;

  // 6b) start the background remote-sync check (if enabled in config). It periodically fetches
  //     every repo so the dashboard can warn when one falls behind its remote, broadcasting
  //     `repo_behind` on a fresh fall-behind. Arm it only AFTER initial hydration drains: merely
  //     kicking hydration off was insufficient for a huge dirty repo, where the first timed fetch
  //     arrived while startup Git reads were still running and doubled the process fan-out.
  void initialHydration.then(() => startRemoteSync());

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
        // Through buildDetachedSpawn, like every other detached launch here (editors, the
        // portable window). `detached: true` is NOT a tree escape on Windows — detached-spawn's
        // own header says so, and it is the whole reason that primitive exists. Left as a plain
        // spawn, the successor stayed inside this process's tree for the ~800ms handoff, so the
        // tray's Quit (`taskkill /T /F`, misc/tray-host-native) landing in that window killed
        // BOTH the outgoing daemon and the replacement, leaving the user with none.
        //
        // The relaunch signal rides as a CLI FLAG (`--relaunch`), NOT only as an env var. On
        // win32 buildDetachedSpawn hands the launch to WMI Win32_Process.Create, which takes a
        // command-LINE and does NOT inherit the caller's environment block — so an env-only
        // signal reached the transient powershell.exe and never the actual successor daemon. The
        // successor then saw the predecessor still alive, concluded "already running", and exited:
        // an applied update leaving ZERO daemons. A flag is part of the command line WMI does
        // deliver. The env var is kept too, so the POSIX (env-inheriting) path is belt-and-braces.
        //
        // That same env-block drop is why the bound port rides as `--port <n>` rather than as
        // REPOYETI_PORT: on win32 an env-only handover reaches the transient powershell.exe and
        // never the successor daemon. See buildRelaunchArgv for the other two things this argv has
        // to get right (the compiled binary's placeholder argv, and the implicit `start` command).
        const relaunchArgv = buildRelaunchArgv(
          process.argv,
          process.execPath,
          (globalThis as { __REPOYETI_RELEASE_BUILD__?: boolean }).__REPOYETI_RELEASE_BUILD__ === true,
          boundPort,
        );
        const plan = buildDetachedSpawn(process.platform, relaunchArgv);
        const child = spawn(plan.argv[0]!, plan.argv.slice(1), {
          cwd: process.cwd(),
          detached: plan.detached,
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

  // 6e) outbound collaboration presence. Joined workspaces publish only compact encrypted
  // status/path snapshots; the timer is inert when this daemon has not joined any.
  startCollaborationSync();

  // 6f) best-effort AI key liveness check (owner-keyed providers only). A key that went dead
  //     between runs surfaces as a dashboard notification now, instead of a cryptic failure at the
  //     owner's next "Generate". Fire-and-forget — it runs after the server is already up (above),
  //     never blocks boot, and only a confirmed auth failure raises a notification.
  void checkAiKeys(liveCfg);

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
  // readGate bounds Git children, and this outer worker pool also bounds the promises/closures
  // waiting to reach it. A 5,000-repo index should not enqueue 5,000 async call chains at boot.
  let next = 0;
  const workers = Math.min(16, repos.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const index = next++;
        if (index >= repos.length) return;
        const repo = repos[index]!;
        // Swallowed per-repo: readStatus already encodes failures into the status row, so a bad
        // repo can't crash the batch or block its siblings from hydrating.
        await refreshRepo(repo.id, repo.absPath).catch(() => {});
      }
    }),
  );
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
      if (!knownIds.has(id)) {
        // Known repos are already in the bounded initial-hydration pool above. Refreshing them
        // again as discovery rediscovers each path used to duplicate the entire startup Git load.
        // Only genuinely new rows need a fire-and-forget first status here.
        coalescedRefresh(id, f.absPath);
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
