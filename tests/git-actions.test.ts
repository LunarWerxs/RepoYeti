import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { gitPullFfOnly, gitCommitAll } from "../src/git-actions.ts";
import { safeGitEnv, sshCommandFor } from "../src/git.ts";
import type { Identity } from "../src/db.ts";

const ID: Identity = {
  id: "x",
  displayName: "T",
  gitUsername: "Tester",
  gitEmail: "t@test.io",
  sshKeyPath: null,
};

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-act-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("pull refuses a dirty working tree (never half-merges)", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "x.txt"), "dirty");
  const r = await gitPullFfOnly(dir, ID);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("DIRTY_WORKING_TREE");
});

test("commit refuses a clean tree", async () => {
  const dir = await repo();
  const r = await gitCommitAll(dir, ID, "noop");
  expect(r.code).toBe("NOTHING_TO_COMMIT");
});

test("commit stages all, attributes to the identity, and never mutates repo config", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "hello");
  const r = await gitCommitAll(dir, ID, "add a");
  expect(r.ok).toBe(true);

  const author = (await $`git -C ${dir} log -1 ${"--format=%an <%ae>"}`.text()).trim();
  expect(author).toBe("Tester <t@test.io>");

  // identity was injected per-operation, NOT persisted to the repo config
  const localName = (await $`git -C ${dir} config --local user.name`.nothrow().text()).trim();
  expect(localName).toBe("");

  // tree is clean again after the commit
  const porcelain = (await $`git -C ${dir} status --porcelain`.text()).trim();
  expect(porcelain).toBe("");
});

test("git environment strips ambient pager settings", () => {
  const oldPager = process.env.PAGER;
  const oldGitPager = process.env.GIT_PAGER;
  process.env.PAGER = "cat";
  process.env.GIT_PAGER = "cat";
  try {
    const env = safeGitEnv();
    expect(env.PAGER).toBeUndefined();
    expect(env.GIT_PAGER).toBeUndefined();
  } finally {
    if (oldPager === undefined) delete process.env.PAGER;
    else process.env.PAGER = oldPager;
    if (oldGitPager === undefined) delete process.env.GIT_PAGER;
    else process.env.GIT_PAGER = oldGitPager;
  }
});

test("sshCommandFor validates and quotes identity key paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-key-"));
  const key = join(dir, "id key");
  writeFileSync(key, "not-a-real-key");

  const cmd = sshCommandFor(key);
  expect(cmd).toContain(`-i "${key.replace(/\\/g, "/")}"`);
  expect(cmd).toContain("-o IdentitiesOnly=yes");
  expect(() => sshCommandFor(`${key}" -o ProxyCommand=bad`)).toThrow(/unsupported/);
  expect(() => sshCommandFor(join(dir, "missing"))).toThrow(/not a file/);
});
