import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";

import { isAbsolute, join, resolve } from "node:path";
import { $ } from "bun";
import { parsePorcelainV2, readStatus, resolveHistoryRefsHash } from "../src/read/status.ts";
import { currentGitOperation, gitFor } from "../src/git.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

async function gitRepo(prefix = "gm-status-"): Promise<string> {
  const dir = mkScratchDir(prefix);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("porcelain v2 parser keeps NUL-delimited paths and rename sources unambiguous", () => {
  const oid = "a".repeat(40);
  const raw = [
    `# branch.oid ${oid}`,
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +3 -2",
    `1 .M N... 100644 100644 100644 ${oid} ${oid} path with spaces.txt`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed\npath.txt`,
    "old path.txt",
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt`,
    "? untracked\nfile.txt",
    "",
  ].join("\0");

  expect(parsePorcelainV2(raw)).toEqual({
    branch: "main",
    detached: false,
    headOid: oid,
    upstream: "origin/main",
    ahead: 3,
    behind: 2,
    files: [
      { path: "path with spaces.txt", index: " ", working_dir: "M" },
      { path: "renamed\npath.txt", from: "old path.txt", index: "R", working_dir: " " },
      { path: "conflict.txt", index: "U", working_dir: "U" },
      { path: "untracked\nfile.txt", index: "?", working_dir: "?" },
    ],
  });
});

test("readStatus resolves the origin remote URL", async () => {
  const dir = await gitRepo();
  await $`git -C ${dir} remote add origin https://example.com/a.git`.quiet();

  const s = await readStatus(dir);

  expect(s.remote).toContain("example.com/a.git");
  expect(s.error).toBeNull();
});

test("readStatus changes HEAD identity when all visible status counters stay unchanged", async () => {
  const dir = await gitRepo("gm-status-head-");
  const before = await readStatus(dir);

  await $`git -C ${dir} -c user.name=External -c user.email=external@example.com commit -q --allow-empty -m external`.quiet();
  const after = await readStatus(dir);

  expect(before.headOid).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  expect(after.headOid).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  expect(after.headOid).not.toBe(before.headOid);
  expect({
    branch: after.branch,
    detached: after.detached,
    dirty: after.dirty,
    ahead: after.ahead,
    behind: after.behind,
  }).toEqual({
    branch: before.branch,
    detached: before.detached,
    dirty: before.dirty,
    ahead: before.ahead,
    behind: before.behind,
  });
});

test("readStatus changes worktree identity when the dirty count stays unchanged", async () => {
  const dir = await gitRepo("gm-status-worktree-");
  writeFileSync(join(dir, "first.txt"), "first\n");
  const first = await readStatus(dir);

  await $`git -C ${dir} clean -q -f -- first.txt`.quiet();
  writeFileSync(join(dir, "second.txt"), "second\n");
  const second = await readStatus(dir);

  expect(first.dirty).toBe(1);
  expect(second.dirty).toBe(1);
  expect(first.headOid).toBe(second.headOid);
  expect(first.worktreeStateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.worktreeStateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.worktreeStateHash).not.toBe(first.worktreeStateHash);
});

test("readStatus hashes staged blob identity on an unborn branch", async () => {
  const dir = mkScratchDir("gm-status-unborn-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  const path = join(dir, "new.txt");

  writeFileSync(path, "version one\n");
  await $`git -C ${dir} add new.txt`.quiet();
  const firstPorcelain = await $`git -C ${dir} status --porcelain=v1`.text();
  const first = await readStatus(dir);

  writeFileSync(path, "version two\n");
  await $`git -C ${dir} add new.txt`.quiet();
  const secondPorcelain = await $`git -C ${dir} status --porcelain=v1`.text();
  const second = await readStatus(dir);

  expect(first.error).toBeNull();
  expect(second.error).toBeNull();
  expect(first.headOid).toBeNull();
  expect(second.headOid).toBeNull();
  expect(secondPorcelain).toBe(firstPorcelain);
  expect(first.worktreeStateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.worktreeStateHash).not.toBe(first.worktreeStateHash);
});

test("readStatus produces a stable identity for an unmerged index", async () => {
  const dir = await gitRepo("gm-status-unmerged-");
  const path = join(dir, "conflict.txt");
  writeFileSync(path, "base\n");
  await $`git -C ${dir} add conflict.txt`.quiet();
  await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q -m base`.quiet();
  await $`git -C ${dir} checkout -q -b other`.quiet();
  writeFileSync(path, "theirs\n");
  await $`git -C ${dir} add conflict.txt`.quiet();
  await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q -m theirs`.quiet();
  await $`git -C ${dir} checkout -q main`.quiet();
  writeFileSync(path, "ours\n");
  await $`git -C ${dir} add conflict.txt`.quiet();
  await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q -m ours`.quiet();
  const merge = await $`git -C ${dir} merge other`.nothrow().quiet();
  expect(merge.exitCode).not.toBe(0);

  const first = await readStatus(dir);
  const second = await readStatus(dir);

  expect(first.error).toBeNull();
  expect(first.conflicted).toBe(true);
  expect(first.worktreeStateHash).toMatch(/^[0-9a-f]{64}$/);
  expect(second.worktreeStateHash).toBe(first.worktreeStateHash);
});

test("readStatus changes upstream identity when ahead/behind counts stay unchanged", async () => {
  const dir = await gitRepo("gm-status-upstream-");
  await $`git -C ${dir} remote add origin https://example.invalid/repo.git`.quiet();
  await $`git -C ${dir} config branch.main.remote origin`.quiet();
  await $`git -C ${dir} config branch.main.merge refs/heads/main`.quiet();

  await $`git -C ${dir} checkout -q -b upstream-one`.quiet();
  await $`git -C ${dir} -c user.name=Upstream -c user.email=u@example.com commit -q --allow-empty -m one`.quiet();
  const firstOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  await $`git -C ${dir} checkout -q main`.quiet();
  await $`git -C ${dir} branch -q -D upstream-one`.quiet();
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${firstOid}`.quiet();
  const first = await readStatus(dir);

  await $`git -C ${dir} checkout -q -b upstream-two`.quiet();
  await $`git -C ${dir} -c user.name=Upstream -c user.email=u@example.com commit -q --allow-empty -m two`.quiet();
  const secondOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  await $`git -C ${dir} checkout -q main`.quiet();
  await $`git -C ${dir} branch -q -D upstream-two`.quiet();
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${secondOid}`.quiet();
  const second = await readStatus(dir);

  expect(first.ahead).toBe(0);
  expect(first.behind).toBe(1);
  expect(second.ahead).toBe(first.ahead);
  expect(second.behind).toBe(first.behind);
  expect(second.upstreamOid).not.toBe(first.upstreamOid);
});

test("historyRefsHash tracks local, remote, tag, and same-OID symbolic-ref changes", async () => {
  const dir = await gitRepo("gm-status-history-refs-");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m second`.quiet();
  const oldOid = (await $`git -C ${dir} rev-parse HEAD~1`.text()).trim();
  const newOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  const readHash = (): Promise<string> => resolveHistoryRefsHash(gitFor(dir));
  let hash = await readHash();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);

  const changed = async (): Promise<void> => {
    const next = await readHash();
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(hash);
    hash = next;
  };

  await $`git -C ${dir} update-ref refs/heads/external ${oldOid}`.quiet();
  await changed();
  await $`git -C ${dir} update-ref refs/heads/external ${newOid}`.quiet();
  await changed();
  await $`git -C ${dir} update-ref -d refs/heads/external`.quiet();
  await changed();

  // This remote ref is deliberately not the current branch's upstream.
  await $`git -C ${dir} update-ref refs/remotes/elsewhere/topic ${oldOid}`.quiet();
  await changed();
  await $`git -C ${dir} update-ref -d refs/remotes/elsewhere/topic`.quiet();
  await changed();

  await $`git -C ${dir} update-ref refs/tags/releases/2026/alpha ${oldOid}`.quiet();
  await changed();
  await $`git -C ${dir} update-ref refs/tags/releases/2026/alpha ${newOid}`.quiet();
  await changed();
  await $`git -C ${dir} update-ref -d refs/tags/releases/2026/alpha`.quiet();
  await changed();

  // Both targets resolve to exactly the same commit. Only %(symref) can distinguish the move.
  await $`git -C ${dir} update-ref refs/remotes/origin/main ${newOid}`.quiet();
  await $`git -C ${dir} update-ref refs/remotes/origin/alternate ${newOid}`.quiet();
  await $`git -C ${dir} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.quiet();
  const beforeSymrefMove = await readHash();
  await $`git -C ${dir} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/alternate`.quiet();
  const afterSymrefMove = await readHash();

  expect(
    (await $`git -C ${dir} rev-parse refs/remotes/origin/HEAD`.text()).trim(),
  ).toBe(newOid);
  expect(beforeSymrefMove).not.toBe(afterSymrefMove);
});

test("historyRefsHash follows packed tag create, move, and delete", async () => {
  const dir = await gitRepo("gm-status-packed-tags-");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m second`.quiet();
  const oldOid = (await $`git -C ${dir} rev-parse HEAD~1`.text()).trim();
  const newOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  const readHash = (): Promise<string> => resolveHistoryRefsHash(gitFor(dir));
  const initial = await readHash();

  await $`git -C ${dir} update-ref refs/tags/packed-only ${oldOid}`.quiet();
  await $`git -C ${dir} pack-refs --all --prune`.quiet();
  const created = await readHash();

  await $`git -C ${dir} update-ref refs/tags/packed-only ${newOid}`.quiet();
  await $`git -C ${dir} pack-refs --all --prune`.quiet();
  const moved = await readHash();

  await $`git -C ${dir} update-ref -d refs/tags/packed-only`.quiet();
  await $`git -C ${dir} pack-refs --all --prune`.quiet();
  const deleted = await readHash();

  expect(created).not.toBe(initial);
  expect(moved).not.toBe(created);
  expect(deleted).not.toBe(moved);
});

test("readStatus re-resolves the remote after .git/config changes (cache invalidation)", async () => {
  const dir = await gitRepo("gm-status-cache-");
  await $`git -C ${dir} remote add origin https://example.com/a.git`.quiet();

  const s1 = await readStatus(dir); // caches the remote keyed on .git/config mtime+size
  expect(s1.remote).toContain("example.com/a.git");

  // A different-length URL changes config's size → cache key changes even when the
  // filesystem's mtime granularity is coarse, so this asserts invalidation, not luck.
  await $`git -C ${dir} remote set-url origin https://example.com/a-much-longer-remote-name.git`.quiet();

  const s2 = await readStatus(dir);
  expect(s2.remote).toContain("a-much-longer-remote-name.git");
});

test("readStatus reports operation markers from an ordinary .git directory", async () => {
  const dir = await gitRepo("gm-status-operation-");
  writeFileSync(join(dir, ".git", "MERGE_HEAD"), "0123456789012345678901234567890123456789\n");

  const status = await readStatus(dir);

  expect(status.error).toBeNull();
  expect(status.gitOperation).toBe("MERGE_HEAD");
});

test("currentGitOperation follows a linked worktree's .git pointer without a Git lookup", async () => {
  const main = await gitRepo("gm-status-main-");
  const worktree = mkScratchDir("gm-status-worktree-parent-");
  const checkout = join(worktree, "checkout");
  await $`git -C ${main} worktree add -q -b operation-test ${checkout}`.quiet();
  const rawGitDir = (
    await $`git -C ${checkout} rev-parse --git-dir`.quiet()
  ).stdout.toString().trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(checkout, rawGitDir);
  mkdirSync(join(gitDir, "rebase-merge"));

  expect(await currentGitOperation(checkout)).toBe("rebase-merge");
});
