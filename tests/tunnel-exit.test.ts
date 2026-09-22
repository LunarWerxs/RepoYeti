import { test, expect } from "bun:test";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoYetiConfig } from "../src/config.ts";
import {
  getTunnelUrl,
  setServerPort,
  startManagedTunnel,
  stopManagedTunnel,
  tunnelActive,
} from "../src/runtime.ts";
import { startNamedTunnel } from "../src/tunnel.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout();

/**
 * Run `fn` with a fake `cloudflared` on PATH.
 *
 * The tunnel module spawns the binary by bare name, so the only way to exercise the exit path
 * without a real cloudflared is to supply one. The one runtime guaranteed to exist wherever this
 * suite runs is the bun executing it: copy that as the platform's cloudflared name, and let bun's
 * first argument — cloudflared's `tunnel` subcommand — load an extensionless `tunnel` script next
 * to it (bun resolves the entrypoint from the CWD, hence the chdir). That covers win32 as well,
 * where a shebang script is not executable and the spread name is `cloudflared.exe`.
 */
function withFakeCloudflared<T>(script: string, fn: () => Promise<T> | T): Promise<T> {
  const dir = mkScratchDir("gm-tunnel-exit-");
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  copyFileSync(process.execPath, join(dir, exe));
  chmodSync(join(dir, exe), 0o755);
  writeFileSync(join(dir, "tunnel"), script);

  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  process.env.PATH = dir;
  process.chdir(dir);
  return (async () => {
    try {
      return await fn();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      process.chdir(previousCwd);
    }
  })();
}

const READY_THEN_EXIT = [
  'console.log("INF Registered tunnel connection connIndex=0");',
  "setTimeout(() => process.exit(0), 300);",
].join("\n");

const READY_THEN_LIVE = [
  'console.log("INF Registered tunnel connection connIndex=0");',
  "setInterval(() => {}, 1000);",
].join("\n");

/** Wait for `check()` to turn true, or throw — a hang must be a test failure, not a timeout. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`[test] ${what}`);
}

// cloudflared dying AFTER the tunnel was ready used to be swallowed: the `exit` handler only spoke
// up while `!found`, so a crash or a killed connector left onError uncalled and every piece of
// runtime state ("the tunnel is live, here is the URL") still advertised a host that was gone.
test("cloudflared exiting after the tunnel was ready reports the failure", async () => {
  const result = await withFakeCloudflared(
    READY_THEN_EXIT,
    () =>
      new Promise<{ url: string | null; error: string }>((resolve, reject) => {
        let url: string | null = null;
        const timer = setTimeout(
          () =>
            reject(
              new Error("[test] onError never fired after cloudflared exited post-readiness"),
            ),
          10_000,
        );
        startNamedTunnel(
          "tok",
          "app.repoyeti.com",
          (ready) => {
            url = ready;
          },
          (error) => {
            clearTimeout(timer);
            resolve({ url, error });
          },
        );
      }),
  );

  expect(result.url).toBe("https://app.repoyeti.com");
  expect(result.error).toContain("after the tunnel was ready");
});

// stop() kills cloudflared itself, so the new exit path must not mistake our own teardown for a
// tunnel failure — stopManagedTunnel already broadcasts the clean shutdown.
test("stopping the tunnel ourselves is not reported as a failure", async () => {
  const errors: string[] = [];
  await withFakeCloudflared(
    READY_THEN_LIVE,
    () =>
      new Promise<void>((resolve) => {
        const handle = startNamedTunnel(
          "tok",
          "app.repoyeti.com",
          () => {},
          (error) => errors.push(error),
        );
        setTimeout(() => {
          handle.stop();
          // Long enough for the child's exit event to arrive and (wrongly) call onError.
          setTimeout(resolve, 500);
        }, 300);
      }),
  );

  expect(errors).toEqual([]);
});

// The user-visible consequence: /api/status reads getTunnelUrl(), so a tunnel that dies after
// readiness must clear that module state (not merely broadcast tunnelUrl: null) or the panel and
// every share link built from it keep calling a dead host live.
test("a tunnel that dies after readiness clears the URL and deactivates it", async () => {
  const cfg = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    tunnel: { hostname: "app.repoyeti.com", token: "tok" },
  } as unknown as RepoYetiConfig;
  setServerPort(7171);
  let failure: string | undefined;
  try {
    await withFakeCloudflared(READY_THEN_EXIT, async () => {
      startManagedTunnel(cfg, undefined, (message) => {
        failure = message;
      });
      await waitFor(() => getTunnelUrl() !== null, "the tunnel never came up");
      expect(tunnelActive()).toBe(true);

      await waitFor(() => failure !== undefined, "the post-readiness exit was never reported");
      expect(failure).toContain("after the tunnel was ready");
      expect(getTunnelUrl()).toBeNull();
      expect(tunnelActive()).toBe(false);
    });
  } finally {
    stopManagedTunnel();
  }
});
