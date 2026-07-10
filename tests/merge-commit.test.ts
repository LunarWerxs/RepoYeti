import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readLog, readCommit } from "../src/read/inspect.ts";

/** A repo whose history contains a real merge commit:
 *    init → (feature: c-feat) ┐
 *    init → (main:    c-main) ┴─ merge (--no-ff)
 *  Returns the dir. HEAD is the merge commit (2 parents). */
async function repoWithMerge(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-merge-"));
  const git = (...a: string[]) => $`git -C ${dir} -c user.name=T -c user.email=t@t.io ${a}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  // feature branch with its own commit
  await git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "feat.txt"), "feat\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c-feat");
  // diverge main
  await git("checkout", "-q", "main");
  writeFileSync(join(dir, "main.txt"), "main\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "c-main");
  // force a merge commit (never fast-forward)
  await git("merge", "--no-ff", "-m", "merge feature", "feature");
  return dir;
}

test("readLog flags the merge commit (isMerge + 2 parents) and leaves normal commits single-parent", async () => {
  const dir = await repoWithMerge();
  const r = await readLog(dir, 50, 0);
  expect(r.ok).toBe(true);
  const merge = r.commits.find((c) => c.subject === "merge feature");
  expect(merge).toBeDefined();
  expect(merge!.isMerge).toBe(true);
  expect(merge!.parents.length).toBe(2);

  const normal = r.commits.find((c) => c.subject === "c-main");
  expect(normal!.isMerge).toBe(false);
  expect(normal!.parents.length).toBe(1);

  // the root commit has no parents
  const root = r.commits.find((c) => c.subject === "init");
  expect(root!.parents.length).toBe(0);
  expect(root!.isMerge).toBe(false);
});

test("readLog merges filter: 'only' returns just merges, 'exclude' drops them", async () => {
  const dir = await repoWithMerge();
  const only = await readLog(dir, 50, 0, "only");
  expect(only.commits.length).toBe(1);
  expect(only.commits[0]!.isMerge).toBe(true);

  const excluded = await readLog(dir, 50, 0, "exclude");
  expect(excluded.commits.every((c) => !c.isMerge)).toBe(true);
  expect(excluded.commits.some((c) => c.subject === "merge feature")).toBe(false);
});

test("readCommit carries parents + isMerge for a merge commit", async () => {
  const dir = await repoWithMerge();
  const log = await readLog(dir, 5, 0, "only");
  const mergeHash = log.commits[0]!.hash;
  const detail = await readCommit(dir, mergeHash);
  expect(detail.ok).toBe(true);
  expect(detail.isMerge).toBe(true);
  expect(detail.parents.length).toBe(2);
});
