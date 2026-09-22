// Regression for #F013: unlinkConfinedFile skipped every symlink leaf, because the guard tested
// `lstatSync(abs).isFile()` — always false for a symlink — so Discard/Delete of an untracked
// symlink returned ok() without touching the link, and the entry could never be removed.
import { test, expect } from "bun:test";
import { existsSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { discardFile, deleteFile } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

/** A git repo with one seed commit (so HEAD exists), on branch `main`. */
async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-unlink-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

// Windows may refuse symlink creation without developer mode / elevation; the defect (and the
// fix) only exist where a symlink can be created, so skip informatively rather than fail there.
function makeSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

test("discardFile unlinks an untracked symlink (and never follows/removes its target)", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "disc-symlink", "auto", false);
  writeFileSync(join(dir, "outside.txt"), "target\n");
  const link = join(dir, "link");
  if (!makeSymlink(join(dir, "outside.txt"), link)) return; // no symlink support here

  const r = await discardFile(id, "link");
  expect(r.ok).toBe(true);
  expect(existsSync(link)).toBe(false);
  // The link itself is gone, but its target file must survive.
  expect(existsSync(join(dir, "outside.txt"))).toBe(true);
});

test("deleteFile unlinks an untracked dangling symlink", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-symlink", "auto", false);
  const link = join(dir, "dangling");
  if (!makeSymlink(join(dir, "does-not-exist.txt"), link)) return; // no symlink support here

  // A dangling link: existsSync() is already false, so only lstat tells us the leaf is there.
  expect(existsSync(link)).toBe(false);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);

  const r = await deleteFile(id, "dangling");
  expect(r.ok).toBe(true);
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
});
