import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoYetiConfig } from "../src/config.ts";
import { createApp } from "../src/http/app.ts";

// These guard the static-file serving in src/daemon.ts (mountWeb). The bug they prevent:
// a request for a hashed JS chunk that no longer exists on disk (an old tab after a rebuild)
// used to fall back to index.html, handing the browser text/html for a module script
// ("Failed to load module script … MIME type text/html"). Missing assets must 404; only
// navigation routes get the SPA fallback. Requires a built web/dist (bun run --cwd web build).
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const ASSETS = join(import.meta.dir, "..", "web", "dist", "assets");
const realAsset = (): string => {
  const js = readdirSync(ASSETS)
    .filter((f) => f.endsWith(".js"))
    .sort((a, b) => statSync(join(ASSETS, b)).size - statSync(join(ASSETS, a)).size)[0];
  if (!js) throw new Error("no built JS asset found — run: bun run --cwd web build:fast");
  return js;
};

// CI runs the daemon suite without building the PWA, so web/dist can be absent. These tests only
// exercise the daemon's static-serving POLICY (MIME, cache headers, SPA fallback, 404s) — not the
// real app bundle — so when no real build is present, stand up a minimal dist fixture (a hashed
// asset + index.html + sw.js + manifest) and tear it down after. A real local build is left alone.
const WEB_DIST = join(import.meta.dir, "..", "web", "dist");
let createdFixture = false;
beforeAll(() => {
  if (existsSync(join(WEB_DIST, "index.html"))) return; // a real build is present — use it
  createdFixture = true;
  mkdirSync(join(WEB_DIST, "assets"), { recursive: true });
  writeFileSync(join(WEB_DIST, "assets", "app-deadbeef.js"), "// compressible fixture\n".repeat(256));
  writeFileSync(join(WEB_DIST, "index.html"), '<!doctype html><html><body><div id="app"></div></body></html>\n');
  writeFileSync(join(WEB_DIST, "sw.js"), "self.addEventListener('install', () => {});\n");
  writeFileSync(join(WEB_DIST, "manifest.webmanifest"), '{"name":"RepoYeti"}\n');
});
afterAll(() => {
  if (createdFixture) rmSync(WEB_DIST, { recursive: true, force: true });
});

test("existing /assets/*.js is served as JS, cached immutable", async () => {
  const res = await createApp(localCfg()).request(`/assets/${realAsset()}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("javascript");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("large web assets stream compressed with cache-safe negotiation headers", async () => {
  const path = `/assets/${realAsset()}`;
  const app = createApp(localCfg());
  const identity = await app.request(path);
  const original = await identity.text();
  expect(original.length).toBeGreaterThanOrEqual(1024);
  expect(identity.headers.get("content-encoding")).toBeNull();
  expect(identity.headers.get("vary") ?? "").toContain("Accept-Encoding");

  const compressed = await app.request(path, { headers: { "accept-encoding": "gzip" } });
  expect(compressed.status).toBe(200);
  expect(compressed.headers.get("content-encoding")).toBe("gzip");
  expect(compressed.headers.get("content-length")).toBeNull();
  expect(compressed.headers.get("content-type") ?? "").toContain("javascript");
  expect(compressed.headers.get("cache-control") ?? "").toContain("immutable");
  expect(compressed.headers.get("vary") ?? "").toContain("Accept-Encoding");
  expect(compressed.body).not.toBeNull();

  const decoded = await new Response(
    compressed.body!.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  expect(decoded).toBe(original);

  // Unsupported or explicitly disabled encodings must fall back to the identity bytes.
  const brotliOnly = await app.request(path, { headers: { "accept-encoding": "br" } });
  expect(brotliOnly.headers.get("content-encoding")).toBeNull();
  expect(await brotliOnly.text()).toBe(original);
  const disabled = await app.request(path, {
    headers: { "accept-encoding": "gzip;q=0, deflate;q=0, identity;q=1" },
  });
  expect(disabled.headers.get("content-encoding")).toBeNull();
  expect(await disabled.text()).toBe(original);
});

test("compression stays scoped to static files and skips small responses", async () => {
  const app = createApp(localCfg());

  const small = await app.request("/manifest.webmanifest", {
    headers: { "accept-encoding": "gzip" },
  });
  expect(small.status).toBe(200);
  expect(Number(small.headers.get("content-length") ?? 0)).toBeLessThan(1024);
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(small.headers.get("vary") ?? "").toContain("Accept-Encoding");

  // The static middleware is mounted after API routes; even a large API document retains the API
  // stack's own transport policy rather than being transformed by the web-asset compressor.
  const apiDoc = await app.request("/api/openapi.json", {
    headers: { "accept-encoding": "gzip" },
  });
  expect(apiDoc.status).toBe(200);
  expect((await apiDoc.clone().text()).length).toBeGreaterThan(1024);
  expect(apiDoc.headers.get("content-encoding")).toBeNull();
  expect(apiDoc.headers.get("vary")).toBeNull();
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

// The traversal test above passes for the wrong reason on its own: `new URL()` collapses literal
// dot-segments before the handler ever sees them, so "/../../package.json" arrives already
// normalised. These cover the two cases that genuinely reached the filesystem check.
test("percent-encoded traversal cannot escape the web root", async () => {
  const app = createApp(localCfg());
  // %2e%2e%2f survives URL's dot-segment collapse (it is not a literal "../" at that point) and
  // only becomes ".." after decodeURIComponent, which runs afterwards.
  // The SLASH has to be encoded too. WHATWG URL decodes `%2e` when deciding what is a dot-segment,
  // so "/%2e%2e/x" is collapsed away before the handler runs and never reaches the check (that one
  // is harmless, and is asserted separately below). "%2f" is NOT decoded there, so the whole thing
  // stays one opaque segment, survives normalisation, and only becomes "../" at decodeURIComponent
  // — after the collapse has already happened. That is the case that reached the filesystem.
  for (const path of [
    "/%2e%2e%2f%2e%2e%2fpackage.json",
    "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json",
  ]) {
    const res = await app.request(path);
    // 403 SPECIFICALLY: a 404 would also mean "you didn't get the file", but it would mean the
    // confinement check never fired and the path simply missed. This must be a refusal.
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("\"name\": \"repoyeti\"");
  }
  // Literal (or %2e-spelled) dot segments are neutralised by URL parsing itself: they normalise
  // to an in-root path, so a plain miss is the correct answer.
  expect((await app.request("/%2e%2e/%2e%2e/package.json")).status).toBe(404);
});

test("a sibling directory sharing the web root's prefix is not reachable", async () => {
  // The one that a `startsWith(WEB_ROOT)` check let through: WEB_ROOT is `<repo>/web/dist` with
  // no trailing separator, so `<repo>/web/dist-next/index.html` passed it — and the build really
  // does create `dist-next` and `dist-old` (web/scripts/swap-dist.mjs), with best-effort cleanup
  // that can leave them on disk to be served, unauthenticated, over the tunnel.
  //
  // Asserting 403 rather than "not 200" is the whole value of this test: under the old check the
  // response was a 404 whenever the stale directory happened to be absent, so a laxer assertion
  // would have passed against the bug on any machine that had just cleaned its build.
  const res = await createApp(localCfg()).request("/%2e%2e%2fdist-next%2findex.html");
  expect(res.status).toBe(403);
});

test("a malformed percent-escape is a 400, not a 500", async () => {
  // decodeURIComponent throws URIError on "%ZZ". This route answers before ANY auth runs, so an
  // uncaught throw here is an unauthenticated 500.
  const res = await createApp(localCfg()).request("/%ZZ");
  expect(res.status).toBe(400);
});
