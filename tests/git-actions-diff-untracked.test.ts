/**
 * Root-cause regression coverage for the "AI commit message only describes the first file" bug:
 * `git diff HEAD` is tracked-only BY DEFINITION, so every new/untracked file used to reach the
 * collectors as a bare `?? name` status line with zero diff content — the model could only write
 * about whichever ONE file happened to already be tracked. See src/git-actions/diff.ts's
 * untrackedDiffs()/listUntrackedFiles() for the fix (a `git diff --no-index` chunk per new file,
 * appended to the raw diff BEFORE per-file folding so it gets the same fairness as tracked files).
 */
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";

import { join } from "node:path";
import { $ } from "bun";
import { collectCommitDiff, collectPathsDiff, collectCommitPlanInput } from "../src/git-actions/diff.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

async function repo(): Promise<string> {
  const dir = mkScratchDir("gm-diffu-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

/** `# diff --git a/<path> b/` chunk headers actually present in a collected diff string. */
function chunkPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!);
}

test("collectCommitDiff carries every untracked file's content, including one inside a brand-new subdirectory", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
  await $`git -C ${dir} add alpha.ts`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m seed`.quiet();
  writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2; // bumped\n");
  writeFileSync(join(dir, "beta.ts"), "export function beta() { return 1; }\n");
  writeFileSync(join(dir, "gamma.ts"), "export function gamma() { return 2; }\n");
  mkdirSync(join(dir, "newdir"));
  writeFileSync(join(dir, "newdir", "eta.ts"), "export function eta() { return 3; }\n");

  // Sanity check the bug's root cause is real: default porcelain status collapses a whole new
  // directory to one `?? dir/` line, so a naive caller parsing THAT would never see eta.ts.
  const porcelain = (await $`git -C ${dir} status --porcelain`.text()).trim();
  expect(porcelain).toContain("?? newdir/");
  expect(porcelain).not.toContain("newdir/eta.ts");

  const msg = await collectCommitDiff(dir);
  const diffSection = msg.split("# git diff\n")[1] ?? "";
  const paths = chunkPaths(diffSection);
  expect(paths.sort()).toEqual(["alpha.ts", "beta.ts", "gamma.ts", "newdir/eta.ts"].sort());
  // Every untracked file's actual content made it in as a real addition, not just its name.
  expect(diffSection).toContain("+export function beta() { return 1; }");
  expect(diffSection).toContain("+export function eta() { return 3; }");
  expect(diffSection).toContain("-export const alpha = 1;");
  expect(diffSection).toContain("+export const alpha = 2; // bumped");
});

test("collectPathsDiff scopes untracked content to the requested paths only", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "included.ts"), "export const included = true;\n");
  writeFileSync(join(dir, "excluded.ts"), "export const excluded = true;\n");

  const scoped = await collectPathsDiff(dir, ["included.ts"]);
  const diffSection = scoped.split("# git diff\n")[1] ?? "";
  expect(chunkPaths(diffSection)).toEqual(["included.ts"]);
  expect(diffSection).toContain("+export const included = true;");
  expect(diffSection).not.toContain("excluded");
});

test("collectCommitPlanInput includes untracked content, honors onlyPaths scope, and keeps folding noisy/binary files by name only", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "widget.ts"), "export function widget() { return 42; }\n");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "helper.ts"), "export function helper() { return 7; }\n");
  // A noisy-by-name lockfile: the planner already folds these out of the diff BODY for tracked
  // files (isNoisyPath) — confirm an UNTRACKED one gets the same treatment, not a free pass.
  writeFileSync(join(dir, "package-lock.json"), `{"name":"x","lockfileVersion":3}\n`.repeat(5));
  // A binary untracked file: git's own "Binary files … differ" line must show up, never bytes.
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 253, 0, 0, 0]));

  const plan = await collectCommitPlanInput(dir);
  const paths = plan.files.map((f) => f.path).sort();
  expect(paths).toEqual(["blob.bin", "nested/helper.ts", "package-lock.json", "widget.ts"]);

  const diffPaths = chunkPaths(plan.diff);
  expect(diffPaths).toContain("widget.ts");
  expect(diffPaths).toContain("nested/helper.ts");
  expect(plan.diff).toContain("+export function helper() { return 7; }");
  // The lockfile's NAME reaches the model (via the file list above); its BODY does not.
  expect(plan.diff).not.toContain("lockfileVersion");
  // Binary: git's own marker line, not raw bytes.
  expect(plan.diff).toMatch(/Binary files .*blob\.bin differ/);
  const binaryEntry = plan.files.find((f) => f.path === "blob.bin");
  expect(binaryEntry?.binary).toBe(true);

  const scopedPlan = await collectCommitPlanInput(dir, ["nested/helper.ts"]);
  expect(chunkPaths(scopedPlan.diff)).toEqual(["nested/helper.ts"]);
});

test("untracked diffing is hard-capped so a folder of many new files can't spawn unbounded git children", async () => {
  const dir = await repo();
  mkdirSync(join(dir, "many"), { recursive: true });
  const total = 45; // above diff.ts's documented UNTRACKED_FILE_CAP (40)
  for (let i = 0; i < total; i++) {
    writeFileSync(join(dir, "many", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }

  const msg = await collectCommitDiff(dir);
  const diffSection = msg.split("# git diff\n")[1] ?? "";
  const diffedCount = chunkPaths(diffSection).length;
  // Bounded well below the total: proves the cap is real, not just "big enough in practice".
  expect(diffedCount).toBeLessThan(total);
  expect(diffedCount).toBeLessThanOrEqual(40);
  expect(diffedCount).toBeGreaterThan(0);
});
