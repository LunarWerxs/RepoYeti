/**
 * addToGitignore (src/service/actions.ts) — the changes-tree "Add to .gitignore" action.
 * Covers: appends an anchored pattern, is idempotent (already-ignored → no-op), confines the path
 * to the repo, and preserves any existing .gitignore content.
 */
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { addToGitignore } from "../src/service/index.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

async function gitRepo(name: string): Promise<{ dir: string; id: string }> {
  const dir = mkScratchDir(`gm-gitignore-${name}-`);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config user.name Seed`.quiet();
  await $`git -C ${dir} config user.email s@s.io`.quiet();
  writeFileSync(join(dir, "a.txt"), "a0\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
  return { dir, id: mustUpsertRepo(dir, name, "auto", false) };
}

test("addToGitignore appends an anchored pattern and is idempotent", async () => {
  const { dir, id } = await gitRepo("append");
  const gi = join(dir, ".gitignore");

  const r1 = await addToGitignore(id, "build/output.log");
  expect(r1.ok).toBe(true);
  expect(r1.code).toBe("OK");
  expect(r1.pattern).toBe("/build/output.log");
  expect(r1.alreadyIgnored).toBe(false);
  expect(readFileSync(gi, "utf8")).toBe("/build/output.log\n");

  // Adding the same path again is a no-op (alreadyIgnored), not a duplicate line.
  const r2 = await addToGitignore(id, "build/output.log");
  expect(r2.ok).toBe(true);
  expect(r2.alreadyIgnored).toBe(true);
  expect(readFileSync(gi, "utf8")).toBe("/build/output.log\n");
});

test("addToGitignore preserves existing content and guarantees a separating newline", async () => {
  const { dir, id } = await gitRepo("preserve");
  const gi = join(dir, ".gitignore");
  writeFileSync(gi, "node_modules\n*.tmp"); // no trailing newline on the last line

  const r = await addToGitignore(id, "secret.env");
  expect(r.ok).toBe(true);
  expect(readFileSync(gi, "utf8")).toBe("node_modules\n*.tmp\n/secret.env\n");
});

test("addToGitignore refuses a path that escapes the repo", async () => {
  const { id } = await gitRepo("escape");
  const r = await addToGitignore(id, "../../etc/passwd");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("ERROR");
});

test("addToGitignore treats a bare existing entry as already-ignored", async () => {
  const { dir, id } = await gitRepo("bare");
  const gi = join(dir, ".gitignore");
  writeFileSync(gi, "dist\n"); // bare (un-anchored) entry

  const r = await addToGitignore(id, "dist");
  expect(r.ok).toBe(true);
  expect(r.alreadyIgnored).toBe(true);
  expect(existsSync(gi)).toBe(true);
  expect(readFileSync(gi, "utf8")).toBe("dist\n"); // unchanged — no duplicate
});

// The forms below all mean "this path is ignored" to git, and none of them is string-equal to the
// `/path` pattern we would write. Matching lines by hand missed every one, so re-ignoring an
// already-listed folder silently appended a near-duplicate.
test("addToGitignore recognises the directory, nested and glob forms git actually honours", async () => {
  const { dir, id } = await gitRepo("forms");
  const gi = join(dir, ".gitignore");
  writeFileSync(gi, "build/\n/vendor/\nlogs/*.log\n");
  // The paths have to EXIST: a `dir/` pattern only matches something git can see is a directory,
  // so `check-ignore` on a name with nothing behind it correctly answers "not ignored". Every row
  // the UI offers this action on is on disk, so existing is the honest fixture.
  mkdirSync(join(dir, "build", "out"), { recursive: true });
  mkdirSync(join(dir, "vendor"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "build", "out", "app.js"), "x\n");
  writeFileSync(join(dir, "logs", "debug.log"), "x\n");

  // `build/` — the conventional directory spelling, equal to neither `/build` nor `build`.
  const r1 = await addToGitignore(id, "build");
  expect(r1.alreadyIgnored).toBe(true);
  // `/vendor/` — anchored AND directory-suffixed.
  const r2 = await addToGitignore(id, "vendor");
  expect(r2.alreadyIgnored).toBe(true);
  // Covered by a glob rather than by its own line.
  const r3 = await addToGitignore(id, "logs/debug.log");
  expect(r3.alreadyIgnored).toBe(true);
  // A path INSIDE an ignored directory is already ignored too — no line of its own is needed.
  const r4 = await addToGitignore(id, "build/out/app.js");
  expect(r4.alreadyIgnored).toBe(true);

  expect(readFileSync(gi, "utf8")).toBe("build/\n/vendor/\nlogs/*.log\n"); // untouched throughout
});

// git consults .gitignore only for UNTRACKED paths, so ignoring a tracked one writes a line that
// changes nothing. It has to say so — reporting a plain success for a visibly-inert action is how
// "I clicked it and the file is still there" happens.
test("addToGitignore reports a tracked path as still tracked", async () => {
  const { dir, id } = await gitRepo("tracked");
  const gi = join(dir, ".gitignore");

  // a.txt is committed by the fixture, so it is in the index.
  const r = await addToGitignore(id, "a.txt");
  expect(r.ok).toBe(true);
  expect(r.alreadyIgnored).toBe(false);
  expect(r.stillTracked).toBe(true);
  expect(readFileSync(gi, "utf8")).toBe("/a.txt\n"); // the line IS written — only inert

  // An untracked sibling is the normal case and must NOT carry the warning.
  writeFileSync(join(dir, "scratch.tmp"), "x\n");
  const r2 = await addToGitignore(id, "scratch.tmp");
  expect(r2.ok).toBe(true);
  expect(r2.stillTracked).toBe(false);
});

// A directory whose contents are TRACKED is the case that actually bit, and the reason the ignored
// check passes --no-index: plain `git check-ignore` lets the index win and answers "not ignored"
// for a folder that is plainly listed, so every right-click appended another near-duplicate line.
test("addToGitignore does not duplicate a listed folder whose contents are tracked", async () => {
  const { dir, id } = await gitRepo("tracked-dir");
  const gi = join(dir, ".gitignore");
  mkdirSync(join(dir, "site"), { recursive: true });
  writeFileSync(join(dir, "site", "index.html"), "<p>x\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m site`.quiet();
  writeFileSync(gi, "/site/\n");

  const r = await addToGitignore(id, "site");
  expect(r.ok).toBe(true);
  expect(r.alreadyIgnored).toBe(true);
  expect(r.stillTracked).toBe(true); // listed, but the index still wins — say so
  expect(readFileSync(gi, "utf8")).toBe("/site/\n"); // no `/site` duplicate appended
});
