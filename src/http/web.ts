/**
 * Static PWA serving (the `/*` catch-all) + its traversal protection and cache policy.
 * Moved verbatim out of daemon.ts; mountWeb() must be registered LAST so it only catches
 * non-API routes.
 */
import { join, normalize, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { Hono } from "hono";

/** Path to the built PWA (`web/dist`). Works in dev (relative to this source) and
 * when compiled (a `web/dist` shipped next to the binary). */
function resolveWebRoot(): string {
  const candidates = [
    normalize(join(import.meta.dir, "..", "..", "web", "dist")), // dev: src/http/../../web/dist
    normalize(join(dirname(process.execPath), "web", "dist")), // compiled: next to the binary
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return candidates[0]!;
}
const WEB_ROOT = resolveWebRoot();

const EXTRA_MIME: Record<string, string> = {
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
// Vite emits content-addressed (hash-in-name) files under /assets — cache them forever.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// Extensions we serve as static files. A miss on one of these 404s instead of falling back
// to index.html (see mountWeb). Matching a known extension — rather than "any dot in the
// last segment" — keeps a future deep-link route like /repos/my.repo from wrongly 404ing.
const STATIC_EXT =
  /\.(?:js|mjs|css|map|json|webmanifest|wasm|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|txt|xml)$/i;

/**
 * Serve the SPA + assets with traversal protection.
 *
 * The SPA fallback to index.html applies ONLY to navigation requests — extension-less paths
 * ("/", "/settings", …). A miss on an actual asset request (under /assets/ or with a known
 * static extension, e.g. "/assets/MonacoViewer-abc.js") returns a clean 404 — NEVER
 * index.html. Serving index.html for a missing .js chunk hands the browser text/html for a
 * module script ("Failed to load module script … MIME type text/html"), which is exactly what
 * bit us every time a rebuild renamed a hashed chunk while an old tab was still open. The
 * client recovers from that 404 via a vite:preloadError reload (see web/src/main.ts).
 *
 * Caching: hashed /assets/* are immutable; everything else (index.html, sw.js, registerSW.js,
 * the manifest, icon) is no-cache so a rebuild — most importantly the entry point and the
 * service worker — is always revalidated and picked up.
 */
export function mountWeb(app: Hono): void {
  app.get("/*", async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    const filePath = normalize(join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT)) return c.text("forbidden", 403);

    const lastSeg = pathname.slice(pathname.lastIndexOf("/") + 1);
    const isAssetRequest = pathname.startsWith("/assets/") || STATIC_EXT.test(lastSeg);

    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const headers: Record<string, string> = {
        "cache-control": pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : "no-cache",
      };
      if (EXTRA_MIME[ext]) headers["content-type"] = EXTRA_MIME[ext];
      return new Response(file, { headers });
    }

    // Missing asset → real 404, never the HTML fallback (avoids the module-MIME trap).
    if (isAssetRequest) return c.text("not found", 404, { "cache-control": "no-store" });

    // Navigation route → SPA fallback to index.html, always revalidated.
    const index = Bun.file(join(WEB_ROOT, "index.html"));
    if (!(await index.exists())) {
      return c.text("web app not built — run: bun run --cwd web build:fast", 503);
    }
    return new Response(index, { headers: { "cache-control": "no-cache" } });
  });
}
