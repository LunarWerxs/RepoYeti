import { test, expect } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../src/auth.ts";
import { authEnforced, type GitmobConfig } from "../src/config.ts";

const base: GitmobConfig = { roots: [], port: 7171, maxDepth: 6, maxRepos: 200 };
const withOAuth: GitmobConfig = {
  ...base,
  oauth: {
    issuer: "https://accounts.connections.icu",
    clientId: "cid",
    redirectUri: "https://gitmob-auth.example.workers.dev/cb",
    ownerSub: "owner-1",
  },
};

function appWith(cfg: GitmobConfig): Hono {
  const app = new Hono();
  app.use("/api/*", authMiddleware(cfg));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/auth/status", (c) => c.json({ ok: true }));
  return app;
}

test("authEnforced reflects config presence", () => {
  expect(authEnforced(base)).toBe(false);
  expect(authEnforced(withOAuth)).toBe(true);
});

test("no OIDC config → /api/* passes through (local mode)", async () => {
  const res = await appWith(base).request("/api/repos");
  expect(res.status).toBe(200);
});

test("OIDC enforced → protected route is 401 with an empty body (no leak)", async () => {
  const res = await appWith(withOAuth).request("/api/repos");
  expect(res.status).toBe(401);
  expect((await res.text()).length).toBe(0);
});

test("OIDC enforced → /api/health and /api/auth/status stay public", async () => {
  const app = appWith(withOAuth);
  expect((await app.request("/api/health")).status).toBe(200);
  expect((await app.request("/api/auth/status")).status).toBe(200);
});
