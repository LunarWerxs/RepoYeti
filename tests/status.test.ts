import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { readStatus } from "../src/read/status.ts";

async function gitRepo(prefix = "gm-status-"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("readStatus resolves the origin remote URL", async () => {
  const dir = await gitRepo();
  await $`git -C ${dir} remote add origin https://example.com/a.git`.quiet();

  const s = await readStatus(dir);

  expect(s.remote).toContain("example.com/a.git");
  expect(s.error).toBeNull();
});

test("readStatus re-resolves the remote after .git/config changes (cache invalidation)", async () => {
  const dir = await gitRepo("gm-status-cache-");
  await $`git -C ${dir} remote add origin https://example.com/a.git`.quiet();

  const s1 = await readStatus(dir); // caches the remote keyed on .git/config mtime+size
  expect(s1.remote).toContain("example.com/a.git");

  // A different-length URL changes config's size → cache key changes even when the
  // filesystem's mtime granularity is coarse, so this asserts invalidation, not luck.
  await $`git -C ${dir} remote set-url origin https://example.com/a-much-longer-remote-name.git`.quiet();

  const s2 = await readStatus(dir);
  expect(s2.remote).toContain("a-much-longer-remote-name.git");
});
