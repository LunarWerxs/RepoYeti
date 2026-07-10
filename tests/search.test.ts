import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { upsertRepo } from "../src/db.ts";
import { searchChangedContent } from "../src/service/index.ts";

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-search-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

async function commitAll(dir: string, msg: string): Promise<void> {
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m ${msg}`.quiet();
}

test("returns only CHANGED files whose content matches — clean files are never in the tree", async () => {
  const dir = await gitRepo();
  // A clean, committed file that DOES contain the needle — it must NOT come back, because
  // the changes tree (and thus this search) only ever covers changed files.
  writeFileSync(join(dir, "clean.ts"), "export const needleWord = 1;\n");
  writeFileSync(join(dir, "modified.ts"), "export const other = 1;\n");
  await commitAll(dir, "seed");
  // Now dirty the tree: a tracked modification + a brand-new untracked file, both with the needle.
  writeFileSync(join(dir, "modified.ts"), "export const other = 1;\n// needleWord lives here\n");
  writeFileSync(join(dir, "untracked.ts"), "const x = 'needleWord';\n");
  const id = upsertRepo(dir, "repo-search", "auto", false);

  const res = await searchChangedContent(id, "needleWord");

  expect(res.ok).toBe(true);
  const hits = new Set(res.paths);
  expect(hits.has("modified.ts")).toBe(true);
  expect(hits.has("untracked.ts")).toBe(true);
  expect(hits.has("clean.ts")).toBe(false);
});

test("is case-insensitive, and matches a tracked modification (not just untracked)", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.ts"), "const Foo = 1;\n");
  await commitAll(dir, "seed a"); // commit first, so the match below is a tracked modification
  writeFileSync(join(dir, "a.ts"), "const Foo = 'BarBaz';\n");
  const id = upsertRepo(dir, "repo-ci", "auto", false);

  const res = await searchChangedContent(id, "barbaz");

  expect(res.paths).toEqual(["a.ts"]);
});

test("treats the query as a literal string, not a regex", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "dot.ts"), "const re = a.b.c;\n");
  writeFileSync(join(dir, "nodot.ts"), "const re = axbxc;\n");
  const id = upsertRepo(dir, "repo-literal", "auto", false);

  const res = await searchChangedContent(id, "a.b.c");

  const hits = new Set(res.paths);
  expect(hits.has("dot.ts")).toBe(true);
  expect(hits.has("nodot.ts")).toBe(false); // '.' is literal under -F, so it can't match 'x'
});

test("skips binary files", async () => {
  const dir = await gitRepo();
  // "need\0le" — the needle bytes are present, but the NUL marks the file binary (-I skips it).
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c, 0x65]));
  const id = upsertRepo(dir, "repo-bin", "auto", false);

  const res = await searchChangedContent(id, "need");

  expect(res.paths).toEqual([]);
});

test("queries shorter than the threshold never touch git", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.ts"), "abcdef\n");
  const id = upsertRepo(dir, "repo-short", "auto", false);

  const res = await searchChangedContent(id, "ab");

  expect(res.ok).toBe(true);
  expect(res.paths).toEqual([]);
});

test("a no-match query yields an empty list", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "a.ts"), "nothing relevant here\n");
  const id = upsertRepo(dir, "repo-nomatch", "auto", false);

  const res = await searchChangedContent(id, "zzzzz");

  expect(res.ok).toBe(true);
  expect(res.paths).toEqual([]);
});

test("unknown repo id is NOT_FOUND", async () => {
  const res = await searchChangedContent("nope", "anything");

  expect(res.ok).toBe(false);
  expect(res.code).toBe("NOT_FOUND");
});
