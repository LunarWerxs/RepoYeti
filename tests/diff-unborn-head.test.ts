/**
 * Regression coverage for the unborn-HEAD + staged-changes blind spot.
 *
 * On a fresh `git init` with zero commits, the documented "just start committing" flow is create
 * files → `git add .` → ✨ Generate message. `git diff HEAD` fails ("ambiguous argument 'HEAD'",
 * exit 128, stderr discarded), plain `git diff` is index↔worktree (empty, because the staged
 * content equals the worktree), and `git ls-files --others` no longer lists the staged files — so
 * every collector returned "(no textual diff)" while the file list showed the added files, and the
 * provider was asked to write messages for content it never saw. See src/git-actions/diff.ts's
 * boundedDiff() fallback chain for the fix (`git diff --cached` as the last base).
 */
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { collectCommitDiff, collectPathsDiff, collectCommitPlanInput } from "../src/git-actions/diff.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

/** A freshly `git init`ed repo with NO commits — HEAD is unborn. */
async function unbornRepo(): Promise<string> {
  const dir = mkScratchDir("gm-diff-unborn-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  return dir;
}

/** `# diff --git a/<path> b/` chunk headers actually present in a collected diff string. */
function chunkPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!);
}

test("collectCommitDiff carries STAGED content in a repo with no commits yet", async () => {
  const dir = await unbornRepo();
  writeFileSync(join(dir, "first.ts"), "export const first = 1;\n");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "second.ts"), "export function second() { return 2; }\n");
  // The trigger: everything is staged before the first commit.
  await $`git -C ${dir} add .`.quiet();

  // Sanity-check the root cause is real: with HEAD unborn, `git diff HEAD` fails AND the default
  // `git diff` is empty (index == worktree), so neither of the two old bases saw anything — while
  // the staged files are invisible to `ls-files --others` too.
  expect((await $`git -C ${dir} diff HEAD`.nothrow().quiet()).exitCode).not.toBe(0);
  expect((await $`git -C ${dir} diff`.quiet().text()).trim()).toBe("");
  expect((await $`git -C ${dir} ls-files --others --exclude-standard`.quiet().text()).trim()).toBe("");

  const msg = await collectCommitDiff(dir);
  const diffSection = msg.split("# git diff\n")[1] ?? "";
  expect(chunkPaths(diffSection).sort()).toEqual(["first.ts", "nested/second.ts"].sort());
  expect(diffSection).toContain("+export const first = 1;");
  expect(diffSection).toContain("+export function second() { return 2; }");
});

test("collectPathsDiff carries staged content in a repo with no commits yet", async () => {
  const dir = await unbornRepo();
  writeFileSync(join(dir, "included.ts"), "export const included = true;\n");
  writeFileSync(join(dir, "excluded.ts"), "export const excluded = true;\n");
  await $`git -C ${dir} add .`.quiet();

  const scoped = await collectPathsDiff(dir, ["included.ts"]);
  const diffSection = scoped.split("# git diff\n")[1] ?? "";
  expect(chunkPaths(diffSection)).toEqual(["included.ts"]);
  expect(diffSection).toContain("+export const included = true;");
  expect(diffSection).not.toContain("excluded");
});

test("collectCommitPlanInput carries staged content in a repo with no commits yet", async () => {
  const dir = await unbornRepo();
  writeFileSync(join(dir, "widget.ts"), "export function widget() { return 42; }\n");
  await $`git -C ${dir} add .`.quiet();

  const plan = await collectCommitPlanInput(dir);
  expect(plan.files.map((f) => f.path)).toEqual(["widget.ts"]);
  expect(chunkPaths(plan.diff)).toEqual(["widget.ts"]);
  expect(plan.diff).toContain("+export function widget() { return 42; }");
});
