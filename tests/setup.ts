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
// Secret operations are process-local in tests. Filesystem isolation alone is insufficient:
// a route test once minted a relay identity under the default Windows Credential Manager service
// and silently replaced the live daemon's signing key. No test may touch an OS credential store.
process.env.REPOYETI_KEYCHAIN_MEMORY = "1";
process.env.REPOYETI_KEYCHAIN_SERVICE = `repoyeti-test-${process.pid}`;

// ── the blast door ────────────────────────────────────────────────────────────────
// Stop git from ever walking OUT of the scratch root and into this repository.
//
// The hazard is structural, and it already bit once. `.testtmp/` lives inside RepoYeti's own
// working tree (it has to — see scratchRoot() above), and git resolves a repo by walking UP from
// the working directory until it finds a `.git`. So a fixture directory that isn't a valid git
// repo is not treated as "no repo": git climbs out of `.testtmp/`, finds RepoYeti's OWN `.git`,
// and every `git commit` / `git push` the test makes lands on THIS repository. That is not a
// hypothetical — a fixture built with a hand-made `mkdirSync(".git")` (which git does not
// recognise) did exactly that: it committed the working tree and pushed it to the public remote.
//
// GIT_CEILING_DIRECTORIES is git's own mechanism for this: it refuses to ascend past the listed
// directory. Now a malformed fixture fails loudly with "not a repository" — the correct, local,
// obvious failure — instead of silently succeeding against the real repo. Tests that build proper
// fixtures (`git init`) are unaffected: their `.git` is found immediately, with no ascent.
//
// Note this deliberately does NOT hide the mistake; it converts a silent catastrophe into a
// visible test failure. Fixtures should still be created with a real `git init`.
process.env.GIT_CEILING_DIRECTORIES = scratchRoot().replaceAll("\\", "/");
