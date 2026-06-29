import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  gitPullFfOnly,
  gitPush,
  gitCommitAll,
  gitCreateBranch,
  gitDeleteBranch,
} from "../src/git-actions.ts";
import type { Identity } from "../src/db.ts";

// Closes the audit's P0 test gaps: the DETACHED_HEAD guards (5 actions guard it, none were
// tested) and the push error contract (NON_FAST_FORWARD / NO_REMOTE).

const ID: Identity = { id: "x", displayName: "T", gitUsername: "Tester", gitEmail: "t@test.io", sshKeyPath: null };

/** A repo with two commits on `main` (so HEAD~1 exists to detach onto). */
async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-err-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a1\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m c1`.quiet();
  writeFileSync(join(dir, "a.txt"), "a2\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m c2`.quiet();
  return dir;
}

// ── detached HEAD ────────────────────────────────────────────────────────────────

test("every mutating action refuses a detached HEAD with DETACHED_HEAD", async () => {
  const dir = await repo();
  await $`git -C ${dir} checkout -q HEAD~1`.quiet(); // detach

  expect((await gitPullFfOnly(dir, ID)).code).toBe("DETACHED_HEAD");
  expect((await gitPush(dir, ID)).code).toBe("DETACHED_HEAD");
  // commit needs a dirty tree to reach the detached guard (clean → NOTHING_TO_COMMIT first).
  writeFileSync(join(dir, "a.txt"), "dirty\n");
  expect((await gitCommitAll(dir, ID, "x")).code).toBe("DETACHED_HEAD");
  expect((await gitCreateBranch(dir, "feature", false)).code).toBe("DETACHED_HEAD");
  expect((await gitDeleteBranch(dir, "main")).code).toBe("PROTECTED_BRANCH"); // protected wins
});

// ── push error contract ──────────────────────────────────────────────────────────

test("gitPush returns NO_REMOTE when there is no configured remote", async () => {
  const dir = await repo();
  const r = await gitPush(dir, ID);
  expect(r.ok).toBe(false);
  // No upstream/remote configured → classify() maps to NO_REMOTE or NO_UPSTREAM.
  expect(["NO_REMOTE", "NO_UPSTREAM"]).toContain(r.code);
});

test("gitPush returns NON_FAST_FORWARD when the remote has diverged", async () => {
  const base = mkdtempSync(join(tmpdir(), "gm-err-base-"));
  const bare = join(base, "remote.git");
  await $`git init -q --bare ${bare}`.quiet();

  // Two clones of the same bare remote.
  const c1 = join(base, "c1");
  const c2 = join(base, "c2");
  await $`git clone -q ${bare} ${c1}`.quiet();
  await $`git -C ${c1} config user.name A`.quiet();
  await $`git -C ${c1} config user.email a@a.io`.quiet();
  writeFileSync(join(c1, "f.txt"), "1\n");
  await $`git -C ${c1} add -A`.quiet();
  await $`git -C ${c1} commit -q -m first`.quiet();
  await $`git -C ${c1} push -q origin HEAD:main`.quiet();

  await $`git clone -q ${bare} ${c2}`.quiet();
  await $`git -C ${c2} config user.name B`.quiet();
  await $`git -C ${c2} config user.email b@b.io`.quiet();
  await $`git -C ${c2} checkout -q -B main origin/main`.quiet();

  // c1 advances the remote; c2 (still on the old tip) commits and tries to push → non-FF.
  writeFileSync(join(c1, "f.txt"), "2\n");
  await $`git -C ${c1} commit -q -am second`.quiet();
  await $`git -C ${c1} push -q origin HEAD:main`.quiet();

  writeFileSync(join(c2, "g.txt"), "x\n");
  await $`git -C ${c2} add -A`.quiet();
  await $`git -C ${c2} commit -q -m diverge`.quiet();

  const r = await gitPush(c2, ID);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NON_FAST_FORWARD");
});
