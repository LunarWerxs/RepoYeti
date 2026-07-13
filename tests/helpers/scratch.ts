// Shared scratch-directory root for the WHOLE test suite. Deliberately NOT under the OS temp
// directory (os.tmpdir() / TEMP / TMP / TMPDIR): src/paths.ts's isUnderTempDir (the owner-directive
// hard guard upsertRepo enforces, see src/db.ts) refuses to import any repo whose path lives
// there, and the suite fabricates hundreds of scratch git repos via `mkdtempSync`. If those repos
// were rooted under the real OS temp dir (the historic pattern that produced the owner's ~115
// junk `%TEMP%\gm-*` rows in the first place), every one of those tests would now be refused by
// the very guard this project adds.
//
// So test scratch state (REPOYETI_HOME from tests/setup.ts, AND every ad-hoc scratch git repo the
// suite creates) lives under a repo-local directory instead. This also means the guard itself is
// exercised against the REAL os.tmpdir()/TEMP/TMP/TMPDIR (untouched here), not a substitute, in
// tests/db-temp-guard.test.ts.
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Repo-local scratch root (gitignored; see .gitignore's `.testtmp/`). Created on first use. */
const ROOT = join(import.meta.dir, "..", "..", ".testtmp");
mkdirSync(ROOT, { recursive: true });

/** The shared scratch root itself, for callers that want to nest their own subdirectory under it
 *  (e.g. tests/setup.ts's REPOYETI_HOME). */
export function scratchRoot(): string {
  return ROOT;
}

/** `mkdtempSync(join(scratchRoot(), prefix))`: the drop-in replacement for the suite's old
 *  `mkdtempSync(join(tmpdir(), prefix))` pattern, minus the OS-temp-dir problem above. */
export function mkScratchDir(prefix: string): string {
  return mkdtempSync(join(ROOT, prefix));
}
