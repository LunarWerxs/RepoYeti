/**
 * repo_removed must survive the grant row it deletes.
 *
 * releaseShareGrants() drops a repo's share_repos row BEFORE service/repo-mgmt.ts broadcasts
 * repo_removed (forgetRepo → broadcast). For a scopeAll share that was already handled — a missing
 * grant still counts as covered. For a PER-REPO share the predicate was a plain row lookup, so
 * removing one of the two repos a share names left shareCoversRepo answering "not covered" for the
 * very id the removal event carries: the event was dropped and the guest's card stayed on screen
 * until a reload (while every route it hit 404'd). A repo that still EXISTS without a grant keeps
 * answering "not covered" — that is a deliberate revocation, not an absence.
 */
import { test, expect, beforeAll } from "bun:test";
import { $ } from "bun";
import { initDb, createShare, forgetRepo, getRepo, shareCoversRepo, type Share } from "../src/db.ts";
import { guestEventData } from "../src/share/events.ts";
import { hashToken, mintToken } from "../src/share/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: the suite timeout, not bun's 5s default.
useSuiteTimeout();

async function gitRepo(name: string): Promise<string> {
  const dir = mkScratchDir(`share-events-removal-${name}-`);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  return mustUpsertRepo(dir, name, "pinned", false);
}

function perRepo(repoIds: string[]): Share {
  return createShare(hashToken(mintToken()), {
    label: "a and b",
    perm: "view",
    collaborative: false,
    scopeAll: false,
    repoIds,
    expiresAt: null,
  });
}

beforeAll(() => {
  initDb();
});

test("a per-repo share still delivers repo_removed after the grant is released", async () => {
  const a = await gitRepo("a");
  const b = await gitRepo("b");
  // The share names both, so dropping A's grant leaves it alive (B still names it).
  const share = perRepo([a, b]);
  expect(shareCoversRepo(share, a)).toBe(true);

  forgetRepo(a);

  expect(getRepo(a)).toBeNull(); // the repo row is gone...
  expect(shareCoversRepo(share, b)).toBe(true); // ...and the share survived on B.

  const out = guestEventData(share, "repo_removed", { id: a });
  expect(out).not.toBeNull();
  expect(out!.event).toBe("repo_removed");
  expect(JSON.parse(out!.data)).toEqual({ id: a });
});

test("a repo that still EXISTS but was never granted stays out of scope", async () => {
  const a = await gitRepo("live-a");
  const c = await gitRepo("live-c");
  const share = perRepo([a]);

  // c exists but names no grant: a missing row for a live repo is a deliberate revocation, so the
  // event must still be dropped — the fix must not widen the scope to every repo the owner has.
  expect(shareCoversRepo(share, c)).toBe(false);
  expect(guestEventData(share, "repo_removed", { id: c })).toBeNull();
});
