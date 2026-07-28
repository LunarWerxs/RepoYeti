import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { readChanges, readStatus } from "../src/read/status.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// Conflict Concierge: readChanges must surface WHICH kind of unmerged pair a "C" file is in
// (ConflictKind), and must mark a since-resolved path with `resolved: true` rather than letting
// it silently fall back to a plain M/A/D letter once `git add` clears the unmerged pair. Verified
// against a real git binary (merge, rebase, and cherry-pick all write `.git/MERGE_MSG`'s
// `# Conflicts:` block identically — see src/read/status.ts's conflictedPathsFromMergeMsg doc).

async function git(dir: string, ...args: string[]): Promise<void> {
  await $`git -C ${dir} ${args}`.quiet();
}

async function initRepo(dir: string): Promise<void> {
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await git(dir, "-c", "user.name=Seed", "-c", "user.email=s@s.io", "commit", "--allow-empty", "-q", "-m", "root");
  await git(dir, "config", "user.name", "Seed");
  await git(dir, "config", "user.email", "s@s.io");
}

/** Both branches edit the same line of the same file differently → a content (UU) conflict when
 *  merged, which is also the shape a conflicting `git rebase`/`git cherry-pick` produces. */
async function seedContentConflict(dir: string): Promise<void> {
  await initRepo(dir);
  writeFileSync(join(dir, "f.txt"), "base\n");
  await git(dir, "add", "f.txt");
  await git(dir, "commit", "-qm", "base");
  await git(dir, "checkout", "-qb", "feature");
  writeFileSync(join(dir, "f.txt"), "feature\n");
  await git(dir, "commit", "-qam", "feature-change");
  await git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "f.txt"), "main\n");
  await git(dir, "commit", "-qam", "main-change");
}

test("readChanges tags a live content conflict as both-modified and status C", async () => {
  const dir = mkScratchDir("gm-conflict-merge-");
  await seedContentConflict(dir);
  await $`git -C ${dir} merge feature -m merge-feature`.quiet().nothrow();

  const files = await readChanges(dir);
  const f = files.find((x) => x.path === "f.txt");
  expect(f?.status).toBe("C");
  expect(f?.conflict).toBe("both-modified");
  expect(f?.resolved).toBeUndefined();
});

test("readChanges marks a resolved merge conflict resolved:true, keeps a normal staged letter", async () => {
  const dir = mkScratchDir("gm-conflict-merge-resolve-");
  await seedContentConflict(dir);
  await $`git -C ${dir} merge feature -m merge-feature`.quiet().nothrow();

  // Resolve by hand (what the app's conflict UI does on the owner's behalf) and stage it.
  writeFileSync(join(dir, "f.txt"), "resolved\n");
  await git(dir, "add", "f.txt");

  const files = await readChanges(dir);
  const f = files.find((x) => x.path === "f.txt");
  expect(f?.status).toBe("M"); // status letter space is unchanged — still a plain staged M
  expect(f?.conflict).toBeUndefined(); // no longer unmerged
  expect(f?.resolved).toBe(true); // but was conflicted in THIS in-progress merge
});

test("readChanges tags both-added (AA) conflicts correctly", async () => {
  const dir = mkScratchDir("gm-conflict-aa-");
  await initRepo(dir);
  await git(dir, "checkout", "-qb", "feature");
  writeFileSync(join(dir, "new.txt"), "from-feature\n");
  await git(dir, "add", "new.txt");
  await git(dir, "commit", "-qm", "add-feature");
  await git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "new.txt"), "from-main\n");
  await git(dir, "add", "new.txt");
  await git(dir, "commit", "-qm", "add-main");
  await $`git -C ${dir} merge feature -m merge-feature`.quiet().nothrow();

  const files = await readChanges(dir);
  const f = files.find((x) => x.path === "new.txt");
  expect(f?.status).toBe("C");
  expect(f?.conflict).toBe("both-added");
});

test("readChanges marks a resolved conflict during an in-progress rebase", async () => {
  const dir = mkScratchDir("gm-conflict-rebase-");
  await seedContentConflict(dir);
  await git(dir, "checkout", "-q", "feature");
  await $`git -C ${dir} rebase main`.quiet().nothrow();

  const conflicted = await readChanges(dir);
  expect(conflicted.find((x) => x.path === "f.txt")?.conflict).toBe("both-modified");

  writeFileSync(join(dir, "f.txt"), "rebase-resolved\n");
  await git(dir, "add", "f.txt");

  const files = await readChanges(dir);
  const f = files.find((x) => x.path === "f.txt");
  expect(f?.conflict).toBeUndefined();
  expect(f?.resolved).toBe(true);
});

test("readChanges marks a resolved conflict during an in-progress cherry-pick", async () => {
  const dir = mkScratchDir("gm-conflict-cherry-");
  await seedContentConflict(dir);
  const featureOid = (await $`git -C ${dir} rev-parse feature`.quiet().text()).trim();
  await git(dir, "checkout", "-q", "main");
  await $`git -C ${dir} cherry-pick ${featureOid}`.quiet().nothrow();

  const conflicted = await readChanges(dir);
  expect(conflicted.find((x) => x.path === "f.txt")?.conflict).toBe("both-modified");

  writeFileSync(join(dir, "f.txt"), "cherry-resolved\n");
  await git(dir, "add", "f.txt");

  const files = await readChanges(dir);
  const f = files.find((x) => x.path === "f.txt");
  expect(f?.conflict).toBeUndefined();
  expect(f?.resolved).toBe(true);
});

test("worktreeStateHash changes when a conflict is resolved, so the UI actually refreshes", async () => {
  const dir = mkScratchDir("gm-conflict-hash-");
  await seedContentConflict(dir);
  await $`git -C ${dir} merge feature -m merge-feature`.quiet().nothrow();

  const before = await readStatus(dir);
  writeFileSync(join(dir, "f.txt"), "resolved\n");
  await git(dir, "add", "f.txt");
  const after = await readStatus(dir);

  expect(before.worktreeStateHash).not.toBeNull();
  expect(after.worktreeStateHash).not.toBeNull();
  expect(after.worktreeStateHash).not.toBe(before.worktreeStateHash);
});

test("readChanges does not mark an unrelated staged file resolved during an in-progress merge", async () => {
  const dir = mkScratchDir("gm-conflict-unrelated-");
  await seedContentConflict(dir);
  await $`git -C ${dir} merge feature -m merge-feature`.quiet().nothrow();

  // An ordinary edit dropped in alongside the conflict, staged like any normal change — never
  // part of MERGE_MSG's conflict set, so it must never read as "resolved".
  writeFileSync(join(dir, "other.txt"), "unrelated\n");
  await git(dir, "add", "other.txt");

  const files = await readChanges(dir);
  const other = files.find((x) => x.path === "other.txt");
  expect(other?.status).toBe("A");
  expect(other?.resolved).toBeUndefined();
  expect(other?.conflict).toBeUndefined();
});
