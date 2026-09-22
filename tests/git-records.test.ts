import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { parseLogNumstatZ } from "../src/read/git-records.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// `git log -z --numstat` writes commit headers and numstat rows into ONE NUL-token stream; the
// decoder must tell them apart. The bug this pins: the header test used to be "does the token
// contain 0x1F (the unit separator in the pretty format)". A numstat row's PATH is raw bytes
// under -z, and a Unix path may contain 0x1F, so "2\t0\ta\x1fname.txt" was read as a new commit's
// header. Windows cannot create such a path (so this half is fed synthetically), but the shape is
// exactly what git emits.

const US = "\x1f";
/** The incoming reader's `--pretty` layout: %H %h %an %ae %at %P %D %s, joined by US. */
const header = (hash: string, subject: string): string =>
  [hash, hash.slice(0, 7), "T", "t@t.io", "1700000000", "", "", subject].join(US);

test("a numstat path containing 0x1F stays a row, not a commit header", () => {
  const commit = header("a".repeat(40), "touch a weird name");
  // header token carries the FIRST row after its newline; the second row is its own token.
  const out = `${commit}\n1\t0\ta.txt\0${"2\t0\ta\x1fname.txt"}\0\0`;

  const commits = parseLogNumstatZ(out);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.header).toBe(commit);
  expect(commits[0]?.records.map((r) => r.path)).toEqual(["a.txt", "a\x1fname.txt"]);
  expect(commits[0]?.records.map((r) => [r.added, r.removed])).toEqual([
    [1, 0],
    [2, 0],
  ]);
});

test("a rename whose new path contains 0x1F is claimed as the pair's path, not a header", () => {
  const first = header("b".repeat(40), "rename in");
  const second = header("c".repeat(40), "later");
  // Commit 1: a rename row ("0\t0\t", nothing after the second tab) then the two paths, the new
  // one carrying 0x1F. Commit 2 follows after the boundary. Before the fix the raw path token
  // matched the 0x1F header test, inventing a third commit and eating commit 2's row.
  const out = `${first}\n0\t0\t\0old.txt\0ne\x1fw.txt\0\0${second}\n3\t0\tnormal.txt\0\0`;

  const commits = parseLogNumstatZ(out);
  expect(commits.map((c) => c.header)).toEqual([first, second]);
  expect(commits[0]?.records).toEqual([
    { added: 0, removed: 0, binary: false, from: "old.txt", path: "ne\x1fw.txt" },
  ]);
  expect(commits[1]?.records.map((r) => r.path)).toEqual(["normal.txt"]);
});

test("real git log -z output decodes merges, empty commits and renames without inventing commits", async () => {
  const root = mkScratchDir("gm-git-records-");
  const repo = join(root, "r");
  mkdirSync(repo, { recursive: true }); // `git -C <dir> init` needs the directory to exist
  const g = (...a: string[]) =>
    $`git -C ${repo} -c user.name=T -c user.email=t@t.io ${a}`.quiet();

  await g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "x\n");
  writeFileSync(join(repo, "b.txt"), "y\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "base");
  await g("commit", "-q", "--allow-empty", "-m", "empty");
  await g("mv", "b.txt", "renamed.txt");
  await g("commit", "-q", "-m", "rename b");

  const fmt = ["%H", "%h", "%an", "%ae", "%at", "%P", "%D", "%s"].join(US);
  const out = await $`git -C ${repo} log -z --numstat --pretty=format:${fmt}`.text();

  const commits = parseLogNumstatZ(out);
  // base, empty, rename — newest first. The empty commit must NOT absorb the rename's rows.
  expect(commits.map((c) => c.header.split(US).at(-1))).toEqual(["rename b", "empty", "base"]);
  expect(commits[0]?.records).toEqual([
    { added: 0, removed: 0, binary: false, from: "b.txt", path: "renamed.txt" },
  ]);
  expect(commits[1]?.records).toEqual([]);
  expect(commits[2]?.records.map((r) => r.path).sort()).toEqual(["a.txt", "b.txt"]);
});
