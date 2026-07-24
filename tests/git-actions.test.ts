import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
