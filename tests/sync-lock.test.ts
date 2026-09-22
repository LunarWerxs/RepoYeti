import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

import { clearStaleIndexLock, classify } from "../src/git-actions/sync.ts";
import { NET_BLOCK_MS } from "../src/git.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout();

/** Backdate a file's mtime past the idle budget so clearStaleIndexLock regards it as a corpse. */
function backdate(p: string): void {
  const old = new Date(Date.now() - NET_BLOCK_MS - 5_000);
  utimesSync(p, old, old);
}

// A normal checkout: `.git/` is the gitdir, so the lock sits right there.
test("clears a stale index.lock in an ordinary checkout", () => {
  const dir = mkScratchDir("sync-lock-");
  mkdirSync(join(dir, ".git"), { recursive: true });
  const lock = join(dir, ".git", "index.lock");
  writeFileSync(lock, "");
  backdate(lock);

  clearStaleIndexLock(dir);
  expect(existsSync(lock)).toBe(false);
});

// A linked worktree (and a registered submodule) has `.git` as a FILE pointing at the real
// gitdir; the lock lives THERE. Joining onto the literal `.git` path used to miss it, so the
// corpse survived the kill and every later op failed with "index.lock exists".
test("clears the lock in a linked worktree, where .git is a file pointer", async () => {
  const base = mkScratchDir("sync-wt-");
  const main = join(base, "main");
  await $`git -c init.defaultBranch=main init -q ${main}`.quiet();
  await $`git -C ${main} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  const wt = join(base, "wt");
  await $`git -C ${main} worktree add -q -b wt ${wt} HEAD`.quiet();

  // The marker really is a pointer file, not a directory — the case the old code got wrong.
  expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/^gitdir:/);
  const gitDir = (await $`git -C ${wt} rev-parse --absolute-git-dir`.text()).trim();
  const lock = join(gitDir, "index.lock");
  writeFileSync(lock, "");
  backdate(lock);

  clearStaleIndexLock(wt);
  expect(existsSync(lock)).toBe(false);
});

// A lock younger than the budget may belong to a live concurrent writer; it must be left alone.
test("leaves a fresh index.lock alone", () => {
  const dir = mkScratchDir("sync-fresh-");
  mkdirSync(join(dir, ".git"), { recursive: true });
  const lock = join(dir, ".git", "index.lock");
  writeFileSync(lock, "");

  clearStaleIndexLock(dir);
  expect(existsSync(lock)).toBe(true);
});

// A clone runs with CLONE_TIMEOUT_MS (300s), so its timeout message must quote that budget —
// it used to hard-code NET_BLOCK_MS and told the owner "120s" after actually waiting 300s.
test("a clone timeout quotes the clone budget, not the ordinary network budget", () => {
  const err = new Error("block timeout");
  const clone = classify(err, { idleTimeoutMs: 300_000 });
  expect(clone.code).toBe("NETWORK_TIMEOUT");
  expect(clone.message).toContain("300s");
  // Callers that don't name a budget still get the ordinary one.
  expect(classify(err).message).toContain(`${Math.round(NET_BLOCK_MS / 1000)}s`);
});
