import { setDefaultTimeout } from "bun:test";

/**
 * The suite's own test timeout, so `bun test` and `bun run test` are the SAME suite.
 *
 * They were not. The gate ran `bun test tests --timeout 20000` and a bare `bun test` used bun's
 * 5s default, and this repo has eight tests that legitimately take longer than that: nearly every
 * test here shells out to real git, and a dozen-odd process spawns before the first assertion is
 * normal, not exotic. So the two invocations disagreed about which tests pass, permanently, and
 * `bun test` is what a contributor or an agent types by habit.
 *
 * That is not a cosmetic difference. It is the entire evidence base of a retracted "Bun 1.4.0
 * broke this repo" claim (2026-08-21): the failures were reproduced with the wrong invocation,
 * read as a runtime regression, and the repo was nearly pinned back over them.
 *
 * WHY THIS SHAPE AND NOT A TIDIER ONE. Three places look like they should hold a suite-wide
 * timeout. Two of them are measured false greens on bun 1.4.0 - they look configured and do
 * nothing, which is worse than the flag they would replace:
 *
 *   · `timeout = 20000` under bunfig.toml's `[test]` table is IGNORED outright. A 6s test still
 *     dies at the 5s default with it set.
 *   · `setDefaultTimeout()` from the bunfig `preload` file applies only when ONE file runs. Add a
 *     second file to the same invocation and every test is back on 5s.
 *
 * Called from the test file itself it is scoped to that file and holds for the whole run, however
 * many files are in it - including through this helper. Measured both ways before relying on it.
 *
 * So every test file that reaches a subprocess calls `useSuiteTimeout()` at its top, and
 * `scripts/checks/spawn-test-without-timeout.mjs` enforces that rather than standing itself down
 * for a command-line flag. A timeout that lives on the command line only applies when someone
 * remembers the command line; this one travels with the code.
 *
 * A test that needs MORE than this still says so in its own third argument, which overrides this
 * default - see `REMOTE_ROUND_TIMEOUT_MS` in timer-rounds.test.ts for the file-constant idiom.
 */
export const SUITE_TIMEOUT_MS = 20_000;

/** Call once at the top of any test file whose tests spawn a subprocess. */
export function useSuiteTimeout(): void {
  setDefaultTimeout(SUITE_TIMEOUT_MS);
}
