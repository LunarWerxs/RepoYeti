#!/usr/bin/env bun
/**
 * Prove a release bundle works outside the source checkout before it is archived.
 *
 * The daemon embeds the built PWA in the executable. This smoke test boots the staged executable
 * with isolated state and a cwd outside the repository, then checks health, the HTML shell, and
 * one real content-addressed frontend asset without any sidecar files.
 *
 * Usage: bun run scripts/smoke-release.ts <bundle-root>
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const bundleRoot = resolve(process.argv[2] ?? "dist");
const binary = join(bundleRoot, process.platform === "win32" ? "repoyeti.exe" : "repoyeti");

if (!existsSync(binary)) throw new Error(`release smoke: missing executable at ${binary}`);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release smoke: could not reserve a port");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

/**
 * The port the daemon under test ACTUALLY bound, read from the runtime pointer it writes into its
 * own isolated state dir, and proven to be this child by its pid.
 *
 * The port chosen above is a hint, not a reservation: freePort() closes its probe socket before the
 * child starts, so another process can take the port in between (1.0 audit, delivery P3). The
 * daemon then walks upward to the next free port while the smoke test polls the squatter, which is
 * a flaky red at best and, if the squatter happens to answer 200, a green run that never spoke to
 * the release. The pointer names the real port and the pid that bound it, so neither can happen.
 */
async function boundOrigin(stateDir: string, child: Bun.Subprocess): Promise<string> {
  const pointer = join(stateDir, "runtime.json");
  const deadline = Date.now() + 30_000;
  let lastProblem = "the daemon never wrote runtime.json";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`release smoke: ${basename(binary)} exited early with code ${child.exitCode}`);
    }
    try {
      const info = JSON.parse(readFileSync(pointer, "utf8")) as { port?: number; pid?: number };
      if (info.pid === child.pid && typeof info.port === "number") return `http://127.0.0.1:${info.port}`;
      lastProblem = `runtime.json names pid ${info.pid}, not the child ${child.pid}`;
    } catch (error) {
      if (existsSync(pointer)) lastProblem = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(200);
  }
  throw new Error(`release smoke: ${lastProblem}`);
}

async function waitFor(url: string, child: Bun.Subprocess): Promise<Response> {
  const deadline = Date.now() + 30_000;
  let lastProblem = "daemon did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`release smoke: ${basename(binary)} exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
      lastProblem = `HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(200);
  }
  throw new Error(`release smoke: ${lastProblem}`);
}

const scratch = mkdtempSync(join(tmpdir(), "repoyeti-release-smoke-"));
const stateDir = join(scratch, "state");
const cwd = join(scratch, "cwd");
mkdirSync(stateDir);
mkdirSync(cwd);

// freePort() and Bun.spawn() can both throw before the child exists (listen/close errors, ENOENT,
// OS spawn failure). Keeping them inside the try means the finally below still reclaims `scratch`
// on those failures — previously they ran ahead of it, so every pre-spawn error orphaned a
// repoyeti-release-smoke-* directory (plus its state/ and cwd/) under the OS tmpdir forever.
let child: Bun.Subprocess | undefined;
try {
  // A preferred port only: the daemon may not get it, and boundOrigin() below reads the real one.
  const port = await freePort();
  // No arguments exercises the exact double-click entrypoint. The test-only switch suppresses the
  // real browser handoff while leaving packaged default-command selection intact.
  child = Bun.spawn([binary], {
    cwd,
    env: {
      ...process.env,
      REPOYETI_HOME: stateDir,
      REPOYETI_NO_OPEN: "1",
      REPOYETI_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const origin = await boundOrigin(stateDir, child);
  const health = await waitFor(`${origin}/api/health`, child);
  const healthBody = (await health.json()) as { ok?: boolean; service?: string };
  if (healthBody.ok !== true) throw new Error("release smoke: health response was not ok");
  if (healthBody.service !== "repoyeti") {
    throw new Error(`release smoke: ${origin} answered as ${String(healthBody.service)}, not repoyeti`);
  }

  const home = await waitFor(`${origin}/`, child);
  const html = await home.text();
  if (!/<(?:html|!doctype html)/i.test(html)) {
    throw new Error("release smoke: root did not return the dashboard HTML");
  }

  // EVERY referenced asset, not just the first one. This used to be a single non-global `.match()`,
  // so it checked whichever /assets/ URL happened to come first in the emitted HTML — an ordering
  // accident of Vite plugins and the PWA head injection, not a guarantee. The entry bundle could
  // 404 while a stylesheet or a modulepreload passed in its place, which is a green release that
  // serves a blank dashboard. web/package.json's "//build" note records exactly that shape
  // happening for real once (the Monaco chunk-404).
  const assetPaths = [...new Set([...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/gi)].map((m) => m[1]!))];
  if (assetPaths.length === 0) {
    throw new Error("release smoke: dashboard HTML did not reference a built asset");
  }

  // The entry module specifically: everything else can be present and correct while the one script
  // that actually boots the app is missing, and the page still returns 200 with a valid shell.
  // Matched over the whole tag rather than a fixed attribute order, because that order is Vite's to
  // change.
  const hasEntryModule = [...html.matchAll(/<script\b[^>]*>/gi)].some(
    (m) => /type=["']module["']/i.test(m[0]) && /src=["']\/assets\//i.test(m[0]),
  );
  if (!hasEntryModule) {
    throw new Error("release smoke: dashboard HTML has no <script type=module src=/assets/…> entry");
  }

  for (const assetPath of assetPaths) {
    const asset = await waitFor(`${origin}${assetPath}`, child);
    const contentType = asset.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      throw new Error(`release smoke: ${assetPath} incorrectly returned HTML`);
    }
    if ((await asset.arrayBuffer()).byteLength === 0) {
      throw new Error(`release smoke: ${assetPath} was empty`);
    }
  }

  console.log(
    `✓ release bundle served health, dashboard, and all ${assetPaths.length} referenced asset(s)`,
  );
} finally {
  // `child` is undefined when freePort() or Bun.spawn() threw; the scratch dir still needs clearing.
  if (child) {
    child.kill();
    await Promise.race([child.exited, Bun.sleep(5_000)]);
  }
  rmSync(scratch, { recursive: true, force: true });
}
