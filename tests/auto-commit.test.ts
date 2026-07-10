/**
 * Auto-commit timer: the pure helpers (interval clamp · daily-time normalise + next-fire delay ·
 * actionability predicate · plan→commits mapping) plus the settings route plumbing (GET
 * /api/status defaults, PUT /api/settings update + clamp + normalise).
 *
 * The timer itself is never started here (startAutoCommit runs only at daemon boot), so these
 * tests exercise the logic + HTTP surface without spinning a real timer, hitting git, or calling AI.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import {
  clampAutoCommitInterval,
  normalizeDailyAt,
  msUntilDailyAt,
  isAutoCommitActionable,
  planToCommits,
  AUTO_COMMIT_INTERVAL_MIN_S,
  AUTO_COMMIT_INTERVAL_MAX_S,
  AUTO_COMMIT_INTERVAL_DEFAULT_S,
  AUTO_COMMIT_AT_DEFAULT,
} from "../src/auto-commit.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import type { RepoStatus } from "../src/db.ts";
import type { CommitPlan } from "../src/ai.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  remote: "git@host:r.git",
  error: null,
  fetchedAt: null,
  diff: null,
  updatedAt: 0,
  ...over,
});

test("clampAutoCommitInterval bounds the cadence and defaults a bad value", () => {
  expect(clampAutoCommitInterval(5)).toBe(AUTO_COMMIT_INTERVAL_MIN_S); // below floor → floor
  expect(clampAutoCommitInterval(999_999_999)).toBe(AUTO_COMMIT_INTERVAL_MAX_S); // above → ceiling
  expect(clampAutoCommitInterval(900)).toBe(900); // in range → unchanged
  expect(clampAutoCommitInterval(Number.NaN)).toBe(AUTO_COMMIT_INTERVAL_DEFAULT_S);
});

test("normalizeDailyAt accepts valid HH:MM, pads the hour, and rejects garbage", () => {
  expect(normalizeDailyAt("09:05")).toBe("09:05");
  expect(normalizeDailyAt("9:05")).toBe("09:05"); // 1-digit hour → padded
  expect(normalizeDailyAt("23:59")).toBe("23:59");
  expect(normalizeDailyAt("9:5")).toBe(AUTO_COMMIT_AT_DEFAULT); // minutes must be 2 digits
  expect(normalizeDailyAt("24:00")).toBe(AUTO_COMMIT_AT_DEFAULT); // hour out of range
  expect(normalizeDailyAt("12:60")).toBe(AUTO_COMMIT_AT_DEFAULT); // minute out of range
  expect(normalizeDailyAt("")).toBe(AUTO_COMMIT_AT_DEFAULT);
  expect(normalizeDailyAt(undefined)).toBe(AUTO_COMMIT_AT_DEFAULT);
});

test("msUntilDailyAt returns the delay to the next occurrence of the local time", () => {
  const base = new Date(2026, 0, 15, 10, 0, 0, 0).getTime(); // Jan 15 2026, 10:00 local
  const H = 3_600_000;
  expect(msUntilDailyAt("18:00", base)).toBe(8 * H); // later today
  expect(msUntilDailyAt("10:30", base)).toBe(30 * 60_000);
  expect(msUntilDailyAt("09:00", base)).toBe(23 * H); // already past → tomorrow
  expect(msUntilDailyAt("10:00", base)).toBe(24 * H); // exactly now → tomorrow, not zero
});

test("isAutoCommitActionable requires a healthy, attached repo on a branch", () => {
  expect(isAutoCommitActionable(status())).toBe(true);
  expect(isAutoCommitActionable(null)).toBe(false);
  expect(isAutoCommitActionable(status({ error: "boom" }))).toBe(false);
  expect(isAutoCommitActionable(status({ detached: true }))).toBe(false);
  expect(isAutoCommitActionable(status({ branch: null }))).toBe(false);
});

test("planToCommits composes conventional messages and sweeps leftovers into a catch-all", () => {
  const plan: CommitPlan = {
    groups: [
      { type: "feat", scope: "auth", subject: "add token refresh", files: ["src/auth.ts"] },
      { type: "docs", subject: "update readme", body: "more detail", files: ["README.md"] },
      { type: "chore", subject: "nothing here", files: [] }, // dropped: no files
    ],
    leftovers: ["weird.bin"],
    degraded: false,
    truncated: false,
  };
  expect(planToCommits(plan)).toEqual([
    { message: "feat(auth): add token refresh", paths: ["src/auth.ts"] },
    { message: "docs: update readme\n\nmore detail", paths: ["README.md"] },
    { message: "chore: auto-commit remaining changes", paths: ["weird.bin"] },
  ]);
});

test("planToCommits with no groups and no leftovers yields nothing", () => {
  expect(planToCommits({ groups: [], leftovers: [], degraded: false, truncated: false })).toEqual([]);
});

test("GET /api/status defaults auto-commit off; PUT /api/settings updates + clamps + normalises", async () => {
  const app = createApp(localCfg());

  const before = await (await app.request("/api/status")).json();
  expect(before.autoCommit).toBe(false); // opt-in (it pushes)
  expect(before.autoCommitMode).toBe("interval");
  expect(before.autoCommitIntervalSecs).toBe(AUTO_COMMIT_INTERVAL_DEFAULT_S);
  expect(before.autoCommitAt).toBe(AUTO_COMMIT_AT_DEFAULT);
  expect(before.autoCommitPull).toBe(true);
  expect(before.autoCommitPush).toBe(true);

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      autoCommit: true,
      autoCommitMode: "daily",
      autoCommitIntervalSecs: 5, // out of range → clamped up to the floor
      autoCommitAt: "9:30", // → normalised/padded
      autoCommitPull: false,
      autoCommitPush: false,
    }),
  });
  expect(put.status).toBe(200);
  const body = await put.json();
  expect(body.autoCommit).toBe(true);
  expect(body.autoCommitMode).toBe("daily");
  expect(body.autoCommitIntervalSecs).toBe(AUTO_COMMIT_INTERVAL_MIN_S);
  expect(body.autoCommitAt).toBe("09:30");
  expect(body.autoCommitPull).toBe(false);
  expect(body.autoCommitPush).toBe(false);

  // Reset the process-global runtime flags so they can't leak into other test files.
  await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      autoCommit: false,
      autoCommitMode: "interval",
      autoCommitIntervalSecs: AUTO_COMMIT_INTERVAL_DEFAULT_S,
      autoCommitAt: AUTO_COMMIT_AT_DEFAULT,
      autoCommitPull: true,
      autoCommitPush: true,
    }),
  });
});
