/**
 * RepoYeti-specific WIRING of the shared loopback guard (src/http/app.ts). The pure decision logic
 * lives in the kit and is covered by tests/server-lib/loopback-guard.test.ts (synced); this file
 * proves RepoYeti's local wiring rules: (1) the guard is mounted on /api/*, (2) a genuine tunnel
 * request (cf-connecting-ip present → isRemoteRequest) is deliberately NOT loopback-gated — it's
 * auth-gated instead, so the guard skips it — and (3) the guard runs in EXACT-ORIGIN mode against
 * the daemon's own bound origin, so a page on another loopback port (same-site, not same-origin)
 * cannot drive a mutating route.
 *
 * Local mode (no OIDC) → authMiddleware is a pass-through, so a non-403 here means the request
 * reached the route (the guard let it through); a 403 means the guard blocked it. We hit an unknown
 * approval id, whose handler 404s once the request gets past the guard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, trustedLocalOrigins } from "../src/http/app.ts";
import { setServerPort } from "../src/runtime.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const APPROVE = "/api/approvals/nope/approve";

/** A simple (no-preflight) POST the way a browser page on `origin` would send it to the daemon. */
const fromLocalPage = (origin: string) => ({
  method: "POST",
  headers: {
    host: "127.0.0.1:7171",
    origin,
    // Any loopback page is same-SITE with the daemon (a site ignores the port), so this is what
    // the browser stamps on the attack too — the default guard mode had nothing left to refuse.
    "sec-fetch-site": "same-site",
    "content-type": "text/plain",
  },
  body: "{}",
});

describe("loopback-guard: exact-origin mode (audit item 4)", () => {
  const ORIG_DEV = process.env.REPOYETI_DEV;
  const ORIG_DEV_ORIGINS = process.env.REPOYETI_DEV_ORIGINS;
  afterEach(() => {
    setServerPort(0);
    if (ORIG_DEV === undefined) delete process.env.REPOYETI_DEV;
    else process.env.REPOYETI_DEV = ORIG_DEV;
    if (ORIG_DEV_ORIGINS === undefined) delete process.env.REPOYETI_DEV_ORIGINS;
    else process.env.REPOYETI_DEV_ORIGINS = ORIG_DEV_ORIGINS;
  });

  test("THE ATTACK: a simple POST from a page on ANOTHER loopback port is REJECTED with 403", async () => {
    // Reproduced during the 1.0 audit against the guard's default mode: `Origin:
    // http://127.0.0.1:31337` → allowed. A preview server, a docs build or another local daemon's
    // page is exactly this shape, and its request would have reached the unauthenticated route.
    const res = await createApp(localCfg()).request(APPROVE, fromLocalPage("http://127.0.0.1:31337"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("origin not in allowlist");
  });

  test("the daemon's own origin passes in every loopback spelling a browser can use", async () => {
    const app = createApp(localCfg());
    for (const origin of ["http://127.0.0.1:7171", "http://localhost:7171", "http://[::1]:7171"]) {
      const res = await app.request(APPROVE, fromLocalPage(origin));
      expect(res.status).toBe(404); // past the guard, into the route
    }
  });

  test("a 'null' Origin (sandboxed frame / file:// page) is refused", async () => {
    const res = await createApp(localCfg()).request(APPROVE, fromLocalPage("null"));
    expect(res.status).toBe(403);
  });

  test("the allowlist follows the port the daemon ACTUALLY bound, not the configured preference", async () => {
    // findFreePort may hop off cfg.port; the PWA is then served from the bound port and its
    // requests carry THAT origin. Read lazily per request, so setting it after createApp() counts.
    const app = createApp(localCfg());
    setServerPort(7272);
    expect(trustedLocalOrigins(localCfg())).toContain("http://127.0.0.1:7272");
    expect((await app.request(APPROVE, fromLocalPage("http://127.0.0.1:7272"))).status).toBe(404);
    // …and the stale configured port is now a foreign port like any other.
    expect((await app.request(APPROVE, fromLocalPage("http://127.0.0.1:7171"))).status).toBe(403);
  });

  test("the Vite dev origin is admitted ONLY under REPOYETI_DEV=1 (what scripts/dev.ts sets)", async () => {
    delete process.env.REPOYETI_DEV;
    const app = createApp(localCfg());
    expect((await app.request(APPROVE, fromLocalPage("http://localhost:4319"))).status).toBe(403);
    process.env.REPOYETI_DEV = "1";
    expect((await app.request(APPROVE, fromLocalPage("http://localhost:4319"))).status).toBe(404);
    // An explicit REPOYETI_DEV_ORIGINS replaces the built-in Vite default rather than adding to it.
    process.env.REPOYETI_DEV_ORIGINS = "http://localhost:5555/";
    expect((await app.request(APPROVE, fromLocalPage("http://localhost:5555"))).status).toBe(404);
    expect((await app.request(APPROVE, fromLocalPage("http://localhost:4319"))).status).toBe(403);
  });

  test("a non-browser client (no Origin) is unaffected by exact-origin mode", async () => {
    const res = await createApp(localCfg()).request(APPROVE, {
      method: "POST",
      headers: { host: "127.0.0.1:7171" },
    });
    expect(res.status).toBe(404);
  });
});

describe("loopback-guard: wired on /api/* (app.ts)", () => {
  test("THE ATTACK: a cross-site POST on the local path is REJECTED with 403", async () => {
    const app = createApp(localCfg());
    const res = await app.request(APPROVE, {
      method: "POST",
      headers: { host: "127.0.0.1:7171", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  test("a non-loopback Host on the local path is REJECTED with 403 (rebinding backstop)", async () => {
    const app = createApp(localCfg());
    const res = await app.request(APPROVE, {
      method: "POST",
      headers: { host: "evil.com", origin: "http://evil.com", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(403);
  });

  test("the same-origin PWA request passes the guard (reaches the 404 handler)", async () => {
    const app = createApp(localCfg());
    const res = await app.request(APPROVE, {
      method: "POST",
      headers: { host: "127.0.0.1:7171", origin: "http://127.0.0.1:7171", "sec-fetch-site": "same-origin" },
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  test("a header-less request (curl / test harness / non-browser tool) passes the guard", async () => {
    // No Host, no Origin, no Sec-Fetch-Site — a non-browser client. This is exactly how the rest of
    // the route test suite calls /api/*, so the guard must not 403 them.
    const app = createApp(localCfg());
    const res = await app.request(APPROVE, { method: "POST" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  test("a genuine tunnel request (cf-connecting-ip) is NOT loopback-gated — the guard skips it", async () => {
    // Identical cross-site headers that 403 on the local path above, but with cf-connecting-ip → a
    // real tunnel request. It must NOT be loopback-gated (it's auth-gated instead); without the
    // isRemoteRequest skip this would 403 on both the Origin and Host checks.
    const app = createApp(localCfg());
    const res = await app.request(APPROVE, {
      method: "POST",
      headers: {
        host: "app.repoyeti.com",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "cf-connecting-ip": "203.0.113.7",
      },
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });
});
