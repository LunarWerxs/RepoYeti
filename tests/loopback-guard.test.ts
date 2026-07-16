/**
 * Cross-site CSRF defense for the loopback API (src/http/loopback-guard.ts) + its wiring in
 * src/http/app.ts. The pure `evaluateRequest` tests mirror ccmanagerui's reference suite; the
 * integration tests prove the guard is actually mounted on /api/* AND that a genuine tunnel
 * request (cf-connecting-ip present → isRemoteRequest) is deliberately NOT loopback-gated (it is
 * auth-gated instead — see app.ts).
 */
import { describe, expect, test } from "bun:test";
import { evaluateRequest, isLoopbackOrigin } from "../src/http/loopback-guard.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const LOOPBACK_HOST = "127.0.0.1:7171";

describe("loopback-guard: cross-site CSRF defense (evaluateRequest)", () => {
  test("PWA same-origin request is allowed", () => {
    expect(
      evaluateRequest({
        secFetchSite: "same-origin",
        origin: "http://127.0.0.1:7171",
        host: LOOPBACK_HOST,
      }).ok,
    ).toBe(true);
  });

  test("dev PWA (:5173 -> daemon, same-site) is allowed", () => {
    expect(
      evaluateRequest({
        secFetchSite: "same-site",
        origin: "http://127.0.0.1:5173",
        host: LOOPBACK_HOST,
      }).ok,
    ).toBe(true);
    // localhost hostname variant too
    expect(
      evaluateRequest({
        secFetchSite: "same-site",
        origin: "http://localhost:5173",
        host: "localhost:7171",
      }).ok,
    ).toBe(true);
  });

  test("non-browser client (curl / tray / MCP: no browser headers) is allowed", () => {
    expect(evaluateRequest({ host: LOOPBACK_HOST }).ok).toBe(true);
  });

  test("THE ATTACK: a malicious page cross-site request is REJECTED (Sec-Fetch-Site)", () => {
    const v = evaluateRequest({
      secFetchSite: "cross-site",
      origin: "https://evil.example",
      host: LOOPBACK_HOST,
    });
    expect(v.ok).toBe(false);
  });

  test("simple no-preflight cross-origin POST (no Sec-Fetch-Site) still caught by Origin", () => {
    // An older browser or a "simple" request may omit Sec-Fetch-Site, but a cross-origin POST
    // still carries Origin — the CORS-bypass the naive fix misses.
    const v = evaluateRequest({ origin: "https://evil.example", host: LOOPBACK_HOST });
    expect(v.ok).toBe(false);
  });

  test("DNS rebinding (evil.com A-record -> 127.0.0.1) caught by Host + Origin", () => {
    // The page is served from evil.com which resolves to 127.0.0.1; from the browser it looks
    // same-origin (Sec-Fetch-Site: same-origin) but Host + Origin are evil.com.
    const v = evaluateRequest({
      secFetchSite: "same-origin",
      origin: "http://evil.com",
      host: "evil.com",
    });
    expect(v.ok).toBe(false);
  });

  test("a 'null' opaque origin (sandboxed iframe / file://) is rejected", () => {
    expect(evaluateRequest({ origin: "null", host: LOOPBACK_HOST }).ok).toBe(false);
  });

  test("non-loopback Host alone (rebinding backstop) is rejected", () => {
    expect(evaluateRequest({ host: "attacker.test" }).ok).toBe(false);
  });

  test("no headers at all (a raw non-browser client / HTTP tool) is allowed", () => {
    // A real browser always sends Host, so no-Host-at-all is a non-browser client, not a CSRF
    // vector — allowed, exactly like an absent Origin (rule 2). Only a PRESENT non-loopback Host
    // (the rebinding case above) is rejected.
    expect(evaluateRequest({}).ok).toBe(true);
  });

  test("isLoopbackOrigin helper", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:7171")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:9999")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:7171")).toBe(true);
    expect(isLoopbackOrigin("https://evil.example")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

// ── wiring: the guard is mounted on /api/* and skips the tunnel path ──────────────────
// Local mode (no OIDC) → authMiddleware is a pass-through, so a non-403 here means the request
// reached the route (the guard let it through); a 403 means the guard blocked it. We hit an
// unknown approval id, whose handler 404s once the request gets past the guard.
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
