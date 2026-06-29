import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { watchRepo } from "../src/watcher.ts";

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-watch-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  return dir;
}

test("watchRepo reports healthy when the .git directory can be watched", async () => {
  const dir = await gitRepo();
  const h = watchRepo(dir, () => {});
  try {
    expect(h.watching).toBe(true);
  } finally {
    h.close();
  }
});

test("watchRepo reports unhealthy when there is no .git to watch", () => {
  const bare = mkdtempSync(join(tmpdir(), "gm-watch-bare-")); // plain dir, no .git
  const h = watchRepo(bare, () => {});
  try {
    expect(h.watching).toBe(false);
  } finally {
    h.close();
  }
});
