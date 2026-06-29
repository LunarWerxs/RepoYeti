import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/daemon.ts";
import type { GitmobConfig } from "../src/config.ts";
import { MIN_CONTENT_SEARCH } from "../src/service.ts";
import { upsertRepo, getRepo, setRepoHidden, setRepoPinned, setRepoStarred } from "../src/db.ts";

// Local mode (no OIDC) → /api/* is not gated, so we can exercise the routes directly.
const localCfg = (): GitmobConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("GET /api/status reports the version and a null tunnel URL until one is set", async () => {
  const res = await createApp(localCfg()).request("/api/status");
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(typeof j.version).toBe("string");
  expect(j.tunnelUrl).toBeNull();
  // The UI's "search content" gate reads this so it can never drift from the server's.
  expect(j.minContentSearch).toBe(MIN_CONTENT_SEARCH);
});

test("setRepoHidden toggles the dashboard-hidden flag", () => {
  const path = mkdtempSync(join(tmpdir(), "gm-hidden-"));
  const id = upsertRepo(path, "hidden-test", "auto", false);
  expect(getRepo(id)?.hidden).toBe(false);

  setRepoHidden(id, true);
  expect(getRepo(id)?.hidden).toBe(true);

  setRepoHidden(id, false);
  expect(getRepo(id)?.hidden).toBe(false);
});

test("POST /api/repos/:id/hidden hides a known repo and 404s an unknown one", async () => {
  const path = mkdtempSync(join(tmpdir(), "gm-hidden-route-"));
  const id = upsertRepo(path, "hidden-route", "auto", false);
  const app = createApp(localCfg());

  const hide = await app.request(`/api/repos/${id}/hidden`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hidden: true }),
  });
  expect(hide.status).toBe(200);
  expect((await hide.json()).repo.hidden).toBe(true);
  expect(getRepo(id)?.hidden).toBe(true);

  const missing = await app.request("/api/repos/does-not-exist/hidden", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hidden: true }),
  });
  expect(missing.status).toBe(404);
});

test("setRepoPinned / setRepoStarred toggle independent flags", () => {
  const path = mkdtempSync(join(tmpdir(), "gm-fav-"));
  const id = upsertRepo(path, "fav-test", "auto", false);
  expect(getRepo(id)?.pinned).toBe(false);
  expect(getRepo(id)?.starred).toBe(false);

  setRepoPinned(id, true);
  expect(getRepo(id)?.pinned).toBe(true);
  expect(getRepo(id)?.starred).toBe(false); // starring is independent of pinning

  setRepoStarred(id, true);
  expect(getRepo(id)?.pinned).toBe(true);
  expect(getRepo(id)?.starred).toBe(true);

  setRepoPinned(id, false);
  setRepoStarred(id, false);
  expect(getRepo(id)?.pinned).toBe(false);
  expect(getRepo(id)?.starred).toBe(false);
});

test("POST /api/repos/:id/pinned + /starred update a known repo and 404 an unknown one", async () => {
  const path = mkdtempSync(join(tmpdir(), "gm-fav-route-"));
  const id = upsertRepo(path, "fav-route", "auto", false);
  const app = createApp(localCfg());

  const pin = await app.request(`/api/repos/${id}/pinned`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  expect(pin.status).toBe(200);
  expect((await pin.json()).repo.pinned).toBe(true);
  expect(getRepo(id)?.pinned).toBe(true);

  const star = await app.request(`/api/repos/${id}/starred`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ starred: true }),
  });
  expect(star.status).toBe(200);
  expect((await star.json()).repo.starred).toBe(true);
  expect(getRepo(id)?.starred).toBe(true);

  const missing = await app.request("/api/repos/does-not-exist/pinned", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  expect(missing.status).toBe(404);
});
