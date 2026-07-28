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
async function runSuite(args: string[]): Promise<{ out: string; exitCode: number }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const out = stdout + stderr;
  process.stdout.write(out);
  return { out, exitCode };
}

const baseArgs = ["bun", "test", "tests", "--coverage", "--timeout", "20000"];
// Bun 1.3.14 on Linux reproducibly terminates the aggregate coverage process as it enters the
// git-heavy activity suite after roughly 900 successful tests. The same file passes by itself
// under coverage, and the full aggregate passes on macOS and Windows. Give that file a fresh Linux
// process; the main coverage percentage is conservative because it no longer receives the
// activity suite's unusually high line coverage.
const aggregateArgs =
  process.platform === "linux"
    ? [...baseArgs, "--path-ignore-patterns", "**/activity.test.ts"]
    : baseArgs;
const { out, exitCode } = await runSuite(aggregateArgs);

if (exitCode !== 0) {
  console.error("✗ tests failed — see above");
  process.exit(exitCode || 1);
}

if (process.platform === "linux") {
  const activity = await runSuite([
    "bun",
    "test",
    "tests/activity.test.ts",
    "--coverage",
    "--timeout",
    "20000",
  ]);
  if (activity.exitCode !== 0) {
    console.error("✗ isolated activity coverage tests failed — see above");
    process.exit(activity.exitCode || 1);
  }
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
