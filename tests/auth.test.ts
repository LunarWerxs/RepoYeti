import { test, expect } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../src/auth.ts";
import {
  authEnforced,
  accessMode,
  ownerConfigured,
  tunnelStartProblem,
  type RepoYetiConfig,
} from "../src/config.ts";

const base: RepoYetiConfig = { roots: [], port: 7171, maxDepth: 6, maxRepos: 200 };
const withOAuth: RepoYetiConfig = {
  ...base,
  oauth: {
    issuer: "https://accounts.connections.icu",
    clientId: "cid",
    redirectUri: "https://repoyeti-auth.example.workers.dev/cb",
    ownerSub: "owner-1",
  },
};
const remoteMode: RepoYetiConfig = { ...withOAuth, mode: "remote" };
const localMode: RepoYetiConfig = { ...withOAuth, mode: "local" };

function appWith(cfg: RepoYetiConfig): Hono {
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/status", (c) => c.json({ ok: true }));
  app.get("/api/auth/status", (c) => c.json({ ok: true }));
  return app;
}

// A request that arrived over the Cloudflare tunnel carries a connecting-ip header that
// a true-localhost request never has — that's how the daemon tells remote from local.
const REMOTE = { headers: { "cf-connecting-ip": "203.0.113.7" } };

test("authEnforced reflects an OIDC client being present", () => {
  expect(authEnforced(base)).toBe(false);
  expect(authEnforced(withOAuth)).toBe(true);
});

test("accessMode defaults to local and reflects the toggle", () => {
  expect(accessMode(base)).toBe("local");
  expect(accessMode(localMode)).toBe("local");
  expect(accessMode(remoteMode)).toBe("remote");
});

test("tunnels require both auth and an already configured owner", () => {
  expect(ownerConfigured(base)).toBe(false);
  expect(tunnelStartProblem(base)).toBe("auth");
  expect(tunnelStartProblem({ ...withOAuth, oauth: { ...withOAuth.oauth!, ownerSub: undefined } })).toBe("owner");
  expect(ownerConfigured(withOAuth)).toBe(true);
  expect(tunnelStartProblem(withOAuth)).toBeNull();
});

test("no OIDC client → /api/* passes through (bare/local config)", async () => {
  const res = await appWith(base).request("/api/repos");
  expect(res.status).toBe(200);
});

test("local mode → local requests pass without a login", async () => {
  const res = await appWith(localMode).request("/api/repos");
  expect(res.status).toBe(200);
});

test("local mode → a request over the tunnel STILL requires a login (no bypass remotely)", async () => {
  const res = await appWith(localMode).request("/api/repos", REMOTE);
  expect(res.status).toBe(401);
  expect((await res.text()).length).toBe(0);
});

test("remote mode → a tunnel request without a session is 401 (empty body, no leak)", async () => {
  const res = await appWith(remoteMode).request("/api/repos", REMOTE);
  expect(res.status).toBe(401);
  expect((await res.text()).length).toBe(0);
});

test("remote mode → a local request without a session/bypass is 401 (shows the gate)", async () => {
  const res = await appWith(remoteMode).request("/api/repos");
  expect(res.status).toBe(401);
});

test("the auth probes stay public even in remote mode over the tunnel", async () => {
  // These two must stay reachable with no session: they are what the sign-in gate itself is built
  // on. Both are safe to expose because they only ECHO the caller's own verified cookie — an
  // anonymous caller gets nulls, never the owner's identity (see routes/auth.ts).
  const app = appWith(remoteMode);
  expect((await app.request("/api/health", REMOTE)).status).toBe(200);
  expect((await app.request("/api/auth/status", REMOTE)).status).toBe(200);
});

test("GET /api/status is NOT public — it's the owner's settings dump", async () => {
  // This route used to sit in the public allowlist, and this test used to assert that. It was a
  // real (if quiet) hole: /api/status returns the tunnel config, MCP rails, auto-commit schedule,
  // default editor and version, so anyone who merely knew the tunnel URL could read all of it —
  // flatly contradicting the threat model in docs/ARCHITECTURE.md §7 ("Hit any endpoint → 401,
  // empty body: no surface, no version, no repo data").
  //
  // Nothing actually needed it open. The PWA calls it only AFTER the gate passes (AppShell.vue
  // returns at the sign-in screen before loadAll()), and SignIn.vue runs entirely off
  // /api/auth/status. Share-link guests, who DO need it, get a narrow projection instead
  // (routes/health.ts) — never the owner's settings.
  const app = appWith(remoteMode);
  expect((await app.request("/api/status", REMOTE)).status).toBe(401);
  // Local + remote mode still needs a session/bypass, like every other route in that combination.
  expect((await app.request("/api/status")).status).toBe(401);
  // ...and in local mode a loopback request is open, exactly as before.
  expect((await appWith(localMode).request("/api/status")).status).toBe(200);
});
