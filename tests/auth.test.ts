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

test("health + status probes stay public even in remote mode over the tunnel", async () => {
  const app = appWith(remoteMode);
  expect((await app.request("/api/health", REMOTE)).status).toBe(200);
  expect((await app.request("/api/auth/status", REMOTE)).status).toBe(200);
  expect((await app.request("/api/status", REMOTE)).status).toBe(200);
  // and locally, with no session, the UI can still read mode/tunnel state
  expect((await app.request("/api/status")).status).toBe(200);
});
