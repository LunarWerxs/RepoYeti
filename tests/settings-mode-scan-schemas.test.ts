/**
 * Coverage for the zod migration of PUT /api/settings, PUT /api/mode, and POST /api/scan (see
 * SettingsUpdateSchema / ModeUpdateSchema / ScanSchema in src/schemas.ts). These three routes
 * used to hand-roll their own `typeof b.x === "..."` body parsing; now they go through the same
 * `parseBody` helper every other structured route uses.
 *
 * Two properties matter most, since the migration could easily have broken either one:
 *  - a partial update must leave every OTHER setting/piece of state untouched (an absent key
 *    means "leave this alone", never "reset it" — see schemas.ts's SettingsUpdateSchema doc);
 *  - a genuinely malformed body (a JSON value that isn't even an object) must be rejected with
 *    the standard `{ ok: false, code, message }` envelope, not silently ignored or thrown past.
 */
import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { getRepos } from "../src/db.ts";
import { isScanning } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// ── PUT /api/settings ──────────────────────────────────────────────────────────────

test("PUT /api/settings: a partial update leaves other already-set fields untouched", async () => {
  const app = createApp(localCfg());

  const first = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoScan: true, loreServersEnabled: true }),
  });
  expect(first.status).toBe(200);

  // A second PUT that only names ONE unrelated field — the two set above are absent, not false.
  const second = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hideTrayIcon: true }),
  });
  expect(second.status).toBe(200);

  const status = await (await app.request("/api/status")).json();
  expect(status.autoScan).toBe(true);
  expect(status.loreServersEnabled).toBe(true);
  expect(status.hideTrayIcon).toBe(true);
});

test("PUT /api/settings: a malformed (non-object) body is rejected with the standard envelope", async () => {
  const app = createApp(localCfg());

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([1, 2, 3]), // valid JSON, wrong root shape
  });
  expect(put.status).toBe(400);
  const body = await put.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("BAD_REQUEST");
  expect(typeof body.message).toBe("string");

  // Nothing from the rejected body reached config.
  const status = await (await app.request("/api/status")).json();
  expect(status.autoScan).toBe(false);
});

// ── PUT /api/mode ───────────────────────────────────────────────────────────────────

test("PUT /api/mode: a valid mode update leaves unrelated settings untouched", async () => {
  const app = createApp(localCfg());

  const settingsPut = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hideTrayIcon: true }),
  });
  expect(settingsPut.status).toBe(200);

  // Already local by default, so this is a legal no-op mode change (no owner required).
  const modePut = await app.request("/api/mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "local" }),
  });
  expect(modePut.status).toBe(200);

  const status = await (await app.request("/api/status")).json();
  expect(status.mode).toBe("local");
  expect(status.hideTrayIcon).toBe(true); // untouched by the mode route
});

test("PUT /api/mode: a malformed (non-object) body is rejected with the standard envelope", async () => {
  const app = createApp(localCfg());

  const put = await app.request("/api/mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([1, 2, 3]),
  });
  expect(put.status).toBe(400);
  const body = await put.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("BAD_REQUEST");
});

// ── POST /api/scan ──────────────────────────────────────────────────────────────────

async function gitRepoIn(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

async function waitIdle(): Promise<void> {
  for (let i = 0; i < 200 && isScanning(); i++) await new Promise((r) => setTimeout(r, 10));
}

test("POST /api/scan: a folder-scoped scan indexes only that folder, leaving the rest untouched", async () => {
  await waitIdle();
  const rootA = mkScratchDir("gm-scanA-");
  const rootB = mkScratchDir("gm-scanB-");
  const childA = await gitRepoIn(rootA, "alpha");
  await gitRepoIn(rootB, "beta"); // never scanned — must not show up

  // Snapshot first and assert on the DELTA. getRepos() is the whole suite's shared database, and
  // other test files run whole-machine scans that legitimately index `.testtmp/` — so "no repo
  // named beta exists anywhere" is not a fact this test owns, and asserting it made the file pass
  // alone and fail in the suite. What this test can own is what ITS OWN scan added.
  const before = new Set(getRepos().map((r) => r.absPath));

  const app = createApp(localCfg());
  const res = await app.request("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: rootA }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, running: true, scope: "folder" });

  await waitIdle();
  expect(getRepos().some((r) => r.absPath === childA)).toBe(true);
  const added = getRepos()
    .map((r) => r.absPath)
    .filter((p) => !before.has(p));
  // Everything this scan brought in came from the folder it was scoped to.
  for (const p of added) expect(p.startsWith(rootA)).toBe(true);
  expect(added.some((p) => p.startsWith(rootB))).toBe(false);
});

test("POST /api/scan: a malformed (non-object) body is rejected with the standard envelope", async () => {
  await waitIdle();
  const app = createApp(localCfg());

  const res = await app.request("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([1, 2, 3]),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("BAD_REQUEST");
  expect(isScanning()).toBe(false); // never started
});
