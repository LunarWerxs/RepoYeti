// Integration tests for the working-tree half of AI conflict resolution
// (src/service/conflicts.ts), against a REAL merge conflict produced by real git.
//
// The pure engine is covered in tests/conflict-resolve.test.ts. What matters here is the part
// that only a real repo can prove: that the common-ancestor recovery actually works against
// git's index stages, and — the load-bearing one — that applying a resolution leaves the path
// UNMERGED. "The AI resolved it" and "the merge is done" have to stay two different states, or
// every downstream safety gate in the app (git's own commit refusal, src/auto-commit.ts's
// hasConflict) is reasoning about a repo that lied to it.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  applyConflictResolutions,
  conflictFileHash,
  listConflicts,
  readConflictFile,
} from "../src/service/conflicts.ts";
import { hasConflictMarkers } from "../src/ai/conflict-resolve.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

async function commitAll(dir: string, message: string): Promise<void> {
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} ${IDENT} commit -q -m ${message}`.quiet();
}

/**
 * A repo mid-merge with one genuinely conflicted file.
 *
 * `shared()` appears on BOTH sides on purpose: it is the line the audit's strongest check
 * (dropped-shared-lines) is about, so every fixture built here can exercise it.
 */
async function conflictedRepo(): Promise<{ dir: string; id: string; file: string }> {
  const dir = mkScratchDir("ry-conflict-");
  const file = "src/app.ts";
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config core.autocrlf false`.quiet();

  await Bun.write(join(dir, file), "top();\nshared();\nbase();\nbottom();\n");
  await commitAll(dir, "base");

  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, file), "top();\nshared();\ntheirs();\nbottom();\n");
  await commitAll(dir, "theirs");

  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, file), "top();\nshared();\nours();\nbottom();\n");
  await commitAll(dir, "ours");

  // Conflicts, so git exits non-zero — that IS the fixture, not a failure.
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();

  const id = mustUpsertRepo(dir, "conflict-fixture", "auto", false);
  return { dir, id, file };
}

test("listConflicts reports the unmerged path with its kind and marker count", async () => {
  const { id, file } = await conflictedRepo();
  const result = await listConflicts(id);
  expect(result.ok).toBe(true);

  const entry = result.files!.find((f) => f.path === file);
  expect(entry).toBeDefined();
  expect(entry!.kind).toBe("both-modified");
  expect(entry!.hunks).toBe(1);
  expect(entry!.unsupported).toBeUndefined();
});

test("listConflicts LISTS an unsupported conflict with its reason instead of hiding it", async () => {
  // A binary conflict can't be resolved here, but a file that silently vanished from the list
  // reads as a broken feature rather than an unsupported case.
  const dir = mkScratchDir("ry-conflict-bin-");
  const file = "logo.bin";
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await Bun.write(join(dir, file), new Uint8Array([0, 1, 2, 0, 3]));
  await commitAll(dir, "base");
  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, file), new Uint8Array([0, 9, 9, 0, 9]));
  await commitAll(dir, "theirs");
  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, file), new Uint8Array([0, 7, 7, 0, 7]));
  await commitAll(dir, "ours");
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();

  const id = mustUpsertRepo(dir, "binary-conflict", "auto", false);
  const entry = (await listConflicts(id)).files!.find((f) => f.path === file);
  expect(entry).toBeDefined();
  expect(entry!.unsupported).toBe("binary");
});

test("readConflictFile parses the file and recovers the common ancestor from the index stages", async () => {
  const { id, file } = await conflictedRepo();
  const read = await readConflictFile(id, file);
  expect(read.ok).toBe(true);
  expect(read.hunks).toHaveLength(1);

  const h = read.hunks![0]!;
  expect(h.oursText).toContain("ours();");
  expect(h.theirsText).toContain("theirs();");

  // The fixture uses git's DEFAULT conflictStyle, so the file on disk carries no `|||||||`
  // markers at all. Recovering `base();` proves the stage-1 reconstruction really ran — and it
  // is what lets the model tell an addition from a deletion.
  expect(read.hasBase).toBe(true);
  expect(h.baseText).toContain("base();");
  expect(read.hash).toBe(conflictFileHash(read.text!));
});

test("readConflictFile refuses a path that is not a resolvable conflict", async () => {
  const { id, dir } = await conflictedRepo();
  await Bun.write(join(dir, "clean.ts"), "no conflict here\n");
  const read = await readConflictFile(id, "clean.ts");
  expect(read.ok).toBe(false);
  expect(read.code).toBe("NOT_CONFLICTED");
});

test("applying a resolution resolves the TEXT but leaves the path UNMERGED and unstaged", async () => {
  // The invariant the whole feature rests on. If this ever regresses, an AI-resolved file would
  // look committable, and both git's own refusal and the auto-commit gate would be bypassed by
  // a merge no human necessarily reviewed.
  const { id, dir, file } = await conflictedRepo();
  const read = await readConflictFile(id, file);

  const applied = await applyConflictResolutions(id, file, read.hash!, [
    { index: 1, content: "shared();\nours();\ntheirs();" },
  ]);
  expect(applied.ok).toBe(true);
  expect(applied.applied).toBe(1);
  expect(applied.remaining).toBe(0);

  const onDisk = readFileSync(join(dir, file), "utf8");
  expect(hasConflictMarkers(onDisk)).toBe(false);
  expect(onDisk).toContain("ours();");
  expect(onDisk).toContain("theirs();");
  expect(onDisk).toContain("top();");
  expect(onDisk).toContain("bottom();");

  // Still unmerged in git's index ("UU"), because nothing here staged it.
  const status = await $`git -C ${dir} status --porcelain`.quiet().text();
  expect(status).toContain("UU");
  // And git still refuses the commit, which is the behaviour that actually protects the owner.
  const commit = await $`git -C ${dir} ${IDENT} commit -m nope`.quiet().nothrow();
  expect(commit.exitCode).not.toBe(0);
});

test("a partial apply leaves the untouched region's markers byte-for-byte intact", async () => {
  const dir = mkScratchDir("ry-conflict-multi-");
  const file = "multi.txt";
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config core.autocrlf false`.quiet();
  // Six unchanged lines between the two edits. With only one, git's merge sees a single
  // conflicting run and emits ONE region — the fixture has to separate them by more than the
  // diff context or there is no "second hunk" to leave alone.
  const gap = "m1\nm2\nm3\nm4\nm5\nm6\n";
  await Bun.write(join(dir, file), `a-base\n${gap}b-base\n`);
  await commitAll(dir, "base");
  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, file), `a-theirs\n${gap}b-theirs\n`);
  await commitAll(dir, "theirs");
  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, file), `a-ours\n${gap}b-ours\n`);
  await commitAll(dir, "ours");
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();

  const id = mustUpsertRepo(dir, "multi-conflict", "auto", false);
  const read = await readConflictFile(id, file);
  expect(read.hunks!.length).toBeGreaterThanOrEqual(2);
  const untouched = read.hunks![1]!.raw;

  const applied = await applyConflictResolutions(id, file, read.hash!, [{ index: 1, content: "a-merged" }]);
  expect(applied.ok).toBe(true);
  expect(applied.remaining).toBe(read.hunks!.length - 1);

  const onDisk = readFileSync(join(dir, file), "utf8");
  expect(onDisk).toContain("a-merged");
  expect(hasConflictMarkers(onDisk)).toBe(true);
  expect(onDisk).toContain(untouched); // the declined region is a true no-op
});

test("applying against a stale hash is refused rather than merged into unreviewed bytes", async () => {
  const { id, dir, file } = await conflictedRepo();
  const read = await readConflictFile(id, file);

  // Someone's editor saves between the proposal and the apply.
  writeFileSync(join(dir, file), `${read.text!}// touched by another editor\n`, "utf8");

  const applied = await applyConflictResolutions(id, file, read.hash!, [{ index: 1, content: "merged" }]);
  expect(applied.ok).toBe(false);
  expect(applied.code).toBe("CONFLICT_STALE");
  // And nothing was written: the file still holds its markers.
  expect(hasConflictMarkers(readFileSync(join(dir, file), "utf8"))).toBe(true);
});

test("a resolution that still contains conflict markers is refused at the service layer too", async () => {
  // Belt and braces: parseConflictResolution already refuses these, but apply accepts CLIENT
  // text (that's what makes hand-editing a proposal possible), so the check has to exist here
  // as well or the guarantee depends on the caller.
  const { id, dir, file } = await conflictedRepo();
  const read = await readConflictFile(id, file);
  const applied = await applyConflictResolutions(id, file, read.hash!, [
    { index: 1, content: `${"<".repeat(7)} HEAD\nours\n${"=".repeat(7)}\ntheirs\n${">".repeat(7)} feature` },
  ]);
  expect(applied.ok).toBe(false);
  expect(applied.code).toBe("NOT_CONFLICTED");
  expect(readFileSync(join(dir, file), "utf8")).toContain("ours();");
});

test("applying refuses a region index the file does not have, and a duplicated one", async () => {
  const { id, file } = await conflictedRepo();
  const read = await readConflictFile(id, file);

  const missing = await applyConflictResolutions(id, file, read.hash!, [{ index: 99, content: "x" }]);
  expect(missing.ok).toBe(false);
  expect(missing.code).toBe("NOT_CONFLICTED");

  const dup = await applyConflictResolutions(id, file, read.hash!, [
    { index: 1, content: "x" },
    { index: 1, content: "y" },
  ]);
  expect(dup.ok).toBe(false);
});

test("applying preserves CRLF line endings rather than normalising the file to LF", async () => {
  const dir = mkScratchDir("ry-conflict-crlf-");
  const file = "crlf.txt";
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config core.autocrlf false`.quiet();
  await Bun.write(join(dir, file), "top\r\nbase\r\nbottom\r\n");
  await commitAll(dir, "base");
  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, file), "top\r\ntheirs\r\nbottom\r\n");
  await commitAll(dir, "theirs");
  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, file), "top\r\nours\r\nbottom\r\n");
  await commitAll(dir, "ours");
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();

  const id = mustUpsertRepo(dir, "crlf-conflict", "auto", false);
  const read = await readConflictFile(id, file);
  const applied = await applyConflictResolutions(id, file, read.hash!, [{ index: 1, content: "ours\ntheirs" }]);
  expect(applied.ok).toBe(true);

  const onDisk = readFileSync(join(dir, file), "utf8");
  expect(onDisk).toContain("ours\r\ntheirs\r\n");
  expect(/[^\r]\n/.test(onDisk)).toBe(false); // no stray bare LF anywhere
});
