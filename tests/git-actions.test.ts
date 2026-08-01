import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { gitPullFfOnly, gitCommitAll } from "../src/git-actions.ts";
import {
  BLOCKED_GIT_ENV,
  currentGitOperation,
  gitFor,
  gitRawWithInput,
  safeGitEnv,
  sshCommandFor,
} from "../src/git.ts";
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

/**
 * Build a local repo that is exactly one commit behind its origin, where the upstream commit
 * touches ONLY `a.txt`. The local clone hasn't fetched yet, so the pull under test does the
 * fetch+fast-forward itself, exactly like the real flow.
 */
async function behindByOne(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "gm-pull-"));
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  await $`git -c init.defaultBranch=main init -q --bare ${origin}`.quiet();
  // Seed origin with a.txt + b.txt via a throwaway working clone.
  await $`git -c init.defaultBranch=main init -q ${seed}`.quiet();
  writeFileSync(join(seed, "a.txt"), "a0\n");
  writeFileSync(join(seed, "b.txt"), "b0\n");
  await $`git -C ${seed} add -A`.quiet();
  await $`git -C ${seed} -c user.name=Seed -c user.email=s@s.io commit -q -m seed`.quiet();
  await $`git -C ${seed} remote add origin ${origin}`.quiet();
  await $`git -C ${seed} push -q -u origin main`.quiet();
  // The repo under test clones origin AT the seed commit…
  await $`git -C ${base} clone -q ${origin} local`.quiet();
  // …then origin advances by one commit that touches only a.txt.
  writeFileSync(join(seed, "a.txt"), "a1\n");
  await $`git -C ${seed} add -A`.quiet();
  await $`git -C ${seed} -c user.name=Seed -c user.email=s@s.io commit -q -m upstream`.quiet();
  await $`git -C ${seed} push -q origin main`.quiet();
  return join(base, "local");
}

// Read a working-tree file, normalising EOLs (git checkout may apply core.autocrlf on Windows).
const readLf = (dir: string, f: string) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");

test("pull fast-forwards a dirty tree when the update doesn't touch the dirty files", async () => {
  const dir = await behindByOne();
  // Dirty an UNRELATED file (upstream changed a.txt; we edit b.txt) → the ff is safe.
  writeFileSync(join(dir, "b.txt"), "b-local\n");
  const r = await gitPullFfOnly(dir, ID);
  expect(r.ok).toBe(true);
  // The fast-forward landed (a.txt is now the upstream value) and the local edit survived.
  expect(readLf(dir, "a.txt")).toBe("a1\n");
  expect(readLf(dir, "b.txt")).toBe("b-local\n");
});

test("pull refuses only when the update would overwrite an uncommitted file", async () => {
  const dir = await behindByOne();
  // Dirty the SAME file the upstream commit changes → git can't ff without clobbering it.
  writeFileSync(join(dir, "a.txt"), "a-local\n");
  const r = await gitPullFfOnly(dir, ID);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("WOULD_OVERWRITE");
  // git aborted atomically — the working-tree edit is untouched.
  expect(readLf(dir, "a.txt")).toBe("a-local\n");
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

test("git environment strips ambient per-process config injection", () => {
  const names = [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_PARAMETERS",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "user.name";
  process.env.GIT_CONFIG_VALUE_0 = "Injected";
  process.env.GIT_CONFIG_PARAMETERS = "'user.email=injected@example.com'";
  try {
    const env = safeGitEnv();
    for (const name of names) expect(env[name]).toBeUndefined();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// Regression: an ambient GIT_ASKPASS (exported by VS Code, Claude Code and GitHub Desktop into
// every terminal they open) used to survive safeGitEnv(), and simple-git's guard then refused
// EVERY git call with `Use of "GIT_ASKPASS" is not permitted without enabling allowUnsafeAskPass`.
// The daemon worked from a plain shell and failed from an editor terminal. An empty string is the
// realistic value, and it trips the guard exactly like a real path does, so it is what we set.
test("git environment survives the ambient credential/editor vars that editors export", async () => {
  // GIT_ASKPASS is named literally, NOT just taken from BLOCKED_GIT_ENV: a test that only iterates
  // the list it is checking would pass again the moment someone deleted the entry that broke this.
  const names = [...new Set<string>(["GIT_ASKPASS", ...BLOCKED_GIT_ENV])];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "";
  try {
    const env = safeGitEnv();
    expect(env.GIT_ASKPASS).toBeUndefined();
    for (const name of names) expect(env[name]).toBeUndefined();
    // The assertion that actually reproduces the bug: constructing and running through gitFor().
    const version = await gitFor(join(import.meta.dir, "..")).raw(["--version"]);
    expect(version).toContain("git version");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ── git.ts: the repo-metadata lookup behind every status read ───────────────────────
// gitDirFor short-circuits the common `.git/` directory, so the layouts that DON'T take that
// path (a bare repo, a pointer whose target is gone) are the ones that can regress unnoticed.

test("a bare repository is resolved through the rev-parse fallback, then served from cache", async () => {
  const bare = mkdtempSync(join(tmpdir(), "gm-bare-"));
  await $`git -c init.defaultBranch=main init -q --bare ${bare}`.quiet();

  // No `.git` marker at all → the stat-based fast paths miss and git itself is asked.
  expect(await currentGitOperation(bare)).toBeNull();
  // Second call answers from the cached git dir; it must resolve to the same place, so a marker
  // that appeared in the meantime is still seen.
  mkdirSync(join(bare, "rebase-apply"));
  expect(await currentGitOperation(bare)).toBe("rebase-apply");
});

test("a .git pointer whose target is gone reports no operation instead of throwing", async () => {
  // What a deleted worktree leaves behind: the pointer file outlives the gitdir it names. A
  // status refresh must survive it — this runs on every repo in the list.
  const dir = mkdtempSync(join(tmpdir(), "gm-ptr-"));
  writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "gone").replace(/\\/g, "/")}\n`);

  expect(await currentGitOperation(dir)).toBeNull();
});

test("gitRawWithInput surfaces git's own stderr rather than an empty result", async () => {
  const notARepo = mkdtempSync(join(tmpdir(), "gm-stdin-"));
  await expect(gitRawWithInput(notARepo, ["diff-tree", "--stdin"], "\n")).rejects.toThrow(
    /not a git repository/i,
  );
});

test("a commit git refuses is classified, not thrown", async () => {
  // Nothing to amend yet: the failure comes back from git, through classify(), as a result.
  const dir = mkdtempSync(join(tmpdir(), "gm-amend-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "a\n");

  const r = await gitCommitAll(dir, ID, "amended", true);
  expect(r.ok).toBe(false);
  expect(r.message.toLowerCase()).toContain("amend");
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
