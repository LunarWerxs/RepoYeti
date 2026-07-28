/**
 * Tests for the two work-tree appearance settings (`changesStatDisplay`, `changesChars`) added
 * alongside `diffStats` in src/config.ts + src/http/routes/health.ts. Unlike `diffStats`, these
 * are pure display knobs — the daemon computes the same numbers either way — so there is no
 * refreshAllRepos() to assert on here; the coverage is entirely persistence + the
 * absent-means-default contract that an existing config.json (written before this feature
 * shipped) must keep rendering exactly as it did before.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7172, maxDepth: 6, maxRepos: 200 });

test("GET /api/status defaults changesStatDisplay to \"numbers\" and changesChars to true when absent", async () => {
  const app = createApp(localCfg());
  const status = await (await app.request("/api/status")).json();
  expect(status.changesStatDisplay).toBe("numbers");
  expect(status.changesChars).toBe(true);
});

test("PUT /api/settings persists changesStatDisplay and changesChars, and both read back from GET /api/status", async () => {
  const app = createApp(localCfg());

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changesStatDisplay: "bars", changesChars: false }),
  });
  expect(put.status).toBe(200);
  const putBody = await put.json();
  expect(putBody.changesStatDisplay).toBe("bars");
  expect(putBody.changesChars).toBe(false);

  const status = await (await app.request("/api/status")).json();
  expect(status.changesStatDisplay).toBe("bars");
  expect(status.changesChars).toBe(false);
});

test("PUT /api/settings rejects a bogus changesStatDisplay value instead of persisting it", async () => {
  const app = createApp(localCfg());

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changesStatDisplay: "pie-chart" }),
  });
  expect(put.status).toBe(400);
  const body = await put.json();
  expect(body.ok).toBe(false);

  // The rejected value must never have reached config — a fresh GET still reads the default.
  const status = await (await app.request("/api/status")).json();
  expect(status.changesStatDisplay).toBe("numbers");
});

// A rejected value must not take the rest of the body down with it. PUT /api/settings is a bag of
// independent best-effort per-field blocks, and the first cut of the validation `return`ed 400 in
// the middle of it — so {changesStatDisplay:"pie-chart", remoteEditing:false} answered 400 while
// silently dropping remoteEditing and every key ordered after it, having already committed the
// ones before. Caught by an adversarial review that reproduced it live.
test("PUT /api/settings still applies every OTHER field when changesStatDisplay is bogus", async () => {
  const app = createApp(localCfg());

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      changesStatDisplay: "pie-chart", // the rejected one
      changesChars: false, // ordered AFTER it — it used to vanish
      remoteEditing: false,
    }),
  });
  expect(put.status).toBe(400);

  const status = await (await app.request("/api/status")).json();
  expect(status.changesChars).toBe(false);
  expect(status.remoteEditing).toBe(false);
  // …and the bad value itself was still refused, not persisted.
  expect(status.changesStatDisplay).toBe("numbers");
});
