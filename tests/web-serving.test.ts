import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// These guard the static-file serving in src/daemon.ts (mountWeb). The bug they prevent:
// a request for a hashed JS chunk that no longer exists on disk (an old tab after a rebuild)
// used to fall back to index.html, handing the browser text/html for a module script
// ("Failed to load module script … MIME type text/html"). Missing assets must 404; only
// navigation routes get the SPA fallback. Requires a built web/dist (bun run --cwd web build).
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const ASSETS = join(import.meta.dir, "..", "web", "dist", "assets");
const realAsset = (): string => {
  const js = readdirSync(ASSETS).find((f) => f.endsWith(".js"));
  if (!js) throw new Error("no built JS asset found — run: bun run --cwd web build:fast");
  return js;
};

test("existing /assets/*.js is served as JS, cached immutable", async () => {
  const res = await createApp(localCfg()).request(`/assets/${realAsset()}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("javascript");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("a MISSING /assets/*.js returns 404 — never the index.html fallback", async () => {
  const res = await createApp(localCfg()).request("/assets/MonacoDiffViewer-doesNotExist.js");
  expect(res.status).toBe(404);
  // The whole point: it must NOT be served as HTML (that's the module-MIME trap).
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  expect(res.headers.get("cache-control")).toContain("no-store");
});

test("the index entry point is served no-cache so rebuilds are always picked up", async () => {
  const res = await createApp(localCfg()).request("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-cache");
});

test("the service worker (sw.js) is served no-cache so updates are picked up promptly", async () => {
  const res = await createApp(localCfg()).request("/sw.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("javascript");
  // sw.js must NOT be immutably cached, or a stale worker could pin the app to an old build.
  expect(res.headers.get("cache-control")).toBe("no-cache");
});

test("the PWA manifest keeps its application/manifest+json content type", async () => {
  const res = await createApp(localCfg()).request("/manifest.webmanifest");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/manifest+json");
});

test("an extension-less navigation route still gets the SPA fallback (index.html)", async () => {
  const res = await createApp(localCfg()).request("/repos/some-deep-spa-route");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  expect(await res.text()).toContain('<div id="app">');
});

test("a navigation route with a dot in its last segment is NOT mistaken for an asset", async () => {
  // A future deep link like /repos/my.repo must fall back to index.html, not 404.
  const res = await createApp(localCfg()).request("/repos/my.repo");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
});

test("path traversal out of the web root is forbidden", async () => {
  const res = await createApp(localCfg()).request("/../../package.json");
  // Either rejected outright or normalised to a miss — never leaks a file outside web/dist.
  expect([403, 404]).toContain(res.status);
});
