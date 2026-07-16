/**
 * RepoYeti-specific WIRING of the shared loopback guard (src/http/app.ts). The pure decision logic
 * lives in the kit and is covered by tests/server-lib/loopback-guard.test.ts (synced); this file
 * proves RepoYeti's two local wiring rules: (1) the guard is mounted on /api/*, and (2) a genuine
 * tunnel request (cf-connecting-ip present → isRemoteRequest) is deliberately NOT loopback-gated —
 * it's auth-gated instead, so the guard skips it.
 *
 * Local mode (no OIDC) → authMiddleware is a pass-through, so a non-403 here means the request
 * reached the route (the guard let it through); a 403 means the guard blocked it. We hit an unknown
 * approval id, whose handler 404s once the request gets past the guard.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const APPROVE = "/api/approvals/nope/approve";

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
