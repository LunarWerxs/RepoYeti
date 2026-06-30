/**
 * Background remote-sync check: the pure newly-behind transition detector + the settings
 * route plumbing (GET /api/status defaults, PUT /api/settings toggle + cadence clamp).
 *
 * The timer itself is never started here (startRemoteSync runs only at daemon boot), so these
 * tests exercise the logic and the HTTP surface without spinning a real interval or hitting git.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import {
  computeNewlyBehind,
  clampSyncInterval,
  canAutoPull,
  SYNC_INTERVAL_MIN_S,
  SYNC_INTERVAL_MAX_S,
  SYNC_INTERVAL_DEFAULT_S,
} from "../src/remote-sync.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import type { RepoStatus } from "../src/db.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const repo = (id: string, behind: number, branch = "main") => ({
  id,
  name: id,
  status: { behind, branch },
});

test("computeNewlyBehind seeds the baseline and flags only a FRESH fall-behind", () => {
  const baseline = new Map<string, number>();
  // First pass: 'a' is already 2 behind. Seeding from the pre-fetch count means no warning even
  // though the post count is 2 — the repo was behind before we started watching it.
  const first = computeNewlyBehind([repo("a", 2)], [repo("a", 2)], baseline);
  expect(first).toEqual([]);
  expect(baseline.get("a")).toBe(2);

  // Second pass: 'a' rose 2 → 5 (new remote commits) → one BehindRepo, baseline advances.
  const second = computeNewlyBehind([repo("a", 2)], [repo("a", 5)], baseline);
  expect(second).toEqual([{ id: "a", name: "a", branch: "main", behind: 5 }]);
  expect(baseline.get("a")).toBe(5);
});

test("computeNewlyBehind ignores a steady or shrinking count and forgets vanished repos", () => {
  const baseline = new Map<string, number>([["a", 3]]);
  // 'a' unchanged at 3 (no warn); 'b' is brand-new at 0 (seeded, no warn); both tracked.
  const steady = computeNewlyBehind([repo("a", 3), repo("b", 0)], [repo("a", 3), repo("b", 0)], baseline);
  expect(steady).toEqual([]);
  expect(baseline.get("b")).toBe(0);

  // 'a' shrank 3 → 0 (the owner pulled) → no warn; baseline drops to 0.
  const pulled = computeNewlyBehind([repo("a", 3)], [repo("a", 0)], baseline);
  expect(pulled).toEqual([]);
  expect(baseline.get("a")).toBe(0);
  // 'b' was absent from this post list → forgotten so a re-add re-seeds cleanly.
  expect(baseline.has("b")).toBe(false);
});

test("computeNewlyBehind treats a freshly-behind brand-new repo as a warning", () => {
  const baseline = new Map<string, number>();
  // A repo that appears for the first time already behind: pre seeds it at its own count, so the
  // same-pass post count can't out-rise the baseline → no spurious warn on first sight.
  const seen = computeNewlyBehind([repo("c", 4)], [repo("c", 4)], baseline);
  expect(seen).toEqual([]);
  // …but the NEXT rise does warn.
  const rose = computeNewlyBehind([repo("c", 4)], [repo("c", 6)], baseline);
  expect(rose.map((r) => r.id)).toEqual(["c"]);
});

// A clean, FF-safe status: behind, no local divergence, clean tree, has a remote.
const ffSafe = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 2,
  remote: "git@host:r.git",
  error: null,
  fetchedAt: null,
  diff: null,
  updatedAt: 0,
  ...over,
});

test("canAutoPull only greenlights a clean, behind, non-diverged repo with a remote", () => {
  expect(canAutoPull(ffSafe())).toBe(true);
  expect(canAutoPull(null)).toBe(false);
  expect(canAutoPull(ffSafe({ behind: 0 }))).toBe(false); // not behind → nothing to pull
  expect(canAutoPull(ffSafe({ ahead: 1 }))).toBe(false); // diverged → not a fast-forward
  expect(canAutoPull(ffSafe({ dirty: 3 }))).toBe(false); // local changes → could conflict
  expect(canAutoPull(ffSafe({ detached: true }))).toBe(false); // detached HEAD
  expect(canAutoPull(ffSafe({ remote: null }))).toBe(false); // nothing to pull from
  expect(canAutoPull(ffSafe({ error: "boom" }))).toBe(false); // unhealthy
});

test("clampSyncInterval bounds the cadence and defaults a bad value", () => {
  expect(clampSyncInterval(5)).toBe(SYNC_INTERVAL_MIN_S);
  expect(clampSyncInterval(999_999)).toBe(SYNC_INTERVAL_MAX_S);
  expect(clampSyncInterval(120)).toBe(120);
  expect(clampSyncInterval(Number.NaN)).toBe(SYNC_INTERVAL_DEFAULT_S);
});

test("GET /api/status defaults syncCheck on at 120s; PUT /api/settings toggles + clamps", async () => {
  const app = createApp(localCfg());

  const before = await (await app.request("/api/status")).json();
  expect(before.syncCheck).toBe(true);
  expect(before.syncIntervalSecs).toBe(SYNC_INTERVAL_DEFAULT_S);
  expect(before.keepInSync).toBe(false); // auto-pull is opt-in

  // Disable the check + ask for an out-of-range cadence (5s → clamped to the floor) + opt into
  // keep-in-sync.
  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ syncCheck: false, syncIntervalSecs: 5, keepInSync: true }),
  });
  expect(put.status).toBe(200);
  const putBody = await put.json();
  expect(putBody.syncCheck).toBe(false);
  expect(putBody.syncIntervalSecs).toBe(SYNC_INTERVAL_MIN_S);
  expect(putBody.keepInSync).toBe(true);

  const after = await (await app.request("/api/status")).json();
  expect(after.syncCheck).toBe(false);
  expect(after.syncIntervalSecs).toBe(SYNC_INTERVAL_MIN_S);
  expect(after.keepInSync).toBe(true);

  // Reset the process-global flags so they can't leak into other test files.
  await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ syncCheck: true, syncIntervalSecs: SYNC_INTERVAL_DEFAULT_S, keepInSync: false }),
  });
});
