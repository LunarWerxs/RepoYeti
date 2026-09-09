/**
 * Stand up everything the browser gate needs, from nothing, in one process.
 *
 * WHY THIS EXISTS. Three behaviours this project depends on are invisible to every test it has:
 *
 *   · the loopback guard's exact-origin refusal (audit item 4). The unit tests fabricate the
 *     headers and call `createApp().request()`. That proves the DECISION table. It cannot prove
 *     that a real browser, on a real second loopback port, stamps the request the way the guard
 *     assumes — which is the entire premise of the fix.
 *   · SSE reconnect hydration (audit item 7). Its unit tests `vi.mock("@vueuse/core")` and drive
 *     a fake stream. No EventSource is ever opened, so nothing proves the dashboard converges
 *     after a genuine drop.
 *   · menus landing on screen (issue #15). `scripts/checks/popper-trigger-inside-tooltip.mjs`
 *     reads the Vue templates and proves the anchor wiring is structurally right. Whether the
 *     menu ends up inside the viewport is a question only a laid-out browser can answer.
 *
 * WHY IT IS SEPARATE FROM test/e2e. The existing E2E suite is a developer tool: it assumes a Vite
 * dev server on :4319 AND a live daemon AND a registered repository, i.e. the owner's real
 * machine. Nothing about that can run in CI, and pointing it at the owner's daemon in order to
 * "gate" a release would write scratch repositories into their database. This gate owns its
 * whole world instead: its own daemon, its own state directory, its own git fixtures, its own
 * second origin, all thrown away at the end.
 *
 * The daemon is booted the way scripts/smoke-release.ts boots the packaged binary — REPOYETI_HOME
 * at a scratch directory, an ephemeral port, no browser handoff — with the keychain forced
 * in-memory so the gate can never touch the owner's credential store, and REPOYETI_DEV
 * deliberately UNSET so the guard under test keeps its production allowlist.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import type { GateHandoff } from "./gate";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Reserve a free loopback port, then release it. A starting point, not a promise: the daemon's
 *  own findFreePort may still hop, which is why the bound port is read back from runtime.json. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        fail(new Error("browser gate: could not reserve a loopback port"));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? fail(err) : ok(port)));
    });
  });
}

/**
 * The bun executable, as an absolute path.
 *
 * Playwright's runner is a NODE program, and `spawn("bun")` from Node on Windows does not go
 * through the shell — so the `bun` on PATH being npm's shim (a shell script plus a .cmd) is an
 * ENOENT, not a launch. Resolving the real binary keeps the spawn shell-free, which is what makes
 * killTree's taskkill /T reliable: a shell in the middle owns the tree instead of us.
 */
function resolveBun(): string {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const explicit = process.env.REPOYETI_GATE_BUN;
  if (explicit && existsSync(explicit)) return explicit;
  // Already running under Bun (`bunx playwright ...`): use the very interpreter we are inside.
  if (/^bun(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? "")) return process.execPath;
  const candidates = [
    ...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"),
    join(process.env.BUN_INSTALL ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".bun"), "bin"),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `browser gate: could not find ${exe} on PATH. Set REPOYETI_GATE_BUN to its absolute path, or ` +
      "install bun (the daemon under test runs on it).",
  );
}

/** A real git repository the daemon will accept. `registerRepo` refuses anything that is not one. */
function makeFixtureRepo(path: string, name: string): void {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", args, {
      cwd: path,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  };
  git("-c", "init.defaultBranch=main", "init");
  // Local identity, so the gate works on a runner with no global git identity configured (the
  // same reason both workflows configure one before the daemon suite).
  git("config", "user.name", "RepoYeti browser gate");
  git("config", "user.email", "gate@users.noreply.github.com");
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-m", "seed");
}

/** The last few lines of the daemon log, so a boot failure reports the daemon's own reason. */
function tail(logPath: string, lines = 40): string {
  try {
    return readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no daemon log)";
  }
}

/**
 * Wait for the daemon to publish where it landed, then for it to actually answer.
 *
 * runtime.json rather than the console banner: the port may have hopped, and the pointer file is
 * the daemon's own authoritative answer to "where am I", written straight after bind.
 */
async function waitForDaemon(
  home: string,
  child: ChildProcess,
  logPath: string,
  spawnFailure: () => Error | null,
): Promise<string> {
  const runtimeFile = join(home, "runtime.json");
  const deadline = Date.now() + 90_000;
  let origin = "";
  while (Date.now() < deadline) {
    const failed = spawnFailure();
    if (failed) throw new Error(`browser gate: could not start the daemon: ${failed.message}`);
    if (child.exitCode !== null) {
      throw new Error(
        `browser gate: the daemon exited with code ${child.exitCode} before serving.\n${tail(logPath)}`,
      );
    }
    if (!origin && existsSync(runtimeFile)) {
      try {
        origin = (JSON.parse(readFileSync(runtimeFile, "utf8")) as { url?: string }).url ?? "";
      } catch {
        /* written but not yet flushed; try again */
      }
    }
    if (origin) {
      try {
        const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return origin;
      } catch {
        /* not up yet */
      }
    }
    await sleep(200);
  }
  throw new Error(`browser gate: the daemon never became reachable.\n${tail(logPath)}`);
}

/**
 * The attack page, served from a DIFFERENT loopback port.
 *
 * Per the Fetch spec a site ignores the port, so this page is "same-site" with the daemon: the
 * browser stamps `Sec-Fetch-Site: same-site`, and its Origin is a loopback origin. Under the
 * guard's DEFAULT mode both of those pass. Only the exact-origin allowlist (src/http/app.ts's
 * trustedLocalOrigins) refuses it, which is precisely what this gate exists to prove.
 *
 * The write is a CORS "simple request": `text/plain` is one of the three safelisted content
 * types, so the browser sends it with no preflight to stop it, and `parseBody` reads the body
 * with `c.req.json()` regardless of the declared type. `no-cors` keeps the page from needing a
 * readable response — a drive-by does not care what the daemon says back, only that it acted.
 */
function attackPage(daemonOrigin: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>foreign local origin</title></head>
  <body>
    <h1>A page on another local port</h1>
    <script>
      window.DAEMON = ${JSON.stringify(daemonOrigin)};
      window.driveByWrite = async function (path, body) {
        const res = await fetch(window.DAEMON + path, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(body),
        });
        return res.type;
      };
      // no-cors here too, deliberately. In cors mode this read would fail whatever the guard
      // does, because the daemon sends no Access-Control-Allow-Origin to anybody - so a passing
      // assertion would say nothing about the guard. Opaque mode sends the request for real and
      // lets the network layer report what the daemon actually answered.
      window.driveByRead = async function (path) {
        const res = await fetch(window.DAEMON + path, { method: "GET", mode: "no-cors" });
        return { status: res.status, type: res.type, body: await res.text() };
      };
    </script>
  </body>
</html>
`;
}

function startForeignOrigin(port: number, daemonOrigin: string): Promise<Server> {
  const html = attackPage(daemonOrigin);
  const server = createHttpServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] === "/attack.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // The daemon spawns git; SIGTERM to the direct child would orphan those. taskkill /T is the
    // only thing on Windows that takes the whole tree.
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  // The config's own directory, not process.cwd(): the gate must behave the same whether it is
  // started from web/ (`bun run test:gate`) or from the repo root with an explicit -c.
  const webRoot = config.configFile ? dirname(config.configFile) : config.rootDir;
  const appRoot = resolve(webRoot, "..");

  // web/.playwright/ is already gitignored, and unlike the OS temp directory it can hold the
  // fixture repositories: src/paths.ts's isUnderTempDir hard-refuses to import any repo rooted
  // under the real temp dir, which is the same reason tests/helpers/scratch.ts exists.
  const gateRoot = join(webRoot, ".playwright", "browser-gate");
  rmSync(gateRoot, { recursive: true, force: true });
  mkdirSync(gateRoot, { recursive: true });

  const dist = join(webRoot, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(
      `browser gate: ${dist} has no index.html. The daemon serves the built dashboard, so run ` +
        "`bun run build` in web/ before the gate.",
    );
  }

  const home = join(gateRoot, "home");
  const fixtureRoot = join(gateRoot, "repos");
  mkdirSync(home, { recursive: true });
  mkdirSync(fixtureRoot, { recursive: true });

  const names = {
    seeded: "gate-seeded",
    attackTarget: "gate-attack-target",
    refusedTarget: "gate-refused-target",
    offlineArrival: "gate-offline-arrival",
  } as const;
  const fixtures = {
    seeded: join(fixtureRoot, names.seeded),
    attackTarget: join(fixtureRoot, names.attackTarget),
    refusedTarget: join(fixtureRoot, names.refusedTarget),
    offlineArrival: join(fixtureRoot, names.offlineArrival),
  };
  // One fixture per claim, so no spec depends on another having run (or not run) first.
  for (const key of ["seeded", "attackTarget", "refusedTarget", "offlineArrival"] as const) {
    makeFixtureRepo(fixtures[key], names[key]);
  }

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REPOYETI_HOME: home,
    REPOYETI_PORT: String(await freePort()),
    REPOYETI_NO_OPEN: "1",
    REPOYETI_NO_PING: "1",
    // No OS credential store, ever. A gate that minted a relay identity under the default
    // service name would replace the live daemon's signing key (tests/setup.ts, same reason).
    REPOYETI_KEYCHAIN_MEMORY: "1",
    REPOYETI_KEYCHAIN_SERVICE: `repoyeti-browser-gate-${process.pid}`,
    GIT_TERMINAL_PROMPT: "0",
    // Same blast door as the daemon suite: git must never climb out of the scratch tree and
    // find RepoYeti's own .git. Forward slashes, which is what git expects here.
    GIT_CEILING_DIRECTORIES: join(webRoot, ".playwright").replaceAll("\\", "/"),
  };
  // Deleted, not set to undefined: REPOYETI_DEV would add the Vite origins to the allowlist and
  // hand the foreign-origin test a pass it has not earned, and inheriting one from the ambient
  // shell (scripts/dev.ts sets it) is exactly how that would happen by accident.
  delete daemonEnv.REPOYETI_DEV;
  delete daemonEnv.REPOYETI_DEV_ORIGINS;

  const logPath = join(gateRoot, "daemon.log");
  const daemon = spawn(resolveBun(), [join(appRoot, "src", "index.ts"), "start"], {
    cwd: gateRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: daemonEnv,
  });
  // Without this an ENOENT is an unhandled 'error' event, which takes the whole runner down with
  // a node stack trace instead of reporting as a gate that could not start.
  let spawnError: Error | null = null;
  daemon.on("error", (err: Error) => {
    spawnError = err;
  });
  daemon.stdout?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk.toString()));
  daemon.stderr?.on("data", (chunk: Buffer) => appendFileSync(logPath, chunk.toString()));

  let foreign: Server | null = null;
  const teardown = async (): Promise<void> => {
    killTree(daemon);
    await Promise.race([new Promise<void>((done) => daemon.once("exit", () => done())), sleep(5_000)]);
    if (foreign) await new Promise<void>((done) => foreign?.close(() => done()));
    delete process.env.REPOYETI_GATE;
    if (process.env.REPOYETI_GATE_KEEP === "1") return;
    // Windows holds directory handles briefly after a watcher closes; one retry is enough in
    // practice and a leftover directory must never fail a run whose assertions passed.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(gateRoot, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300);
      }
    }
  };

  try {
    const daemonOrigin = await waitForDaemon(home, daemon, logPath, () => spawnError);

    // Registered from Node, which sends no Origin and no Sec-Fetch-Site: a non-browser client,
    // exactly the case the guard leaves alone.
    const registered = await fetch(`${daemonOrigin}/api/repos/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: fixtures.seeded }),
    });
    if (!registered.ok) {
      throw new Error(
        `browser gate: could not seed a repository (HTTP ${registered.status}): ${await registered.text()}`,
      );
    }

    foreign = await startForeignOrigin(await freePort(), daemonOrigin);
    const foreignAddress = foreign.address();
    if (!foreignAddress || typeof foreignAddress === "string") {
      throw new Error("browser gate: the foreign origin did not bind");
    }
    const handoff: GateHandoff = {
      daemonOrigin,
      foreignOrigin: `http://127.0.0.1:${foreignAddress.port}`,
      fixtures,
      names: { ...names },
    };
    process.env.REPOYETI_GATE = JSON.stringify(handoff);
    writeFileSync(join(gateRoot, "gate.json"), JSON.stringify(handoff, null, 2));
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
