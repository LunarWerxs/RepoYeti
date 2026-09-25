/**
 * The port proxy (src/http/routes/port-proxy.ts): /proxy/<port>/ forwards to a local server, and only
 * for the owner.
 *
 * What is pinned, and why each would hurt if it broke:
 *  - an anonymous tunnel caller is refused (a page load goes to the sign-in, anything else is a bare
 *    401), so the tunnel URL alone never opens a local port;
 *  - a share-link guest is refused too, where /api/* would admit it;
 *  - a cross-origin caller is refused, since the upstream is shown a loopback Origin;
 *  - the proxy is off until the owner turns it on;
 *  - it never forwards to the daemon's own port (a loopback hop there would skip the caller's auth);
 *  - a forwarded request loses the daemon's cookies and the upstream cannot set them, so no owner
 *    credential leaks to, or is overwritten by, the process on the other port;
 *  - the prefix is stripped on the way in and put back on redirects on the way out.
 * A real Bun server stands in for the dev server, so the forwarding is exercised end to end.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { sign } from "../src/auth.ts";
import { createShare, initDb } from "../src/db.ts";
import { hashToken, mintToken, GUEST_COOKIE } from "../src/share/index.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const OWNER_SUB = "owner-sub-proxy";

const cfgWith = (extra?: Partial<RepoYetiConfig>): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "remote",
  oauth: {
    issuer: "https://accounts.connectionsapi.com",
    clientId: "test-client",
    redirectUri: "https://example.com/cb",
    ownerSub: OWNER_SUB,
  },
  portProxy: true,
  ...extra,
});

/** A request over the tunnel carries a header true-localhost never has. */
const REMOTE = { "cf-connecting-ip": "203.0.113.7" };

function ownerCookie(): string {
  return `gm_session=${sign(JSON.stringify({ sub: OWNER_SUB, email: "", exp: Date.now() + 60_000 }))}`;
}

let upstream: ReturnType<typeof Bun.serve>;
let seen: { path: string; cookie: string | null; origin: string | null } | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen = { path: `${url.pathname}${url.search}`, cookie: req.headers.get("cookie"), origin: req.headers.get("origin") };
      const headers = new Headers({ location: "/login" });
      headers.append("set-cookie", "gm_session=forged; Path=/");
      headers.append("set-cookie", "app_session=ok; Path=/");
      return new Response("from upstream", { status: 302, headers });
    },
  });
});

afterAll(() => {
  upstream.stop(true);
});

test("an anonymous tunnel caller is refused: 401 for an API call, the sign-in for a page load", async () => {
  const app = createApp(cfgWith());
  const api = await app.request(`/proxy/${upstream.port}/`, { headers: REMOTE });
  expect(api.status).toBe(401);
  const page = await app.request(`/proxy/${upstream.port}/`, { headers: { ...REMOTE, accept: "text/html" } });
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/");
  expect(seen).toBeNull();
});

test("the proxy is off until the owner turns it on", async () => {
  const app = createApp(cfgWith({ portProxy: undefined }));
  const res = await app.request(`/proxy/${upstream.port}/`, { headers: { ...REMOTE, cookie: ownerCookie() } });
  expect(res.status).toBe(404);
  expect(seen).toBeNull();
});

test("the daemon's own port is refused", async () => {
  const app = createApp(cfgWith());
  const res = await app.request("/proxy/7171/", { headers: { ...REMOTE, cookie: ownerCookie() } });
  expect(res.status).toBe(403);
});

test("a share-link guest never reaches another port, even with a control link to every repo", async () => {
  // WHY: this is the one place the proxy is stricter than /api/* (authMiddleware admits a guest);
  // a guest arm added to isOwnerRequest would hand every link holder the owner's local ports.
  initDb();
  const token = mintToken();
  const share = createShare(hashToken(token), {
    label: "proxy guest",
    perm: "control",
    scopeAll: true,
    repoIds: [],
    expiresAt: null,
    token,
  });
  const guest = `${GUEST_COOKIE}=${sign(JSON.stringify({ sid: share.id, exp: Date.now() + 3_600_000 }))}`;
  seen = null;
  const app = createApp(cfgWith());
  const res = await app.request(`/proxy/${upstream.port}/`, { headers: { ...REMOTE, cookie: guest } });
  expect(res.status).toBe(401);
  expect(seen).toBeNull();
});

test("a cross-origin caller is refused even with the owner's cookie", async () => {
  // WHY: the upstream is shown a loopback Origin, so a same-site page on another origin (which
  // SameSite=Lax lets send the owner's cookie) would otherwise slip past the upstream's own check.
  seen = null;
  const app = createApp(cfgWith());
  const res = await app.request(`/proxy/${upstream.port}/`, {
    headers: { ...REMOTE, cookie: ownerCookie(), origin: "https://other.example" },
  });
  expect(res.status).toBe(403);
  expect(seen).toBeNull();
});

test("the owner is forwarded without daemon cookies, and redirects stay under the prefix", async () => {
  const app = createApp(cfgWith());
  // app.request() addresses http://localhost, so that is the daemon's own origin here.
  const res = await app.request(`/proxy/${upstream.port}/app/page?x=1`, {
    headers: { ...REMOTE, cookie: `${ownerCookie()}; app_session=abc`, origin: "http://localhost" },
  });
  expect(seen).toEqual({
    path: "/app/page?x=1",
    cookie: "app_session=abc",
    origin: `http://127.0.0.1:${upstream.port}`,
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/proxy/${upstream.port}/login`);
  expect(res.headers.getSetCookie()).toEqual(["app_session=ok; Path=/"]);
  expect(await res.text()).toBe("from upstream");
});
