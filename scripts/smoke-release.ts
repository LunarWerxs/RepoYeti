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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
// No arguments exercises the exact double-click entrypoint. The test-only switch suppresses the
// real browser handoff while leaving packaged default-command selection intact.
const child = Bun.spawn([binary], {
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

try {
  const health = await waitFor(`${origin}/api/health`, child);
  const healthBody = (await health.json()) as { ok?: boolean };
  if (healthBody.ok !== true) throw new Error("release smoke: health response was not ok");

  const home = await waitFor(`${origin}/`, child);
  const html = await home.text();
  if (!/<(?:html|!doctype html)/i.test(html)) {
    throw new Error("release smoke: root did not return the dashboard HTML");
  }

  const assetPath = html.match(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/i)?.[1];
  if (!assetPath) throw new Error("release smoke: dashboard HTML did not reference a built asset");
  const asset = await waitFor(`${origin}${assetPath}`, child);
  const contentType = asset.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error(`release smoke: ${assetPath} incorrectly returned HTML`);
  }
  if ((await asset.arrayBuffer()).byteLength === 0) {
    throw new Error(`release smoke: ${assetPath} was empty`);
  }

  console.log(`✓ release bundle served health, dashboard, and ${assetPath}`);
} finally {
  child.kill();
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  rmSync(scratch, { recursive: true, force: true });
}
