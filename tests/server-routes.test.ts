/**
 * Lore servers registry routes (/api/servers). Covers the read + validation paths that do NOT
 * persist config (so the test never writes ~/.repoyeti); the happy-path add/clone is exercised at
 * the service layer (cloneLoreRepo) against a live binary, not here.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// Local mode (no OIDC) → /api/* is ungated, so routes are exercised directly.
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const J = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("GET /api/servers is empty by default", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/servers");
  expect(res.status).toBe(200);
  expect((await res.json()).servers).toEqual([]);
});

test("POST /api/servers rejects a non-lore URL (400, before any write)", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/servers", J({ url: "not-a-url" }));
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});

test("POST /api/servers/clone rejects a destination outside any scan root (400)", async () => {
  const app = createApp(localCfg());
  const res = await app.request(
    "/api/servers/clone",
    J({ url: "lore://127.0.0.1:41337/x", parentPath: "/definitely/not/a/scan/root" }),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_REQUEST");
});
