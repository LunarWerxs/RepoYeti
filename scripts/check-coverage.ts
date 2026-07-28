#!/usr/bin/env bun
/**
 * Global coverage gate (zero-dependency). bun's built-in `coverageThreshold` is PER-FILE, which
 * is too brittle for this repo (the integration entrypoints daemon.ts / index.ts are legitimately
 * low-coverage by design). Instead we run the suite with coverage and gate on the OVERALL line
 * coverage. Run: `bun run check:coverage` (CI uses this in place of a bare `bun test`).
 */
const MIN_LINE_COVERAGE = 78; // ~80% on CI (varies by platform + built assets); floor with margin to catch silent regressions

// Scope to `tests/` so bun's runner never picks up the web/ Vitest suite (web/test/*.test.ts use
// vitest-only APIs like vi.stubGlobal + @vue/test-utils and are run separately via `bun run --cwd web test`).
// --timeout 20000: git-heavy route tests (stash/discard/events) can exceed the 5s default on a
// slow/loaded Windows CI runner; the extra headroom keeps CI from flaking on cold git spawns.
// Some suites deliberately create process-wide database/config fixtures. Running files in distinct
// workers is faster, but on Linux it can make Bun's coverage collector terminate abruptly while
// it is merging those fixture-heavy files (without a failed assertion or coverage footer). Keep
// the coverage gate deterministic: one isolated worker still exercises every test and produces
// the one aggregate table that this script validates.
const proc = Bun.spawnSync(["bun", "test", "tests", "--coverage", "--timeout", "20000", "--parallel=1"], {
  stdout: "pipe",
  stderr: "pipe",
});
const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
process.stdout.write(out);

if (proc.exitCode !== 0) {
  console.error("✗ tests failed — see above");
  process.exit(proc.exitCode || 1);
}

// Coverage table footer: " All files | <% funcs> | <% lines> | ..."
const m = out.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
if (!m) {
  console.error("✗ could not parse the coverage summary (no 'All files' row)");
  process.exit(1);
}
const lineCoverage = parseFloat(m[2]!);
if (lineCoverage < MIN_LINE_COVERAGE) {
  console.error(`✗ overall line coverage ${lineCoverage}% is below the ${MIN_LINE_COVERAGE}% floor`);
  process.exit(1);
}
console.log(`✓ overall line coverage ${lineCoverage}% ≥ ${MIN_LINE_COVERAGE}% floor`);
