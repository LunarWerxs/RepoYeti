/**
 * What the two unattended timers actually DO — as opposed to how they are scheduled, which is all
 * tests/remote-sync.test.ts and tests/auto-commit.test.ts could reach before.
 *
 * Both rounds were untestable by construction: each runs only from its own timer, and the cadence
 * floors are 30s and 60s, so the code that fetches every repo and the code that COMMITS to the
 * owner's repositories unattended were the least-covered things in the daemon. Both modules now
 * export the round the timer calls (runSyncCheckNow / runAutoCommitNow), which is what these
 * drive — the real round, every safety gate in place, against real git repositories.
 */
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { addListener, removeListener } from "../src/bus.ts";
import { runSyncCheckNow, setKeepInSync } from "../src/remote-sync.ts";
import {
  runAutoCommitNow,
  setAutoCommitConfig,
  setAutoCommitPull,
  setAutoCommitPush,
} from "../src/auto-commit.ts";
import { refreshRepo } from "../src/service/index.ts";
import { getRepo, setRepoAutoCommit } from "../src/db.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir, fileUrl } from "./helpers/scratch.ts";

const noAiConfig = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/**
 * Allowance for the two rounds that drive a REAL remote round-trip.
 *
 * `tracked()` below spawns a dozen-odd git processes (bare init, seed init, add, commit, remote
 * add, push, clone) before the assertions even start, and the round then fetches, pulls and pushes
 * over that remote. Measured on Windows, three runs: the sync round takes 3.0-3.9s and the
 * pull-first/push-after round 4.2-6.3s — so the 5s default was BELOW the honest cost of one of
 * them and barely above the other, and both failed intermittently for no reason but process
 * spawn time. A CI runner is slower than a dev box, so the allowance carries real headroom over
 * the worst observed run rather than hugging it.
 *
 * The three local-only tests keep the default: they never leave the working copy and run in
 * well under a second, so a slow one there would be a genuine signal.
 */
const REMOTE_ROUND_TIMEOUT_MS = 30_000;

function capture(): { events: Array<{ event: string; payload: unknown }>; stop: () => void } {
  const events: Array<{ event: string; payload: unknown }> = [];
  const listener = (event: string, _data: string, payload: unknown): void =>
    void events.push({ event, payload });
  addListener(listener);
  return { events, stop: () => removeListener(listener) };
}

const git = (dir: string) => (...args: string[]) =>
  $`git -C ${dir} -c user.name=S -c user.email=s@s.io ${args}`.quiet();

/** A bare "remote" with one commit, plus a working clone of it that is registered and refreshed. */
async function tracked(name: string): Promise<{ id: string; work: string; seed: string }> {
  const bare = mkScratchDir(`gm-round-${name}-bare-`);
  await $`git -c init.defaultBranch=main init -q --bare ${bare}`.quiet();

  const seed = mkScratchDir(`gm-round-${name}-seed-`);
  await $`git -c init.defaultBranch=main init -q ${seed}`.quiet();
  writeFileSync(join(seed, "a.txt"), "one\n");
  await git(seed)("add", "-A");
  await git(seed)("commit", "-q", "-m", "init");
  await git(seed)("remote", "add", "origin", fileUrl(bare));
  await git(seed)("push", "-q", "-u", "origin", "main");

  const work = mkScratchDir(`gm-round-${name}-work-`);
  await $`git clone -q ${fileUrl(bare)} ${work}`.quiet();
  const id = mustUpsertRepo(work, `round-${name}`, "auto", false);
  await refreshRepo(id, work); // the round only fetches repos whose stored status has a remote
  return { id, work, seed };
}

/** Land one more commit on the shared remote, so the working clone falls behind. Takes whatever
 *  is already there first — the round under test may have pushed to this same remote. */
async function pushUpstream(seed: string, text: string): Promise<void> {
  await git(seed)("pull", "-q", "--ff-only");
  writeFileSync(join(seed, "a.txt"), `${text}\n`);
  await git(seed)("commit", "-q", "-am", text);
  await git(seed)("push", "-q", "origin", "main");
}

test("the sync round warns about a fresh fall-behind, and keep-in-sync fast-forwards it", async () => {
  const { id, seed, work } = await tracked("sync");
  await pushUpstream(seed, "upstream one");

  const warned = capture();
  try {
    await runSyncCheckNow();
  } finally {
    warned.stop();
  }
  // The baseline is seeded from the PRE-fetch count, so a repo that was level and is now behind
  // warns on this very round — which is the whole point of the early-warning loop.
  const behind = warned.events.filter((e) => e.event === "repo_behind");
  expect(behind.length).toBe(1);
  expect((behind[0]!.payload as { repos: Array<{ id: string; behind: number }> }).repos.some((r) => r.id === id)).toBe(true);
  expect(getRepo(id)?.status?.behind).toBe(1);

  // With "keep in sync" on, the next round doesn't just warn — it takes the commits.
  await pushUpstream(seed, "upstream two");
  setKeepInSync(true);
  const synced = capture();
  try {
    await runSyncCheckNow();
  } finally {
    synced.stop();
    setKeepInSync(false); // opt-in, off by default — don't leak it into the rest of the suite
  }

  const pulled = synced.events.filter((e) => e.event === "repo_synced");
  expect(pulled.length).toBe(1);
  expect((pulled[0]!.payload as { repos: Array<{ id: string }> }).repos.some((r) => r.id === id)).toBe(true);
  expect(getRepo(id)?.status?.behind).toBe(0);
  expect((await $`git -C ${work} show HEAD:a.txt`.text()).trim()).toBe("upstream two");
  // Resolved repos are NOT also warned about — the warning is for what the owner must act on.
  expect(synced.events.some((e) => e.event === "repo_behind")).toBe(false);
}, REMOTE_ROUND_TIMEOUT_MS);

test("the auto-commit round commits an opted-in repo and leaves the tree clean", async () => {
  const dir = mkScratchDir("gm-round-ac-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(dir)("add", "-A");
  await git(dir)("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "one\nedited\n");
  writeFileSync(join(dir, "README.md"), "# docs\n");
  const id = mustUpsertRepo(dir, "round-autocommit", "auto", false);
  await refreshRepo(id, dir);
  // No AI provider configured → the deterministic heuristic planner IS the expected planner, so
  // this round is reproducible and never reaches the network.
  setAutoCommitConfig(noAiConfig());
  setRepoAutoCommit(id, true);

  try {
    const { done } = await runAutoCommitNow();
    const ours = done.find((d) => d.id === id);
    expect(ours).toBeDefined();
    expect(ours!.commits).toBeGreaterThan(0);
    // Unattended means the tree must end CLEAN — a partial commit would leave the next round
    // (and any pull) working around leftovers.
    expect((await $`git -C ${dir} status --porcelain`.text()).trim()).toBe("");
    expect((await $`git -C ${dir} log -1 --pretty=%s`.text()).trim().length).toBeGreaterThan(0);
  } finally {
    setRepoAutoCommit(id, false);
  }
});

test("the auto-commit round refuses a mid-operation repo instead of committing over it", async () => {
  const dir = mkScratchDir("gm-round-ac-midop-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(dir)("add", "-A");
  await git(dir)("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "half-merged\n");
  // The marker git itself leaves mid-merge. Committing here would bake someone's unresolved
  // merge into history, unattended, which is the one thing this gate exists to prevent.
  writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${"0".repeat(40)}\n`);
  const id = mustUpsertRepo(dir, "round-autocommit-midop", "auto", false);
  await refreshRepo(id, dir);
  setAutoCommitConfig(noAiConfig());
  setRepoAutoCommit(id, true);

  try {
    const { done, blocked } = await runAutoCommitNow();
    expect(done.some((d) => d.id === id)).toBe(false);
    expect(blocked.find((b) => b.id === id)?.reason).toBe("CONFLICT");
    // The working tree is exactly as it was — nothing staged, nothing committed.
    expect((await $`git -C ${dir} status --porcelain`.text())).toContain("a.txt");
    expect((await $`git -C ${dir} log --oneline`.text()).trim().split("\n").length).toBe(1);
  } finally {
    setRepoAutoCommit(id, false);
  }
});

test("with pull-first and push-after on, the round publishes what it committed", async () => {
  const { id, work, seed } = await tracked("acsync");
  writeFileSync(join(work, "local.txt"), "local work\n");
  await refreshRepo(id, work);
  setAutoCommitConfig(noAiConfig());
  setRepoAutoCommit(id, true);
  setAutoCommitPull(true);
  setAutoCommitPush(true);

  try {
    const { done } = await runAutoCommitNow();
    const ours = done.find((d) => d.id === id);
    expect(ours).toBeDefined();
    expect(ours!.commits).toBeGreaterThan(0);
    expect(ours!.pulled).toBe(true);
    expect(ours!.pushed).toBe(true);
    // It reached the remote. That is the whole point of pushAfter, and the part that looks fine
    // locally when it silently fails.
    await $`git -C ${seed} fetch -q origin`.quiet();
    expect(await $`git -C ${seed} ls-tree -r --name-only origin/main`.text()).toContain("local.txt");

    // Now the remote moves on without us and the tree is dirty again: committing puts us BOTH
    // ahead and behind, so the fast-forward pull can't land — and the push must not go anyway.
    // Publishing over a diverged remote unattended is exactly what the pull-first order prevents.
    await pushUpstream(seed, "upstream moved on");
    writeFileSync(join(work, "local.txt"), "more local work\n");
    await refreshRepo(id, work);

    const second = await runAutoCommitNow();
    const diverged = second.done.find((d) => d.id === id);
    expect(diverged).toBeDefined();
    expect(diverged!.commits).toBeGreaterThan(0); // the work is still committed, never dropped
    expect(diverged!.pulled).toBe(false);
    expect(diverged!.pushed).toBe(false);
    expect(diverged!.note).toBe("NON_FAST_FORWARD");
  } finally {
    setRepoAutoCommit(id, false);
    setAutoCommitPull(false);
    setAutoCommitPush(false);
  }
}, REMOTE_ROUND_TIMEOUT_MS);

test("a repo that opted out is never touched by the round", async () => {
  const dir = mkScratchDir("gm-round-optout-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(dir)("add", "-A");
  await git(dir)("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "dirty and staying that way\n");
  const id = mustUpsertRepo(dir, "round-optout", "auto", false);
  await refreshRepo(id, dir);
  setAutoCommitConfig(noAiConfig());

  const { done, blocked } = await runAutoCommitNow();
  expect(done.some((d) => d.id === id)).toBe(false);
  expect(blocked.some((b) => b.id === id)).toBe(false);
  expect((await $`git -C ${dir} status --porcelain`.text()).trim()).toContain("a.txt");
});
