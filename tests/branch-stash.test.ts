import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitStashSave,
  gitStashPop,
  gitStashDrop,
  isValidBranchName,
} from "../src/git-actions.ts";
import { readBranches, readLog, readStashes } from "../src/read/inspect.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { discardFile } from "../src/service/index.ts";
import type { Identity } from "../src/db.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const ID: Identity = {
  id: "x",
  displayName: "T",
  gitUsername: "Tester",
  gitEmail: "t@test.io",
  sshKeyPath: null,
};

/** A git repo with one seed commit (so HEAD exists), on branch `main`. */
async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-branch-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

// ── branch name validation ──────────────────────────────────────────────────────

test("isValidBranchName accepts normal names and rejects dangerous ones", () => {
  expect(isValidBranchName("feature/x")).toBe(true);
  expect(isValidBranchName("fix-123")).toBe(true);
  expect(isValidBranchName("")).toBe(false);
  expect(isValidBranchName("has space")).toBe(false);
  expect(isValidBranchName("bad..dots")).toBe(false);
  expect(isValidBranchName("-leadingdash")).toBe(false);
  expect(isValidBranchName(".hidden")).toBe(false);
  expect(isValidBranchName("ends.lock")).toBe(false);
  expect(isValidBranchName("a~b")).toBe(false);
  expect(isValidBranchName("a:b")).toBe(false);
});

// ── create / list / switch / delete ─────────────────────────────────────────────

test("create branch (no switch) lists it without leaving the current branch", async () => {
  const dir = await repo();
  const r = await gitCreateBranch(dir, "feature/a", false);
  expect(r.ok).toBe(true);

  const list = await readBranches(dir);
  expect(list.ok).toBe(true);
  expect(list.current).toBe("main");
  expect(list.branches.map((b) => b.name).sort()).toEqual(["feature/a", "main"]);
});

test("create-and-switch moves HEAD to the new branch", async () => {
  const dir = await repo();
  const r = await gitCreateBranch(dir, "feature/b", true);
  expect(r.ok).toBe(true);
  expect((await readBranches(dir)).current).toBe("feature/b");
});

test("create branch rejects a duplicate name and an invalid name", async () => {
  const dir = await repo();
  await gitCreateBranch(dir, "dup", false);
  expect((await gitCreateBranch(dir, "dup", false)).code).toBe("BRANCH_EXISTS");
  expect((await gitCreateBranch(dir, "bad name", false)).code).toBe("INVALID_REF_NAME");
});

test("checkout switches branches on a clean tree", async () => {
  const dir = await repo();
  await gitCreateBranch(dir, "other", false);
  const r = await gitCheckout(dir, "other");
  expect(r.ok).toBe(true);
  expect((await readBranches(dir)).current).toBe("other");
});

test("checkout carries a non-conflicting dirty tree onto the target branch", async () => {
  const dir = await repo();
  await gitCreateBranch(dir, "other", false); // "other" sits at the same commit as main
  writeFileSync(join(dir, "seed.txt"), "modified\n"); // dirty, but both branches share this HEAD
  const r = await gitCheckout(dir, "other");
  expect(r.ok).toBe(true);
  expect((await readBranches(dir)).current).toBe("other");
  // the uncommitted edit came along instead of being refused
  expect(readFileSync(join(dir, "seed.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("modified\n");
});

test("checkout refuses only when the switch would overwrite a dirty file", async () => {
  const dir = await repo();
  // Give "other" a DIFFERENT seed.txt than main, so switching to it must rewrite that file.
  await gitCreateBranch(dir, "other", true); // now on "other"
  writeFileSync(join(dir, "seed.txt"), "on-other\n");
  await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q -am on-other`.quiet();
  await gitCheckout(dir, "main"); // back to a clean main (seed.txt = "seed\n")
  // Dirty main's seed.txt, then try to switch to "other" whose seed.txt differs → must overwrite.
  writeFileSync(join(dir, "seed.txt"), "dirty-main\n");
  const r = await gitCheckout(dir, "other");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("WOULD_OVERWRITE");
});

test("checkout of a missing branch returns NOT_FOUND", async () => {
  const dir = await repo();
  expect((await gitCheckout(dir, "nope")).code).toBe("NOT_FOUND");
});

test("delete branch: refuses current, protected, and unmerged; allows a merged branch", async () => {
  const dir = await repo();
  // can't delete the branch you're on
  expect((await gitDeleteBranch(dir, "main")).code).toBe("PROTECTED_BRANCH");

  await gitCreateBranch(dir, "merged", false); // points at HEAD → fully merged
  const del = await gitDeleteBranch(dir, "merged");
  expect(del.ok).toBe(true);
  expect((await readBranches(dir)).branches.map((b) => b.name)).not.toContain("merged");

  // an unmerged branch (has a commit not on main) refuses safe-delete
  await gitCreateBranch(dir, "feature/unmerged", true);
  writeFileSync(join(dir, "f.txt"), "x\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m work`.quiet();
  await gitCheckout(dir, "main");
  expect((await gitDeleteBranch(dir, "feature/unmerged")).code).toBe("UNMERGED_BRANCH");
});

test("delete refuses deleting the currently checked-out (non-protected) branch", async () => {
  const dir = await repo();
  await gitCreateBranch(dir, "wip", true); // now ON wip
  expect((await gitDeleteBranch(dir, "wip")).code).toBe("CANNOT_DELETE_CURRENT");
});

// ── log ─────────────────────────────────────────────────────────────────────────

test("readLog returns commits newest-first with author + subject", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "two.txt"), "2\n");
  await $`git -C ${dir} -c user.name=Bob -c user.email=b@b.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=Bob -c user.email=b@b.io commit -q -m second`.quiet();

  const log = await readLog(dir, 10, 0);
  expect(log.ok).toBe(true);
  expect(log.commits.length).toBe(2);
  expect(log.commits[0]!.subject).toBe("second");
  expect(log.commits[0]!.authorName).toBe("Bob");
  expect(log.commits[1]!.subject).toBe("init");
  expect(log.commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
  expect(log.commits[0]!.date).toBeGreaterThan(0);
});

test("readLog paginates with skip and reports hasMore", async () => {
  const dir = await repo();
  for (let i = 0; i < 3; i++) {
    await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m ${`c${i}`}`.quiet();
  }
  const page1 = await readLog(dir, 2, 0);
  expect(page1.commits.length).toBe(2);
  expect(page1.hasMore).toBe(true);
  const page2 = await readLog(dir, 2, 2);
  expect(page2.commits.length).toBe(2); // c0 + init
  expect(page2.hasMore).toBe(true);
});

// ── stash ─────────────────────────────────────────────────────────────────────────

test("stash save refuses a clean tree, then saves a dirty one (incl. untracked)", async () => {
  const dir = await repo();
  expect((await gitStashSave(dir, ID)).code).toBe("NOTHING_TO_STASH");

  writeFileSync(join(dir, "seed.txt"), "edited\n");
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  const r = await gitStashSave(dir, ID, "wip");
  expect(r.ok).toBe(true);

  // tree is clean again (untracked file was included)
  const porcelain = (await $`git -C ${dir} status --porcelain`.text()).trim();
  expect(porcelain).toBe("");
  const list = await readStashes(dir);
  expect(list.stashes.length).toBe(1);
  expect(list.stashes[0]!.index).toBe(0);
  expect(list.stashes[0]!.message).toContain("wip");
});

test("stash pop restores changes onto a clean tree and removes the entry", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "seed.txt"), "edited\n");
  await gitStashSave(dir, ID);
  expect((await readStashes(dir)).stashes.length).toBe(1);

  const pop = await gitStashPop(dir, 0);
  expect(pop.ok).toBe(true);
  expect((await readStashes(dir)).stashes.length).toBe(0);
  // normalise CRLF: this Windows box may have core.autocrlf on
  expect((await Bun.file(join(dir, "seed.txt")).text()).replace(/\r/g, "")).toBe("edited\n");
});

test("stash pop refuses a dirty tree and reports an empty stash", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "seed.txt"), "edited\n");
  expect((await gitStashPop(dir, 0)).code).toBe("DIRTY_WORKING_TREE");
  // clean tree, but nothing stashed
  await $`git -C ${dir} checkout -- seed.txt`.quiet();
  expect((await gitStashPop(dir, 0)).code).toBe("STASH_EMPTY");
});

test("stash drop removes an entry and reports empty afterwards", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "seed.txt"), "edited\n");
  await gitStashSave(dir, ID);
  expect((await gitStashDrop(dir, 0)).ok).toBe(true);
  expect((await gitStashDrop(dir, 0)).code).toBe("STASH_EMPTY");
});

test("a stash pop that conflicts keeps the entry and says so", async () => {
  const dir = await repo();
  // The unhappy ending of the stash → pull → pop escape hatch: while the change was stashed the
  // same file moved underneath it, so the apply can't land cleanly.
  writeFileSync(join(dir, "seed.txt"), "stashed\n");
  await gitStashSave(dir, ID);
  writeFileSync(join(dir, "seed.txt"), "incoming\n");
  await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q -am incoming`.quiet();

  const pop = await gitStashPop(dir, 0);
  expect(pop.ok).toBe(false);
  expect(pop.code).toBe("STASH_CONFLICT");
  // git only drops a stash on a CLEAN apply, so nothing was lost — and the message must say
  // that, because "conflict" alone reads like the work is gone.
  expect(pop.message).toContain("the stash was kept");
  expect((await readStashes(dir)).stashes.length).toBe(1);
});

test("a stash that git itself refuses is classified, not thrown", async () => {
  // No initial commit yet: there is a dirty tree to stash, but nothing to stash it against.
  const dir = mkScratchDir("gm-branch-unborn-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "new.txt"), "untracked\n");

  const r = await gitStashSave(dir, ID);
  expect(r.ok).toBe(false);
  expect(r.message.toLowerCase()).toContain("initial commit");
});

test("dropping a stash somewhere that isn't a repo is classified, not thrown", async () => {
  const r = await gitStashDrop(mkScratchDir("gm-branch-norepo-"), 0);
  expect(r.ok).toBe(false);
  expect(r.code).not.toBe("STASH_EMPTY"); // the entry isn't missing — the repo is
});

test("deleting a branch that was never there returns NOT_FOUND", async () => {
  const dir = await repo();
  const r = await gitDeleteBranch(dir, "never-existed");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NOT_FOUND");
});

// ── discard (service layer, needs the repo in the DB) ───────────────────────────────

test("discardFile restores a modified tracked file to HEAD", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "disc-mod", "auto", false);
  writeFileSync(join(dir, "seed.txt"), "garbage\n");

  const r = await discardFile(id, "seed.txt");
  expect(r.ok).toBe(true);
  expect((await Bun.file(join(dir, "seed.txt")).text()).replace(/\r/g, "")).toBe("seed\n");
});

test("discardFile removes an untracked file", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "disc-new", "auto", false);
  writeFileSync(join(dir, "junk.txt"), "delete me\n");

  const r = await discardFile(id, "junk.txt");
  expect(r.ok).toBe(true);
  expect(existsSync(join(dir, "junk.txt"))).toBe(false);
});

test("discardFile blocks path traversal and .git", async () => {
  const dir = await repo();
  const id = mustUpsertRepo(dir, "disc-guard", "auto", false);
  expect((await discardFile(id, "../escape.txt")).code).toBe("ERROR");
  expect((await discardFile(id, ".git/config")).code).toBe("ERROR");
});
