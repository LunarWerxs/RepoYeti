/**
 * The "Delete this file from disk" action (distinct from Discard): src/service/actions.ts
 * deleteFile(), backed by VcsBackend.deleteFile — gitDeleteFile (src/git-actions/commit.ts) here,
 * since these tests run against real git repos. Mirrors the discardFile suite in
 * branch-stash.test.ts, but asserts the DIFFERENT semantics: a tracked file's removal is staged
 * (git rm -f), not just restored/dropped like discard.
 *
 * The `recursive: true` folder-delete cases below are TRACK B's addition (see gitDeleteDirectory
 * in git-actions/commit.ts) — proving the opt-in default, the count reported back, and the three
 * guards that must hold even with recursive:true: repo root, `.git`/`.lore` marker dirs, and a
 * nested repository checkout.
 */
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { deleteFile } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

/** A git repo with one seed commit (so HEAD exists), on branch `main`. */
async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-delete-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

async function statusShort(dir: string): Promise<string> {
  return (await $`git -C ${dir} status --short`.quiet().text()).trim();
}

test("deleteFile removes a tracked file from disk AND stages the deletion", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-tracked", "auto", false);

  const r = await deleteFile(id, "seed.txt");
  expect(r.ok).toBe(true);
  expect(r.code).toBe("OK");
  expect(existsSync(join(dir, "seed.txt"))).toBe(false);
  // "D " (staged in the index column) proves it's staged, not merely a working-tree removal —
  // the exact distinction from discard, which never leaves a staged deletion behind.
  expect(await statusShort(dir)).toBe("D  seed.txt");
});

test("deleteFile removes a modified tracked file and stages the deletion despite local edits", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-modified", "auto", false);
  writeFileSync(join(dir, "seed.txt"), "locally edited\n");

  const r = await deleteFile(id, "seed.txt");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "seed.txt"))).toBe(false);
  expect(await statusShort(dir)).toBe("D  seed.txt");
});

test("deleteFile removes an untracked file outright (no staged deletion — nothing to stage)", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-untracked", "auto", false);
  writeFileSync(join(dir, "junk.txt"), "delete me\n");

  const r = await deleteFile(id, "junk.txt");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "junk.txt"))).toBe(false);
  expect(await statusShort(dir)).toBe("");
});

test("deleteFile removes a staged-but-uncommitted new file entirely (not in HEAD)", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-staged-add", "auto", false);
  writeFileSync(join(dir, "fresh.txt"), "brand new\n");
  await $`git -C ${dir} add fresh.txt`.quiet();
  expect(await statusShort(dir)).toBe("A  fresh.txt");

  const r = await deleteFile(id, "fresh.txt");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "fresh.txt"))).toBe(false);
  // Unstaged too — nothing committed to preserve, so there's nothing left to show as a change.
  expect(await statusShort(dir)).toBe("");
});

test("deleteFile refuses a directory", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-dir", "auto", false);
  mkdirSync(join(dir, "adir"));
  writeFileSync(join(dir, "adir", "f.txt"), "x\n");

  const r = await deleteFile(id, "adir");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
  expect(existsSync(join(dir, "adir", "f.txt"))).toBe(true);
});

test("deleteFile blocks path traversal and .git", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-guard", "auto", false);
  expect((await deleteFile(id, "../escape.txt")).code).toBe("ERROR");
  expect((await deleteFile(id, ".git/config")).code).toBe("ERROR");
});

// ── recursive folder delete (TRACK B) ─────────────────────────────────────────────────

test("deleteFile recursive:true removes a folder of tracked files, stages the removals, reports the count", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-tracked", "auto", false);
  mkdirSync(join(dir, "adir", "sub"), { recursive: true });
  writeFileSync(join(dir, "adir", "a.txt"), "a\n");
  writeFileSync(join(dir, "adir", "sub", "b.txt"), "b\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m "add adir"`.quiet();

  const r = await deleteFile(id, "adir", true);
  expect(r.ok).toBe(true);
  expect(r.code).toBe("OK");
  expect(r.deleted).toBe(2);
  expect(existsSync(join(dir, "adir"))).toBe(false);
  const status = (await statusShort(dir)).split("\n").sort();
  expect(status).toEqual(["D  adir/a.txt", "D  adir/sub/b.txt"]);
});

test("deleteFile recursive:true removes a folder mixing tracked + untracked, sweeping the untracked husk too", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-mixed", "auto", false);
  mkdirSync(join(dir, "mdir"), { recursive: true });
  writeFileSync(join(dir, "mdir", "tracked.txt"), "t\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m "add mdir"`.quiet();
  // Added AFTER the commit — `git rm -r` never touches this; only the disk-level sweep does.
  writeFileSync(join(dir, "mdir", "untracked.txt"), "u\n");

  const r = await deleteFile(id, "mdir", true);
  expect(r.ok).toBe(true);
  expect(r.deleted).toBe(2); // both files counted, not just the tracked one git rm staged
  expect(existsSync(join(dir, "mdir"))).toBe(false); // no husk left behind
  expect(await statusShort(dir)).toBe("D  mdir/tracked.txt");
});

test("deleteFile recursive:true removes a pure-untracked folder directly (git rm has nothing to stage)", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-untracked", "auto", false);
  mkdirSync(join(dir, "udir"), { recursive: true });
  writeFileSync(join(dir, "udir", "x.txt"), "x\n");
  writeFileSync(join(dir, "udir", "y.txt"), "y\n");

  const r = await deleteFile(id, "udir", true);
  expect(r.ok).toBe(true);
  expect(r.deleted).toBe(2);
  expect(existsSync(join(dir, "udir"))).toBe(false);
  expect(await statusShort(dir)).toBe(""); // nothing was ever tracked, so nothing to stage
});

test("deleteFile recursive:true on a FILE path behaves as the ordinary single-file delete", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-file", "auto", false);

  const r = await deleteFile(id, "seed.txt", true);
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "seed.txt"))).toBe(false);
  expect(await statusShort(dir)).toBe("D  seed.txt");
});

test("deleteFile refuses the repository root even with recursive:true", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-root", "auto", false);

  // Every spelling that collapses to the repo root must be refused, not just the literal ".".
  for (const spelling of [".", "./", "adir/.."]) {
    mkdirSync(join(dir, "adir"), { recursive: true }); // so "adir/.." resolves through a real dir
    const r = await deleteFile(id, spelling, true);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ERROR");
    expect(r.message).toMatch(/repository root/);
  }
  expect(existsSync(join(dir, "seed.txt"))).toBe(true); // checkout untouched
  expect(existsSync(join(dir, ".git"))).toBe(true);
});

test("deleteFile refuses a directory that is itself a nested repository checkout", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-nested", "auto", false);
  const nested = join(dir, "vendor", "lib");
  mkdirSync(nested, { recursive: true });
  await $`git -c init.defaultBranch=main init -q ${nested}`.quiet();
  writeFileSync(join(nested, "f.txt"), "x\n");

  const r = await deleteFile(id, "vendor/lib", true);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
  expect(r.message).toMatch(/nested repository/);
  expect(existsSync(join(nested, ".git"))).toBe(true); // nested checkout untouched
});

test("deleteFile recursive:true still blocks a path-traversal escape out of the repo", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-rec-escape", "auto", false);
  const r = await deleteFile(id, "../escape-dir", true);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
});

// ── nested repositories, at ANY depth ──
// A direct-child check was the first cut and an adversarial review broke it live: a vendored
// checkout two levels down passed the guard and was deleted along with its whole history
// (deleted:19, vendor-repo/.git gone). These pin the full-subtree walk that replaced it.
test("deleteFile refuses a folder holding a nested repo TWO levels down", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-nested-deep", "auto", false);
  mkdirSync(join(dir, "adir", "sub", "vendor-repo"), { recursive: true });
  writeFileSync(join(dir, "adir", "keep.txt"), "mine\n");
  mkdirSync(join(dir, "adir", "sub", "vendor-repo", ".git"), { recursive: true });
  writeFileSync(join(dir, "adir", "sub", "vendor-repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "adir", "sub", "vendor-repo", "src.ts"), "theirs\n");

  const r = await deleteFile(id, "adir", true);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
  expect(r.message).toContain("nested repository");
  // nothing was touched — the refusal happens before any mutation
  expect(existsSync(join(dir, "adir", "sub", "vendor-repo", ".git", "HEAD"))).toBe(true);
  expect(existsSync(join(dir, "adir", "keep.txt"))).toBe(true);
});

test("deleteFile refuses a folder holding a linked worktree's .git FILE", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-nested-file", "auto", false);
  mkdirSync(join(dir, "adir", "deep", "linked"), { recursive: true });
  // A linked worktree / submodule marks itself with a `.git` FILE, not a directory.
  writeFileSync(join(dir, "adir", "deep", "linked", ".git"), "gitdir: ../../../.git/worktrees/x\n");

  const r = await deleteFile(id, "adir", true);
  expect(r.ok).toBe(false);
  expect(r.message).toContain("nested repository");
  expect(existsSync(join(dir, "adir", "deep", "linked", ".git"))).toBe(true);
});

test("deleteFile still deletes an ordinary deep folder that holds no repo", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-deep-ok", "auto", false);
  mkdirSync(join(dir, "adir", "a", "b", "c"), { recursive: true });
  writeFileSync(join(dir, "adir", "a", "b", "c", "deep.txt"), "x\n");
  writeFileSync(join(dir, "adir", "top.txt"), "y\n");

  const r = await deleteFile(id, "adir", true);
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "adir"))).toBe(false);
});

// ── case-insensitive marker guard ────────────────────────────────────────────────
// The guard used to compare path segments against ".git" case-SENSITIVELY. On NTFS (and APFS)
// ".GIT" names the very same directory, so `deleteFile(id, ".GIT", true)` walked straight past
// the marker check, past findNestedRepo (which inspects .git's CHILDREN, never .git itself), and
// into an unconditional recursive rmSync of the entire repository history. These two cases are
// the proof it cannot happen again; they are meaningful on every platform because the guard now
// compares case-insensitively everywhere rather than deferring to the filesystem.
test("deleteFile refuses an oddly-cased .git, on any filesystem", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-uppercase-git", "auto", false);

  for (const spelling of [".GIT", ".Git", ".gIt"]) {
    const r = await deleteFile(id, spelling, true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("refusing to touch");
  }
  // The history is still there — which is the entire point of the guard.
  expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
});

test("deleteFile refuses a path REACHING INTO an oddly-cased .git", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "del-uppercase-git-child", "auto", false);

  const r = await deleteFile(id, ".GIT/hooks", true);
  expect(r.ok).toBe(false);
  expect(r.message).toContain("refusing to touch");
  expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
});
