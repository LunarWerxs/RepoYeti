import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { readIncoming } from "../src/read/incoming.ts";
import { readStatus } from "../src/read/status.ts";
import { gitPullFfOnly } from "../src/git-actions.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

// The pre-pull preview must be able to describe a pull WITHOUT performing one. These tests pin
// both halves of that: the description is correct, and the working tree is provably untouched
// afterwards (the whole safety claim of the feature).

interface Fixture {
  /** The local clone doing the previewing. */
  work: string;
  /** A second clone used to publish upstream commits. */
  other: string;
}

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/**
 * Allowance for the three tests that build a real upstream and read it back.
 *
 * `fixture()` + `publishUpstream()` spawn a dozen git processes before the first assertion,
 * and these three then diff a worktree and an index against that remote. Measured 2026-08-21
 * on a BUSY machine (a dozen concurrent agent sessions, which is the condition the flake shows
 * up under, not the condition to design away from): 8.2s, 5.9s and 4.3s. That is comfortably
 * inside the gate's --timeout, and comfortably OUTSIDE bun's bare 5s default -- so `bun test`
 * typed without the repo's flag failed them and looked like a runtime regression. It caused a
 * real misdiagnosis once (a retracted "Bun 1.4 broke this repo" claim), so the budget is stated
 * here and the test is correct under any invocation.
 */
const UPSTREAM_ROUND_TIMEOUT_MS = 60_000;

/** A bare remote plus two clones, both on `main`, sharing one base commit. */
async function fixture(): Promise<Fixture> {
  const root = mkScratchDir("gm-incoming-");
  const bare = join(root, "remote.git");
  await $`git -c init.defaultBranch=main init -q --bare ${bare}`.quiet();

  const work = join(root, "work");
  await $`git -c init.defaultBranch=main clone -q ${bare} ${work}`.quiet();
  const W = git(work);
  writeFileSync(join(work, "a.txt"), "line1\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "base");
  await W("push", "-q", "-u", "origin", "main");

  const other = join(root, "other");
  await $`git clone -q ${bare} ${other}`.quiet();
  return { work, other };
}

const git = (dir: string) => (...a: string[]) =>
  $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();

/** Publish two commits upstream: one text change, one binary add. */
async function publishUpstream(other: string): Promise<void> {
  const O = git(other);
  writeFileSync(join(other, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(other, "b.txt"), "new\n");
  await O("add", "-A");
  await O("commit", "-q", "-m", "feat: add b, extend a");
  writeFileSync(join(other, "c.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await O("add", "-A");
  await O("commit", "-q", "-m", "chore: add binary");
  await O("push", "-q", "origin", "main");
}

test("describes a clean fast-forward pull without touching the working tree", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const before = readFileSync(join(work, "a.txt"), "utf8");
  await git(work)("fetch", "-q");

  const r = await readIncoming(work);
  expect(r.ok).toBe(true);
  expect(r.noUpstream).toBe(false);
  expect(r.upstream).toBe("origin/main");
  expect(r.ahead).toBe(0);
  expect(r.behind).toBe(2);
  expect(r.relation).toBe("behind_fast_forward");
  expect(r.pullDisposition).toBe("ready_fast_forward");
  expect(r.checkedAt).toBeGreaterThan(0);
  expect(r.snapshot).toMatchObject({
    headOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    upstreamOid: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    worktreeStateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    indexWorktreeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    token: expect.stringMatching(/^[0-9a-f]{64}$/),
  });

  // Both upstream commits show up, newest first.
  expect(r.commits.map((c) => c.subject)).toEqual(["chore: add binary", "feat: add b, extend a"]);

  // The net file effect: a.txt grew by 2, b.txt is new, c.bin is binary (counted, no lines).
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
  expect(byPath["a.txt"]).toMatchObject({ status: "M", addedLines: 2, removedLines: 0, binary: false });
  expect(byPath["b.txt"]).toMatchObject({ status: "A", addedLines: 1, removedLines: 0, binary: false });
  expect(byPath["c.bin"]).toMatchObject({ status: "A", binary: true, addedLines: 0, removedLines: 0 });
  expect(r.stat).toEqual({ filesChanged: 3, addedLines: 3, removedLines: 0 });

  // Nothing of ours to reconcile, so it's a fast-forward and cannot conflict.
  expect(r.fastForward).toBe(true);
  expect(r.conflictCheck).toBe(true);
  expect(r.conflicts).toEqual([]);

  // The whole point: we described the pull without doing it.
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe(before);
  const dirty = (await $`git -C ${work} status --porcelain`.text()).trim();
  expect(dirty).toBe("");

  // The preview's green verdict and the mutating ff-only contract agree.
  expect((await gitPullFfOnly(work, null)).code).toBe("OK");
}, UPSTREAM_ROUND_TIMEOUT_MS);

test("predicts a conflict before the pull, still without touching the working tree", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const W = git(work);

  // Diverge: edit the same line upstream touched.
  writeFileSync(join(work, "a.txt"), "line1\nMINE\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "local: edit a");
  await W("fetch", "-q");
  const before = readFileSync(join(work, "a.txt"), "utf8");

  const r = await readIncoming(work);
  expect(r.ok).toBe(true);
  expect(r.fastForward).toBe(false); // we have a commit of our own now
  expect(r.ahead).toBe(1);
  expect(r.behind).toBe(2);
  expect(r.relation).toBe("diverged");
  expect(r.pullDisposition).toBe("blocked_non_fast_forward");
  expect(r.conflictCheck).toBe(true);
  expect(r.conflicts).toContain("a.txt");

  // The merge was simulated in the object store only.
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe(before);
  expect((await $`git -C ${work} status --porcelain`.text()).trim()).toBe("");
  // And no merge was left half-applied.
  const head = (await $`git -C ${work} rev-parse --abbrev-ref HEAD`.text()).trim();
  expect(head).toBe("main");
  expect((await gitPullFfOnly(work, null)).code).toBe("NON_FAST_FORWARD");
});

test("a divergence that does not overlap reports no conflict", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const W = git(work);

  // Our own commit, but in a file upstream never touched.
  writeFileSync(join(work, "mine.txt"), "only mine\n");
  await W("add", "-A");
  await W("commit", "-q", "-m", "local: unrelated file");
  await W("fetch", "-q");

  const r = await readIncoming(work);
  expect(r.fastForward).toBe(false);
  expect(r.relation).toBe("diverged");
  expect(r.pullDisposition).toBe("blocked_non_fast_forward");
  expect(r.conflictCheck).toBe(true);
  expect(r.conflicts).toEqual([]);
  // Our local-only file must NOT appear as incoming: three-dot diff compares against the merge
  // base, so it reports what upstream adds, not what we already have.
  expect(r.files.some((f) => f.path === "mine.txt")).toBe(false);
  // A clean *merge* is still not a fast-forward. This is the exact contradiction that made the
  // old preview green immediately before the real pull rejected the same graph.
  expect((await gitPullFfOnly(work, null)).code).toBe("NON_FAST_FORWARD");
});

test("reports nothing incoming when already up to date", async () => {
  const { work } = await fixture();
  await git(work)("fetch", "-q");
  const r = await readIncoming(work);
  expect(r.ok).toBe(true);
  expect(r.ahead).toBe(0);
  expect(r.behind).toBe(0);
  expect(r.relation).toBe("up_to_date");
  expect(r.pullDisposition).toBe("noop");
  expect(r.commits).toEqual([]);
  expect(r.files).toEqual([]);
  expect(r.stat).toEqual({ filesChanged: 0, addedLines: 0, removedLines: 0 });
});

test("a branch with no upstream is a normal state, not an error", async () => {
  const { work } = await fixture();
  const W = git(work);
  await W("checkout", "-q", "-b", "solo");
  const r = await readIncoming(work);
  expect(r.ok).toBe(true);
  expect(r.noUpstream).toBe(true);
  expect(r.upstream).toBe("");
  expect(r.relation).toBe("no_upstream");
  expect(r.pullDisposition).toBe("noop");
  expect(r.commits).toEqual([]);
});

test("previewing works on a dirty tree and leaves the edits alone", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const W = git(work);
  await W("fetch", "-q");

  // Uncommitted local edit, of the sort that would block a real merge.
  writeFileSync(join(work, "a.txt"), "line1\nUNCOMMITTED\n");
  const statusBeforePreview = await $`git -C ${work} status --porcelain`.text();

  const r = await readIncoming(work);
  expect(r.ok).toBe(true);
  expect(r.commits.length).toBe(2);
  expect(r.relation).toBe("behind_fast_forward");
  expect(r.pullDisposition).toBe("blocked_would_overwrite");
  // The edit survives untouched: merge-tree never reads the working tree or the index.
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("line1\nUNCOMMITTED\n");
  expect(await $`git -C ${work} status --porcelain`.text()).toBe(statusBeforePreview);
  expect((await gitPullFfOnly(work, null)).code).toBe("WOULD_OVERWRITE");
  expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("line1\nUNCOMMITTED\n");
});

test("a dirty unrelated path remains ready for fast-forward and survives the pull", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  await git(work)("fetch", "-q");
  writeFileSync(join(work, "mine.txt"), "uncommitted but unrelated\n");
  const statusBeforePreview = await $`git -C ${work} status --porcelain`.text();

  const r = await readIncoming(work);
  expect(r.relation).toBe("behind_fast_forward");
  expect(r.pullDisposition).toBe("ready_fast_forward");
  expect(r.conflicts).toEqual([]);
  expect(readFileSync(join(work, "mine.txt"), "utf8")).toBe("uncommitted but unrelated\n");
  expect(await $`git -C ${work} status --porcelain`.text()).toBe(statusBeforePreview);

  expect((await gitPullFfOnly(work, null)).code).toBe("OK");
  expect(readFileSync(join(work, "mine.txt"), "utf8")).toBe("uncommitted but unrelated\n");
});

test("snapshot token changes with worktree and index state even when commit counts do not", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const W = git(work);
  await W("fetch", "-q");

  const clean = await readIncoming(work);
  expect(clean.pullDisposition).toBe("ready_fast_forward");
  expect(clean.snapshot).not.toBeNull();

  // An unrelated dirty path keeps the pull safe, but it is still a different checked state.
  writeFileSync(join(work, "mine.txt"), "untracked\n");
  const untracked = await readIncoming(work);
  expect(untracked.ahead).toBe(clean.ahead);
  expect(untracked.behind).toBe(clean.behind);
  expect(untracked.pullDisposition).toBe("ready_fast_forward");
  expect(untracked.snapshot?.headOid).toBe(clean.snapshot?.headOid);
  expect(untracked.snapshot?.upstreamOid).toBe(clean.snapshot?.upstreamOid);
  expect(untracked.snapshot?.indexWorktreeHash).not.toBe(clean.snapshot?.indexWorktreeHash);
  expect(untracked.snapshot?.token).not.toBe(clean.snapshot?.token);

  await W("add", "mine.txt");
  const staged = await readIncoming(work);
  expect(staged.ahead).toBe(clean.ahead);
  expect(staged.behind).toBe(clean.behind);
  expect(staged.snapshot?.indexWorktreeHash).not.toBe(untracked.snapshot?.indexWorktreeHash);
  expect(staged.snapshot?.token).not.toBe(untracked.snapshot?.token);
}, UPSTREAM_ROUND_TIMEOUT_MS);

test("a same-path staged blob replacement makes the cached preview stale", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  const W = git(work);
  await W("fetch", "-q");

  const stagedPath = join(work, "mine.txt");
  writeFileSync(stagedPath, "staged version one\n");
  await W("add", "mine.txt");
  const porcelainBefore = await $`git -C ${work} status --porcelain=v1`.text();
  const cached = await readIncoming(work);
  expect(cached.pullDisposition).toBe("ready_fast_forward");
  expect(cached.snapshot).not.toBeNull();

  // The path and its `A ` index/worktree status stay byte-for-byte identical; only the
  // stage-0 blob OID changes.
  writeFileSync(stagedPath, "staged version two\n");
  await W("add", "mine.txt");
  const porcelainAfter = await $`git -C ${work} status --porcelain=v1`.text();
  expect(porcelainAfter).toBe(porcelainBefore);

  const liveStatus = await readStatus(work);
  const refreshed = await readIncoming(work);
  expect(liveStatus.dirty).toBe(1);
  expect(cached.ahead).toBe(refreshed.ahead);
  expect(cached.behind).toBe(refreshed.behind);
  expect(cached.snapshot?.headOid).toBe(refreshed.snapshot?.headOid);
  expect(cached.snapshot?.upstreamOid).toBe(refreshed.snapshot?.upstreamOid);
  expect(cached.snapshot?.worktreeStateHash).not.toBe(liveStatus.worktreeStateHash);
  expect(refreshed.snapshot?.worktreeStateHash).toBe(liveStatus.worktreeStateHash ?? undefined);
  expect(refreshed.snapshot?.token).not.toBe(cached.snapshot?.token);
}, UPSTREAM_ROUND_TIMEOUT_MS);

test("snapshot identifies a replaced upstream tip even when ahead/behind counts match", async () => {
  const { work, other } = await fixture();
  const W = git(work);
  const O = git(other);

  writeFileSync(join(other, "remote.txt"), "first\n");
  await O("add", "-A");
  await O("commit", "-q", "-m", "remote version one");
  await O("push", "-q", "origin", "main");
  await W("fetch", "-q");
  const first = await readIncoming(work);
  expect(first.ahead).toBe(0);
  expect(first.behind).toBe(1);

  writeFileSync(join(other, "remote.txt"), "replacement\n");
  await O("add", "-A");
  await O("commit", "-q", "--amend", "-m", "remote version two");
  await O("push", "-q", "--force", "origin", "main");
  await W("fetch", "-q");
  const replacement = await readIncoming(work);
  expect(replacement.ahead).toBe(first.ahead);
  expect(replacement.behind).toBe(first.behind);
  expect(replacement.snapshot?.headOid).toBe(first.snapshot?.headOid);
  expect(replacement.snapshot?.upstreamOid).not.toBe(first.snapshot?.upstreamOid);
  expect(replacement.snapshot?.token).not.toBe(first.snapshot?.token);
});

test("an ahead-only branch is a no-op pull relationship", async () => {
  const { work } = await fixture();
  writeFileSync(join(work, "local.txt"), "local\n");
  await git(work)("add", "-A");
  await git(work)("commit", "-q", "-m", "local only");

  const r = await readIncoming(work);
  expect(r.ahead).toBe(1);
  expect(r.behind).toBe(0);
  expect(r.relation).toBe("ahead_only");
  expect(r.pullDisposition).toBe("noop");
  expect(r.commits).toEqual([]);
});

test("per-commit stats ride along with each incoming commit", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  await git(work)("fetch", "-q");

  const r = await readIncoming(work);
  const feat = r.commits.find((c) => c.subject === "feat: add b, extend a")!;
  expect(feat.stat).toEqual({ filesChanged: 2, addedLines: 3, removedLines: 0 });
  const bin = r.commits.find((c) => c.subject === "chore: add binary")!;
  expect(bin.stat).toEqual({ filesChanged: 1, addedLines: 0, removedLines: 0 });
});

test("/incoming?fetch=1 returns an error result instead of blessing stale refs after fetch fails", async () => {
  const { work, other } = await fixture();
  await publishUpstream(other);
  // Keep origin/main stale at the base commit, then make the configured remote impossible to
  // fetch. Falling through to readIncoming would incorrectly report "up to date".
  await git(work)("remote", "set-url", "origin", join(work, "missing-remote.git"));
  const id = mustUpsertRepo(work, "incoming-fetch-failure", "auto", false);
  const app = createApp(localCfg());

  const response = await app.request(`/api/repos/${id}/incoming?fetch=1`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("ERROR");
  expect(body.noUpstream).toBe(false);
  expect(body.relation).toBe("unknown");
  expect(body.pullDisposition).toBe("unknown");
  expect(body.checkedAt).toBeGreaterThan(0);
  expect(body.snapshot).toBeNull();
  expect(body.message).toBeTruthy();
  expect(body.commits).toEqual([]);
});
