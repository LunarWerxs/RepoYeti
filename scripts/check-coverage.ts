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
// The sharded LCOV path now measures the same denominator the single-pass text reporter does (see
// mergedLcovLineCoverage), so this is no longer a second, incomparable scale. It stays a separate
// constant only because Linux genuinely covers less than Windows/macOS: the Windows-only branches
// are dead there. Tighten it toward the observed Linux baseline once that number settles.
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

/** One shard's report as `file → (line → hit count)`. */
function parseLcov(report: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | undefined;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const source = line.slice(3);
      lines = files.get(source) ?? new Map<number, number>();
      files.set(source, lines);
      continue;
    }
    if (!lines || !line.startsWith("DA:")) continue;
    const [lineNumber, count] = line.slice(3).split(",", 2);
    if (!lineNumber || count === undefined) continue;
    lines.set(Number(lineNumber), (lines.get(Number(lineNumber)) ?? 0) + Number(count));
  }
  return files;
}

/**
 * One repository-wide line ratio from several shards' LCOV reports.
 *
 * Counts a line only when EVERY shard that loaded its file reported it. That is not a detail: Bun
 * instruments a module against the paths that actually load in that process, so two shards emit
 * slightly different DA line-sets for the same file. Unioning them (the original implementation)
 * therefore invented denominator lines that no single run ever had, and since only one shard could
 * ever cover such a line, every one of them landed as a miss. Measured on this repo: union scored
 * the same suite at 85.91% against a single-pass truth of 88.89%, and the gap MOVED by more than a
 * point when a single new test file redistributed the shards, so the gate was reading shard
 * composition as a coverage regression. Intersecting reproduces the single-pass 88.89% exactly.
 */
export function mergedLcovLineCoverage(reports: string[]): number {
  const shards = reports.map(parseLcov);
  let covered = 0;
  let total = 0;
  for (const source of new Set(shards.flatMap((shard) => [...shard.keys()]))) {
    const seen = shards.map((shard) => shard.get(source)).filter((l): l is Map<number, number> => l !== undefined);
    const agreed = [...seen[0]!.keys()].filter((line) => seen.every((s) => s.has(line)));
    for (const line of agreed) {
      total++;
      if (seen.some((s) => (s.get(line) ?? 0) > 0)) covered++;
    }
  }
  if (total === 0) throw new Error("no DA records found in LCOV reports");
  return (covered / total) * 100;
}

// Guarded so tests/coverage-gate.test.ts can import the merge above and lock its behavior without
// running the entire suite as a side effect of the import.
if (import.meta.main) {
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
}
