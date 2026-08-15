#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global coverage gate (zero-dependency). bun's built-in `coverageThreshold` is PER-FILE, which
 * is too brittle for this repo (the integration entrypoints daemon.ts / index.ts are legitimately
 * low-coverage by design). Instead we run the suite with coverage and gate on the OVERALL line
 * coverage. Run: `bun run check:coverage` (CI uses this in place of a bare `bun test`).
 */
// The single-pass floor, used on Windows + macOS. macOS is the binding one of the two: it measured
// 85.66% against Windows' 91.79% on the same commit, because the Windows-only tray/service/launcher
// branches are dead there. Keep the floor under macOS, not under Windows.
const MIN_TEXT_LINE_COVERAGE = 83;
// The sharded LCOV path now measures the same denominator the single-pass text reporter does (see
// mergedLcovLineCoverage), so this is no longer a second, incomparable scale. It stays a separate
// constant only because Linux genuinely covers less than Windows/macOS: more of the
// platform-specific code is dead there than on macOS.
//
// Both numbers sit ~2-3 points under the measured baseline (Linux 82.35%, macOS 85.66%). That gap
// is the whole design: wide enough that ordinary work doesn't trip it, narrow enough that a
// feature landing untested does. If a run fails here, the fix is tests in that commit — moving
// the floor down to meet the code defeats the only thing this gate does.
const MIN_LCOV_LINE_COVERAGE = 80;

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

/**
 * Source files under `src/` that NO test ever executed a line of.
 *
 * The percentage floor above cannot see these. Bun instruments a module only when some test loads
 * it, so a brand-new file with no test at all lands in NEITHER the numerator nor the denominator:
 * it is invisible to the ratio rather than harmful to it. An entire feature can ship with tsc and
 * biome as its only gates, and the coverage number will not move a decimal.
 *
 * `.d.ts` and `.test.ts` are excluded; a declaration file has no executable lines to cover, and a
 * test is not the thing under test.
 */
export function untestedSources(reports: string[], sourceFiles: string[], root: string): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = (p: string) => {
    const n = norm(p);
    const r = norm(root);
    return n.startsWith(`${r}/`) ? n.slice(r.length + 1) : n;
  };
  const executed = new Set<string>();
  for (const shard of reports.map(parseLcov)) {
    for (const [source, lines] of shard) {
      if ([...lines.values()].some((hits) => hits > 0)) executed.add(rel(source));
    }
  }
  return sourceFiles.map(rel).filter((f) => !executed.has(f)).sort();
}

/** Every `src/**` file that could carry executable lines. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (/\.(ts|mts|mjs)$/.test(entry.name) && !/\.(d\.ts|d\.mts|test\.ts)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

// One path per line, `#` comments allowed. Deliberately a ratchet and not a floor: it records the
// files that were already untested when this gate was added, so the gate can fail on the NEXT one
// without demanding the existing backlog be cleared first. A gate that goes red on day one is a
// gate someone deletes on day one.
const ALLOWLIST = "scripts/coverage-untested-allowlist.txt";

type Ratchet = { untested: string[]; newly: string[]; stale: string[]; bootstrap: boolean };

/** `bootstrap` when the allowlist file does not exist yet: report the list, do not fail on it. */
function ratchetUntested(reports: string[]): Ratchet {
  const untested = untestedSources(reports, sourceFilesUnder("src"), process.cwd());
  if (!existsSync(ALLOWLIST)) return { untested, newly: [], stale: [], bootstrap: true };
  const allowed = new Set(
    readFileSync(ALLOWLIST, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean),
  );
  return {
    untested,
    newly: untested.filter((f) => !allowed.has(f)),
    stale: [...allowed].filter((f) => !untested.includes(f)).sort(),
    bootstrap: false,
  };
}

// Guarded so tests/coverage-gate.test.ts can import the merge above and lock its behavior without
// running the entire suite as a side effect of the import.
if (import.meta.main) {
  let lineCoverage: number;
  let minimumCoverage: number;
  let untestedReport: Ratchet | null = null;
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
    untestedReport = ratchetUntested(reports);
  } finally {
    rmSync(coverageRoot, { recursive: true, force: true });
  }
} else {
  // Ask for lcov alongside the text table. The percentage still comes from the table (that is the
  // single-pass number the floor was calibrated against); lcov is what gives the untested-file
  // ratchet its per-file rows, which the table does not carry. Linux has emitted both all along.
  const coverageDir = mkdtempSync(join(tmpdir(), "repoyeti-coverage-"));
  try {
    const { out, exitCode } = await runSuite([
      ...baseArgs,
      "--coverage-reporter=text",
      "--coverage-reporter=lcov",
      `--coverage-dir=${coverageDir}`,
    ]);
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
    untestedReport = ratchetUntested([readFileSync(join(coverageDir, "lcov.info"), "utf8")]);
  } finally {
    rmSync(coverageDir, { recursive: true, force: true });
  }
}

  if (lineCoverage < minimumCoverage) {
    console.error(`✗ overall line coverage ${lineCoverage}% is below the ${minimumCoverage}% floor`);
    process.exit(1);
  }
  console.log(`✓ overall line coverage ${lineCoverage.toFixed(2)}% ≥ ${minimumCoverage}% floor`);

  // Runs on ALL THREE platforms, against ONE shared allowlist. That is only safe because the
  // untested set turns out to be platform-invariant here, which was measured rather than assumed:
  // the Windows run and the Linux run name the same seven files, no false positives on either
  // side. Had they diverged, one allowlist would have meant each platform allowlisting the other's
  // covered files until the gate meant nothing. If a future file IS covered on one OS only, this
  // will fail on the others and the divergence is the finding, not the ratchet misbehaving: the
  // fix is a test that runs everywhere, not an allowlist entry.
  if (untestedReport?.bootstrap) {
    console.log(
      [
        "",
        `  ${ALLOWLIST} does not exist yet, so the untested-file ratchet is reporting only.`,
        `  ${untestedReport.untested.length} source file(s) currently have no test executing a line.`,
        "  Commit exactly these lines as that file to arm it:",
        "",
        ...untestedReport.untested.map((f) => `${f}`),
        "",
      ].join("\n"),
    );
  } else if (untestedReport) {
    if (untestedReport.stale.length > 0) {
      console.log(
        `  note: ${untestedReport.stale.length} allowlisted file(s) now have coverage and can be pruned from ${ALLOWLIST}:`,
      );
      for (const f of untestedReport.stale) console.log(`    ${f}`);
    }
    if (untestedReport.newly.length > 0) {
      console.error(
        `\n✗ ${untestedReport.newly.length} source file(s) have no test executing a single line:`,
      );
      for (const f of untestedReport.newly) console.error(`    ${f}`);
      console.error(
        [
          "",
          "  The percentage floor cannot see these: an entirely untested file is absent from the",
          "  coverage denominator, so it can never move the number it would otherwise drag down.",
          "",
          `  Write a test that loads it, or, if it is genuinely untestable here, add its path to`,
          `  ${ALLOWLIST} with a comment saying why, in this same commit.`,
          "",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.log(
      `✓ no newly-untested source files (${untestedReport.untested.length} known, allowlisted)`,
    );
  }
}
