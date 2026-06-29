#!/usr/bin/env bun
/**
 * Global coverage gate (zero-dependency). bun's built-in `coverageThreshold` is PER-FILE, which
 * is too brittle for this repo (the integration entrypoints daemon.ts / index.ts are legitimately
 * low-coverage by design). Instead we run the suite with coverage and gate on the OVERALL line
 * coverage. Run: `bun run check:coverage` (CI uses this in place of a bare `bun test`).
 */
const MIN_LINE_COVERAGE = 80; // overall is ~92%; floor with margin to catch silent regression

const proc = Bun.spawnSync(["bun", "test", "--coverage"], { stdout: "pipe", stderr: "pipe" });
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
