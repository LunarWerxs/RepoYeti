import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { computeDiffStats } from "../src/read/diffstat.ts";
import { readChanges } from "../src/read/status.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

test("computeDiffStats keys non-ASCII paths the way porcelain reports them", async () => {
  // git's default core.quotePath=true renders `héllo.txt` as `+++ "b/h\303\251llo.txt"`, which the
  // patch header could not decode — the perFile key became `h/303/251llo.txt` and attachDiffStats's
  // per-file delta silently vanished. The diff must force core.quotePath=false so the header is the
  // literal UTF-8 path that matches the porcelain status.
  const dir = mkScratchDir("gm-diffstat-nonascii-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  const rel = "héllo.txt";
  writeFileSync(join(dir, rel), "one\ntwo\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  writeFileSync(join(dir, rel), "one\nTWO\nthree\n");

  const { perFile } = await computeDiffStats(dir, []);
  expect(perFile.has(rel)).toBe(true);
  expect(perFile.get(rel)).toEqual({
    addedLines: 2,
    removedLines: 1,
    addedChars: 8, // paired "two"→"TWO" (3) + unpaired "three" (5)
    removedChars: 3,
  });

  // And the key lines up with the porcelain path, which is the whole point: readChanges attaches
  // the per-file stat by looking the status path up in this map.
  const withStats = await readChanges(dir, true);
  expect(withStats.find((f) => f.path === rel)?.stat).toBeDefined();
});
