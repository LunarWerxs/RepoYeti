// Runs before any test module imports src/*: points all daemon state at a throwaway
// dir so tests never read or write the real ~/.repoyeti.
import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupScratchRun,
  cleanupScratchRunAsync,
  scratchRoot,
  scratchSuiteRoot,
} from "./helpers/scratch.ts";

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
// Anchored at the `.testtmp` root, not this run's subdirectory, so the door covers every path in
// the scratch tree — including a stray fixture created outside the per-run directory.
process.env.GIT_CEILING_DIRECTORIES = scratchSuiteRoot().replaceAll("\\", "/");

// ── teardown ──────────────────────────────────────────────────────────────────────
// Nothing else reaps `.testtmp`. It is gitignored (invisible to the git-based checks), and CI
// never notices because GitHub runners are destroyed after every job — so the cost lands entirely
// on developer machines, where it reached 1,673,606 files across 46,854 leaked scratch directories
// in under three weeks. Only ~4.6 GB, but the file COUNT is what hurts: it slows every tool that
// walks the tree and takes an age to delete once grown.
//
// Two mechanisms, because neither alone is sufficient:
//   · afterAll — the clean-exit path. This file is the sole `preload` (bunfig.toml), and a bun
//     preload is evaluated once per test process, so a top-level afterAll registered here fires
//     once after the whole suite. It uses the async rmrf() for its Windows EBUSY/EPERM retries:
//     a watcher or SSE stream closed moments earlier can still be holding a directory handle.
//   · process exit — the interrupted path (Ctrl-C, a crash, a killed run). Exit handlers must be
//     synchronous, so this is a plain rmSync with no retry. That a preload's afterAll fires once
//     is bun behaviour rather than a documented contract, which is the other reason to keep it.
//
// Anything either path misses is caught by sweepOrphanedRuns() on a later run. Teardown is
// best-effort throughout: it must never turn a run whose assertions already passed red.
// 60s, and the second argument is load-bearing rather than defensive. This hook deletes the
// WHOLE run's scratch tree - dozens of real git repos, tens of thousands of small files - and it
// runs once, at the very end, with Windows EBUSY retries layered on top. It sat on bun's 5s
// default, which the gate's old `--timeout 20000` flag happened to cover; the moment that flag
// went away it was the last thing standing between a bare `bun test` and a green run, and it
// failed as `(fail) (unnamed)` attributed to whichever file happened to be last. Teardown must
// never turn a run whose assertions already passed red, so it gets room to finish.
afterAll(async () => {
  await cleanupScratchRunAsync();
}, 60_000);

process.on("exit", cleanupScratchRun);
