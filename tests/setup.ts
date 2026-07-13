// Runs before any test module imports src/*: points all daemon state at a throwaway
// dir so tests never read or write the real ~/.repoyeti.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "./helpers/scratch.ts";

// REPOYETI_HOME lives under the repo-local scratch root (tests/helpers/scratch.ts), NOT under
// the OS temp directory. upsertRepo (src/db.ts) hard-refuses any repo path under the OS temp dir
// (see src/paths.ts isUnderTempDir; owner directive: a temp-path repo must never be imported), and
// the whole test suite fabricates its scratch git repos the same way, via mkScratchDir (the
// drop-in replacement for the old `mkdtempSync(join(tmpdir(), ...))` pattern). That old pattern is
// the exact one that historically leaked ~115 junk rows into the owner's live DB, e.g.
// `%TEMP%\gm-*`. Keeping every bit of test scratch state off the real OS temp tree means the guard
// is exercised against the REAL os.tmpdir()/TEMP/TMP/TMPDIR (see tests/db-temp-guard.test.ts)
// without every other test in the suite tripping it.
process.env.REPOYETI_HOME = mkdtempSync(join(scratchRoot(), "repoyeti-test-home-"));
process.env.GIT_TERMINAL_PROMPT = "0";
