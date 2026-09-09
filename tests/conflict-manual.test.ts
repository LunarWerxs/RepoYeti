/**
 * The manual fallback under the AI conflict resolver (1.0 audit, item 25), against REAL merge
 * conflicts produced by real git.
 *
 * What only a real repo can prove, and what the audit is actually about: the conflicts the AI
 * path cannot touch at all. A binary file has no markers to parse and no text to read, and for a
 * delete/modify pair the side that deleted the path has no version of it anywhere in the working
 * tree - only the index knows. Both were listed with a reason and left completely inert. Taking a
 * side works for them because it copies out of git's index stages rather than reading the file,
 * and this suite is where that claim gets tested rather than asserted.
 *
 * The other load-bearing rule here is the one inherited from the AI path: choosing a side must
 * NOT stage. "I picked a side" and "the merge is finished" stay two different states, because
 * every downstream safety gate (git's own commit refusal, auto-commit.ts's hasConflict) reads
 * the index to decide whether this repo is safe to touch unattended.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  chooseConflictSide,
  listConflicts,
  stageResolvedConflict,
} from "../src/service/conflicts.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout(); // real git subprocesses

const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];

/**
 * A distinctly-valued blob with NUL bytes through it. The NUL is what makes the daemon (and git)
 * call the file binary at all, and it has to be in EVERY side: after a binary conflict git leaves
 * OUR version in the working tree, so a fixture whose "ours" side happened to be plain bytes
 * would classify as a text file with no markers instead of as the binary case being tested.
 */
function binaryBlob(fill: number): Uint8Array {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 4 === 0 ? 0 : fill;
  return bytes;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} ${IDENT} commit -q -m ${message}`.quiet();
}

/** Is this path still unmerged in the index? The question every assertion here really asks. */
async function unmerged(dir: string, path: string): Promise<boolean> {
  const out = await $`git -C ${dir} ls-files -u -- ${path}`.quiet().text();
  return out.trim().length > 0;
}

/**
 * A repo mid-merge with three conflicts at once, one per class the panel has to handle:
 * a text file (the AI path can take this one), a binary file (it cannot), and a path this side
 * deleted while the other modified it (nothing in the working tree expresses the deletion).
 */
async function conflictedRepo(): Promise<{ dir: string; id: string }> {
  const dir = mkScratchDir("ry-manual-conflict-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} config core.autocrlf false`.quiet();

  await Bun.write(join(dir, "src/app.ts"), "top();\nbase();\nbottom();\n");
  await Bun.write(join(dir, "assets/logo.bin"), binaryBlob(1));
  await Bun.write(join(dir, "docs/old.md"), "# base\n");
  await commitAll(dir, "base");

  await $`git -C ${dir} checkout -q -b feature`.quiet();
  await Bun.write(join(dir, "src/app.ts"), "top();\ntheirs();\nbottom();\n");
  await Bun.write(join(dir, "assets/logo.bin"), binaryBlob(9));
  await Bun.write(join(dir, "docs/old.md"), "# theirs edited this\n");
  await commitAll(dir, "theirs");

  await $`git -C ${dir} checkout -q main`.quiet();
  await Bun.write(join(dir, "src/app.ts"), "top();\nours();\nbottom();\n");
  await Bun.write(join(dir, "assets/logo.bin"), binaryBlob(7));
  await $`git -C ${dir} rm -q -- docs/old.md`.quiet(); // we delete, they modify
  await commitAll(dir, "ours");

  // Conflicts, so git exits non-zero. That IS the fixture.
  await $`git -C ${dir} ${IDENT} merge feature`.quiet().nothrow();

  const id = mustUpsertRepo(dir, "manual-conflict-fixture", "auto", false);
  return { dir, id };
}

test("the panel lists all three conflict classes, and two of them the AI path cannot touch", async () => {
  const { id } = await conflictedRepo();
  const result = await listConflicts(id);
  expect(result.ok).toBe(true);

  const byPath = new Map(result.files!.map((f) => [f.path, f]));
  expect(byPath.get("src/app.ts")!.unsupported).toBeUndefined();
  expect(byPath.get("assets/logo.bin")!.unsupported).toBe("binary");
  // Deleted by us, modified by them. MEASURED, not assumed: git leaves THEIR version in the
  // working tree for a modify/delete pair, so the file exists and simply has no markers in it.
  // That still meant no action of any kind before item 25, and it is still the case that the
  // only thing that can express "keep the deletion" is the index, which has no stage 2 here.
  expect(byPath.get("docs/old.md")!.unsupported).toBe("no-markers");
});

test("keeping our side writes our content and leaves the path unmerged", async () => {
  const { dir, id } = await conflictedRepo();

  const result = await chooseConflictSide(id, "src/app.ts", "ours");
  expect(result.ok).toBe(true);
  expect(result.result).toBe("written");
  expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe("top();\nours();\nbottom();\n");

  // THE rule: picking a side is not finishing the merge. git must still refuse to commit, and
  // auto-commit's conflict gate must still skip this repo.
  expect(await unmerged(dir, "src/app.ts")).toBe(true);
});

test("keeping their side works on a BINARY conflict, which has no text path at all", async () => {
  const { dir, id } = await conflictedRepo();

  const result = await chooseConflictSide(id, "assets/logo.bin", "theirs");
  expect(result.ok).toBe(true);
  expect(result.result).toBe("written");
  // Byte-for-byte theirs. Copying out of the index stage is why this works where every
  // marker-parsing path fails.
  expect([...readFileSync(join(dir, "assets/logo.bin"))]).toEqual([...binaryBlob(9)]);
  expect(await unmerged(dir, "assets/logo.bin")).toBe(true);
});

test("on a delete/modify conflict, keeping our side removes the file rather than failing", async () => {
  const { dir, id } = await conflictedRepo();
  // We deleted it, so "ours" has no index stage. Keeping our side means the deletion stands.
  const result = await chooseConflictSide(id, "docs/old.md", "ours");
  expect(result.ok).toBe(true);
  expect(result.result).toBe("deleted");
  expect(existsSync(join(dir, "docs/old.md"))).toBe(false);
  expect(await unmerged(dir, "docs/old.md")).toBe(true);
});

test("on a delete/modify conflict, keeping their side restores the file they edited", async () => {
  const { dir, id } = await conflictedRepo();
  const result = await chooseConflictSide(id, "docs/old.md", "theirs");
  expect(result.ok).toBe(true);
  expect(result.result).toBe("written");
  expect(readFileSync(join(dir, "docs/old.md"), "utf8")).toBe("# theirs edited this\n");
});

test("choosing a side on a path that is not conflicted is refused, not silently applied", async () => {
  const { dir, id } = await conflictedRepo();
  await Bun.write(join(dir, "untouched.txt"), "hello\n");

  const result = await chooseConflictSide(id, "untouched.txt", "ours");
  expect(result.ok).toBe(false);
  expect(result.code).toBe("NOT_CONFLICTED");
  // The file it refused to act on is exactly as it was.
  expect(readFileSync(join(dir, "untouched.txt"), "utf8")).toBe("hello\n");
});

test("choosing a side refuses to escape the repository", async () => {
  const { id } = await conflictedRepo();
  const escaped = await chooseConflictSide(id, "../../outside.txt", "ours");
  expect(escaped.ok).toBe(false);

  const dotGit = await chooseConflictSide(id, ".git/config", "theirs");
  expect(dotGit.ok).toBe(false);
});

test("staging is refused while the file still contains conflict markers", async () => {
  const { dir, id } = await conflictedRepo();
  // Untouched: still exactly as git left it, markers and all.
  const refused = await stageResolvedConflict(id, "src/app.ts");
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("CONFLICT_MARKERS_PRESENT");
  expect(refused.remaining).toBe(1);
  // Nothing was staged: the merge is exactly as unfinished as it was.
  expect(await unmerged(dir, "src/app.ts")).toBe(true);
});

test("staging succeeds once the markers are gone, and that is what finishes the merge", async () => {
  const { dir, id } = await conflictedRepo();
  await chooseConflictSide(id, "src/app.ts", "theirs");

  const staged = await stageResolvedConflict(id, "src/app.ts");
  expect(staged.ok).toBe(true);
  // Only now is the path resolved in the index. This is the explicit second step, and the
  // reason picking a side deliberately stops short of it.
  expect(await unmerged(dir, "src/app.ts")).toBe(false);
});

test("a deletion the owner kept can be staged, even though there is no file to read", async () => {
  const { dir, id } = await conflictedRepo();
  await chooseConflictSide(id, "docs/old.md", "ours");

  const staged = await stageResolvedConflict(id, "docs/old.md");
  expect(staged.ok).toBe(true);
  expect(await unmerged(dir, "docs/old.md")).toBe(false);
  expect(existsSync(join(dir, "docs/old.md"))).toBe(false);
});

test("a binary conflict can be taken all the way to resolved", async () => {
  const { dir, id } = await conflictedRepo();
  await chooseConflictSide(id, "assets/logo.bin", "ours");
  // No markers can exist in a binary file, and the marker check must not block on one it cannot
  // read: this is the whole point of the fallback, so it has to reach the end.
  const staged = await stageResolvedConflict(id, "assets/logo.bin");
  expect(staged.ok).toBe(true);
  expect(await unmerged(dir, "assets/logo.bin")).toBe(false);
  expect([...readFileSync(join(dir, "assets/logo.bin"))]).toEqual([...binaryBlob(7)]);
});
