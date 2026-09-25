import { describe, it, expect } from "vitest";
import { rankRepo, sortByAttention, RANK_WEIGHTS } from "@/lib/repo-rank";
import type { Repo, RepoStatus } from "@/types";

// The "Needs attention" sort is only trustworthy if (a) the reasons a card shows add up to the
// score that placed it, (b) cheap volume (thousands of generated files) cannot bury a real
// blocker, and (c) staleness demotes a repo without dropping it from the list. These pin all three.

const NOW = Date.UTC(2026, 8, 25);
const DAY = 24 * 60 * 60 * 1000;

function status(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: "main",
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: "origin",
    error: null,
    fetchedAt: NOW - DAY,
    updatedAt: NOW - 10 * DAY,
    ...over,
  };
}

// `headMovedAt` (HEAD's reflog time) is the activity signal. The row's `updatedAt` is pinned to NOW
// because that is what production holds right after a daemon restart or rescan: a ranking that
// read it would call every repo "active" and the zero-score and stale cases below would fail.
function repo(id: string, st: Partial<RepoStatus> | null, headMovedAt = NOW - 10 * DAY): Repo {
  return {
    id,
    name: id,
    displayName: null,
    absPath: `/work/${id}`,
    source: "auto",
    vcs: "git",
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    sortOrder: null,
    status: st ? status({ headMovedAt, ...st }) : null,
    updatedAt: NOW,
  };
}

describe("rankRepo", () => {
  it("scores a clean, recently fetched, mid-age repo at zero with no reasons", () => {
    expect(rankRepo(repo("calm", {}), NOW)).toEqual({ score: 0, reasons: [] });
  });

  it("makes the shown score exactly the sum of the shown reasons", () => {
    const r = rankRepo(repo("busy", { conflicted: true, behind: 3, ahead: 2, dirty: 40, detached: true }), NOW);
    const sum = r.reasons.reduce((s, x) => s + x.points, 0);
    expect(r.score).toBeCloseTo(sum, 5);
    expect(r.reasons.map((x) => x.key)).toContain("conflicted");
  });

  it("caps behind + ahead + dirty as one group so volume cannot outrank a conflict", () => {
    const flood = rankRepo(repo("flood", { behind: 500, ahead: 500, dirty: 50_000 }), NOW);
    const volume = flood.reasons
      .filter((x) => x.key === "behind" || x.key === "ahead" || x.key === "dirty")
      .reduce((s, x) => s + x.points, 0);
    expect(volume).toBeLessThanOrEqual(RANK_WEIGHTS.volumeCap);
    expect(flood.score).toBeLessThan(rankRepo(repo("conflict", { conflicted: true }), NOW).score);
  });

  it("weighs an unpushed commit above a changed file", () => {
    const ahead = rankRepo(repo("a", { ahead: 1 }), NOW).score;
    const dirty = rankRepo(repo("d", { dirty: 1 }), NOW).score;
    expect(ahead).toBeGreaterThan(dirty);
  });
});

describe("sortByAttention", () => {
  it("demotes a stale repo below an idle one but keeps it in the list", () => {
    const stale = repo("stale", {}, NOW - 400 * DAY);
    const idle = repo("idle", {}, NOW - 10 * DAY);
    const sorted = sortByAttention([stale, idle], NOW);
    expect(sorted.map((r) => r.id)).toEqual(["idle", "stale"]);
    expect(rankRepo(stale, NOW).reasons).toEqual([{ key: "stale", points: RANK_WEIGHTS.stale, days: 400 }]);
  });

  it("still lifts a stale repo that has something genuinely wrong with it", () => {
    const staleConflict = repo("old-conflict", { conflicted: true }, NOW - 400 * DAY);
    const freshDirty = repo("fresh", { dirty: 3 }, NOW - 60 * 1000);
    expect(sortByAttention([freshDirty, staleConflict], NOW)[0].id).toBe("old-conflict");
  });
});
