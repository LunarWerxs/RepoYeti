/**
 * One command to regenerate every marketing screenshot:
 *
 *   bun run scripts/refresh-screenshots.ts
 *
 * The old shots went stale because refreshing them was a manual afternoon: fabricate believable
 * repos, run a daemon against them, drive the UI, crop, copy into two places. Each of those steps
 * is here, so "the screenshots are ancient" is a one-command fix rather than a project.
 *
 * Everything runs ISOLATED from your real install:
 *   - its own REPOYETI_HOME, so your config, tokens and repo index are untouched
 *   - its own port, so a RepoYeti you already have running keeps its port and instance lock
 *   - a fixture workspace of invented repos, so no real project name reaches a public image
 *
 * Both child processes are killed on the way out, including on Ctrl-C or a failure partway.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
// The expanded card prints its repo's path, so the fixture directory is ON CAMERA. A name like
// "repoyeti-shots-demo" advertises the rig; a plain projects folder just looks like a machine.
const DEMO_DIR = process.env.SHOT_DEMO_DIR ?? "D:\\Projects";
const HOME_DIR = join(DEMO_DIR, ".repoyeti-home");
const DAEMON_PORT = Number(process.env.SHOT_DAEMON_PORT ?? 7180);
const WEB_PORT = Number(process.env.SHOT_WEB_PORT ?? 4320);

const children: ChildProcess[] = [];

function shutdown(): void {
  for (const c of children) {
    if (c.pid && !c.killed) {
      try {
        // The daemon and Vite both spawn grandchildren; kill the whole tree or the port stays held.
        execFileSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        c.kill("SIGKILL");
      }
    }
  }
  children.length = 0;
}
process.on("exit", shutdown);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown();
    process.exit(1);
  });
}

async function waitFor(url: string, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 401 || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms (${url})`);
}

// ── 1. fixture repos ──────────────────────────────────────────────────────────────────
console.log("[shots] building demo workspace…");
execFileSync(process.execPath, [join(REPO, "scripts", "make-demo-workspace.ts"), DEMO_DIR], {
  stdio: "inherit",
});

// ── 2. an isolated home pointed at them ───────────────────────────────────────────────
mkdirSync(HOME_DIR, { recursive: true });
writeFileSync(
  join(HOME_DIR, "config.json"),
  `${JSON.stringify({ roots: [DEMO_DIR], repos: [], port: DAEMON_PORT }, null, 2)}\n`,
);
if (existsSync(join(HOME_DIR, "runtime.json"))) rmSync(join(HOME_DIR, "runtime.json"));

// An isolated REPOYETI_HOME is NOT enough to keep your identity out of the images: the daemon
// shells out to `gh auth status` to label repos, so the real signed-in account renders into the
// header of every shot. Point gh at an empty config dir and strip the token env vars, so it
// truthfully reports nobody and the screenshots show a signed-out app.
const GH_EMPTY = join(HOME_DIR, "gh-empty");
mkdirSync(GH_EMPTY, { recursive: true });

const env = {
  ...process.env,
  REPOYETI_HOME: HOME_DIR,
  REPOYETI_PORT: String(DAEMON_PORT),
  REPOYETI_NO_OPEN: "1",
  REPOYETI_NO_KEYCHAIN: "1",
  GH_CONFIG_DIR: GH_EMPTY,
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  REPOYETI_GH_TOKEN: "",
};

// ── 3. daemon ─────────────────────────────────────────────────────────────────────────
console.log(`[shots] starting demo daemon on :${DAEMON_PORT}…`);
children.push(
  spawn(process.execPath, ["run", join(REPO, "src", "index.ts"), "start"], {
    cwd: REPO,
    env,
    stdio: "ignore",
  }),
);
await waitFor(`http://127.0.0.1:${DAEMON_PORT}/api/health`, "demo daemon");

// ── 4. dev server, proxying to it via REPOYETI_HOME/runtime.json ───────────────────────
// `--host 127.0.0.1` is not optional: Vite's default "localhost" bind resolves to ::1 only on
// Windows, so a readiness probe (and Playwright) against 127.0.0.1 hangs against a server that is
// in fact up and serving.
console.log(`[shots] starting dev server on :${WEB_PORT}…`);
children.push(
  spawn(
    process.execPath,
    ["run", "--cwd", "web", "dev", "--port", String(WEB_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: REPO, env, stdio: "ignore" },
  ),
);
await waitFor(`http://127.0.0.1:${WEB_PORT}/`, "dev server");

// ── 5. shoot ──────────────────────────────────────────────────────────────────────────
console.log("[shots] capturing stills…");
execFileSync(
  "node",
  [join(REPO, "web", "scripts", "shoot-screenshots.mjs"), "--url", `http://127.0.0.1:${WEB_PORT}`],
  { cwd: join(REPO, "web"), stdio: "inherit" },
);

// ── 6. the hero loop ──────────────────────────────────────────────────────────────────
// Skippable, because it needs ffmpeg on PATH and takes appreciably longer than the stills.
if (!process.argv.includes("--no-gif")) {
  console.log("[shots] recording the hero GIF…");
  execFileSync(
    "node",
    [
      join(REPO, "web", "scripts", "shoot-demo-gif.mjs"),
      "--url", `http://127.0.0.1:${WEB_PORT}`,
      "--out", join(REPO, "site", "demo.gif"),
    ],
    { cwd: join(REPO, "web"), stdio: "inherit" },
  );
}

// ── 7. banner ─────────────────────────────────────────────────────────────────────────
// Composed from the still captured above, so it can never drift from the real UI.
console.log("[shots] composing the README banner…");
execFileSync("node", [join(REPO, "web", "scripts", "shoot-banner.mjs")], {
  cwd: join(REPO, "web"),
  stdio: "inherit",
});

shutdown();
console.log("[shots] done — daemon and dev server stopped.");
