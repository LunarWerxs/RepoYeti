import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import type { RepoYetiConfig } from "../src/config.ts";
import { setServerPort, startManagedTunnel, stopManagedTunnel, tunnelActive } from "../src/runtime.ts";
import { resolveCloudflaredExecutable, startTunnel } from "../src/tunnel.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const tmp = (): string => mkScratchDir("gm-tunnel-");

test("cloudflared resolver prefers bundled dist/vendor executable", () => {
  const root = tmp();
  const dist = join(root, "dist");
  const vendor = join(dist, "vendor");
  mkdirSync(vendor, { recursive: true });
  const bundled = join(vendor, "cloudflared");
  writeFileSync(bundled, "");
  chmodSync(bundled, 0o755);

  expect(resolveCloudflaredExecutable(join(dist, "repoyeti"), "linux")).toBe(bundled);
});

test("cloudflared resolver falls back to PATH executable name", () => {
  const root = tmp();
  expect(resolveCloudflaredExecutable(join(root, "repoyeti"), "win32")).toBe("cloudflared.exe");
});

// A missing binary used to reach the terminal as nothing at all: the reason was broadcast over SSE
// and `--tunnel` simply sat at "Starting cloudflared tunnel…" forever (issue #12). The message must
// name the binary and say how to get it, or the failure is undiagnosable from a source checkout.
test("a missing cloudflared reports an actionable reason instead of hanging", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = tmp(); // an empty dir: nothing named cloudflared can resolve
  try {
    const message = await new Promise<string>((resolve, reject) => {
      const handle = startTunnel(
        7171,
        () => reject(new Error("[test] no tunnel can come up without cloudflared")),
        resolve,
      );
      setTimeout(() => {
        handle.stop();
        reject(new Error("[test] onError never fired — this is the silent hang itself"));
      }, 10_000);
    });

    expect(message).toContain("cloudflared was not found on PATH");
    expect(message).toContain("cloudflared --version");
    expect(message).toContain("developers.cloudflare.com");
    expect(message).not.toContain("ENOENT");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

// The reason existed all along; it just never left the process. startManagedTunnel only broadcast it
// over SSE, so `--tunnel` with no dashboard open showed nothing. Assert the CLI's seam gets it.
test("startManagedTunnel hands a launch failure to its caller, not only to SSE", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = tmp();
  const cfg = { roots: [], port: 7171, maxDepth: 6, maxRepos: 200 } as unknown as RepoYetiConfig;
  try {
    const message = await new Promise<string>((resolve, reject) => {
      setServerPort(7171);
      startManagedTunnel(
        cfg,
        () => reject(new Error("[test] no tunnel can come up without cloudflared")),
        resolve,
      );
      setTimeout(() => reject(new Error("[test] onFailed never fired — the silent hang")), 10_000);
    });

    expect(message).toContain("cloudflared was not found on PATH");
  } finally {
    stopManagedTunnel();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

// Whichever way the launch fails (a synchronous throw at spawn, or an async 'error'), no tunnel may
// be left behind and a second start must be attempted. The synchronous path used to store an inert
// handle over the null onFailed had just written, so tunnelActive() read true forever.
test("a launch that fails synchronously leaves no tunnel behind, and a second start is attempted", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = tmp();
  const cfg = { roots: [], port: 7171, maxDepth: 6, maxRepos: 200 } as unknown as RepoYetiConfig;
  try {
    setServerPort(7171);
    let failures = 0;
    startManagedTunnel(cfg, undefined, () => failures++);
    await Bun.sleep(50);
    expect(failures).toBe(1);
    expect(tunnelActive()).toBe(false);
    // Not refused by the "already running" early return: it tries again, and fails again, honestly.
    startManagedTunnel(cfg, undefined, () => failures++);
    await Bun.sleep(50);
    expect(failures).toBe(2);
    expect(tunnelActive()).toBe(false);
  } finally {
    stopManagedTunnel();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

// A pipe can split cloudflared's URL line across two reads; matching each chunk alone missed it and
// the tunnel sat at "starting" forever with cloudflared alive and nothing reported.
test("the URL scanner finds a quick-tunnel URL split across two chunks", async () => {
  const { tailScanner } = await import("../src/tunnel.ts");
  const detect = (chunk: string) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk)?.[0] ?? null;
  const feed = tailScanner(detect);
  expect(feed(Buffer.from("INF |  https://quiet-river-12.trycloudf"))).toBeNull();
  expect(feed(Buffer.from("lare.com  |\n"))).toBe("https://quiet-river-12.trycloudflare.com");
});
