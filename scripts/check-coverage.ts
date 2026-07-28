#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global coverage gate (zero-dependency). bun's built-in `coverageThreshold` is PER-FILE, which
 * is too brittle for this repo (the integration entrypoints daemon.ts / index.ts are legitimately
 * low-coverage by design). Instead we run the suite with coverage and gate on the OVERALL line
 * coverage. Run: `bun run check:coverage` (CI uses this in place of a bare `bun test`).
 */
const MIN_TEXT_LINE_COVERAGE = 78; // ~89% on CI; floor with margin to catch silent regressions
// Bun's LCOV reporter counts a broader set of instrumented lines than its text reporter. The
// sharded Linux baseline is 74.93% for the same commit whose text summary is 89.30%; keep the LCOV
// floor close to that measured baseline instead of comparing two different coverage denominators.
const MIN_LCOV_LINE_COVERAGE = 74;

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

function mergedLcovLineCoverage(reports: string[]): number {
  const hits = new Map<string, number>();
  for (const report of reports) {
    let source = "";
    for (const line of report.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        source = line.slice(3);
        continue;
      }
      if (!source || !line.startsWith("DA:")) continue;
      const [lineNumber, count] = line.slice(3).split(",", 2);
      if (!lineNumber || count === undefined) continue;
      const key = `${source}\0${lineNumber}`;
      hits.set(key, (hits.get(key) ?? 0) + Number(count));
    }
  }
  if (hits.size === 0) throw new Error("no DA records found in LCOV reports");
  let covered = 0;
  for (const count of hits.values()) if (count > 0) covered++;
  return (covered / hits.size) * 100;
}

let lineCoverage: number;
let minimumCoverage: number;
if (process.platform === "linux") {
  // Bun 1.3.14's Linux coverage process reproducibly terminates after enough fixture-heavy files,
  // with no failed assertion or coverage footer. Two native Bun shards stay below that limit.
  // Merge their LCOV DA records so the gate still measures one exact, repository-wide line ratio.
  const coverageRoot = mkdtempSync(join(tmpdir(), "repoyeti-coverage-"));
  const reports: string[] = [];
  try {
    for (let shard = 1; shard <= 2; shard++) {
      const coverageDir = join(coverageRoot, `shard-${shard}`);
      const result = await runSuite([
        ...baseArgs,
        `--shard=${shard}/2`,
        "--coverage-reporter=text",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coverageDir}`,
      ]);
      if (result.exitCode !== 0) {
        console.error(`✗ coverage shard ${shard}/2 failed — see above`);
        rmSync(coverageRoot, { recursive: true, force: true });
        process.exit(result.exitCode || 1);
      }
      reports.push(readFileSync(join(coverageDir, "lcov.info"), "utf8"));
    }
    lineCoverage = mergedLcovLineCoverage(reports);
    minimumCoverage = MIN_LCOV_LINE_COVERAGE;
  } finally {
    rmSync(coverageRoot, { recursive: true, force: true });
  }
} else {
  const { out, exitCode } = await runSuite(baseArgs);
  if (exitCode !== 0) {
    console.error("✗ tests failed — see above");
    process.exit(exitCode || 1);
  }
  // Coverage table footer: " All files | <% funcs> | <% lines> | ..."
  const match = out.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
  if (!match) {
    console.error("✗ could not parse the coverage summary (no 'All files' row)");
    process.exit(1);
  }
  lineCoverage = parseFloat(match[2]!);
  minimumCoverage = MIN_TEXT_LINE_COVERAGE;
}

if (lineCoverage < minimumCoverage) {
  console.error(`✗ overall line coverage ${lineCoverage}% is below the ${minimumCoverage}% floor`);
  process.exit(1);
}
console.log(`✓ overall line coverage ${lineCoverage.toFixed(2)}% ≥ ${minimumCoverage}% floor`);
