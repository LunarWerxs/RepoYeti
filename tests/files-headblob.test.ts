import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { readFileContent } from "../src/service/index.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// Mirrors the MAX_FILE_BYTES constant in src/service/files.ts — the cap an oversized HEAD blob
// must be sliced to instead of buffered whole.
const MAX_FILE_BYTES = 2_000_000;

async function gitRepo(): Promise<string> {
  const dir = mkScratchDir("gm-headblob-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("caps an oversized HEAD blob without slicing after a full read", async () => {
  const dir = await gitRepo();
  // > MAX_FILE_BYTES so the head read must be truncated. A unique marker at the very start proves
  // we ship the prefix (and only the prefix), not whatever survived a full-buffer decode.
  const prefix = "HEAD-PREFIX-MARKER\n";
  const body = prefix + "x".repeat(MAX_FILE_BYTES + 500_000);
  writeFileSync(join(dir, "big.txt"), body);
  await $`git -C ${dir} add big.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m big`.quiet();
  const id = mustUpsertRepo(dir, "repo-headblob-big", "auto", false);

  const res = await readFileContent(id, "big.txt", "head");

  expect(res.ok).toBe(true);
  expect(res.ref).toBe("head");
  expect(res.truncated).toBe(true);
  expect(res.size).toBe(Buffer.byteLength(body, "utf8"));
  expect(res.content?.length).toBe(MAX_FILE_BYTES);
  expect(res.content?.startsWith(prefix)).toBe(true);
});

test("flags a binary HEAD blob instead of dumping its bytes", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));
  await $`git -C ${dir} add blob.bin`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m bin`.quiet();
  const id = mustUpsertRepo(dir, "repo-headblob-bin", "auto", false);

  const res = await readFileContent(id, "blob.bin", "head");

  expect(res.ok).toBe(true);
  expect(res.binary).toBe(true);
  expect(res.content).toBe("");
});

test("reads a normal HEAD blob verbatim", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "small.txt"), "committed body\n");
  await $`git -C ${dir} add small.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m small`.quiet();
  const id = mustUpsertRepo(dir, "repo-headblob-small", "auto", false);

  const res = await readFileContent(id, "small.txt", "head");

  expect(res.ok).toBe(true);
  expect(res.binary).toBe(false);
  expect(res.truncated).toBe(false);
  expect(res.content).toBe("committed body\n");
  expect(res.size).toBe(Buffer.byteLength("committed body\n", "utf8"));
});
