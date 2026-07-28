/**
 * The coverage gate's own regression test.
 *
 * The Linux gate runs the suite in two Bun shards and merges their LCOV reports. It used to UNION
 * the reported line-sets, which is wrong: Bun instruments a module against the paths that actually
 * load in that process, so two shards emit slightly different DA lines for the same file. Unioning
 * invented denominator lines no single run ever had, and only one shard could ever cover such a
 * line, so each one landed as a miss. The gate then read shard composition as a coverage
 * regression: adding one test file moved the number by more than a point and failed CI on a
 * commit whose real coverage had gone UP.
 *
 * Measured on this repo at the time: union 85.91% vs a single-pass truth of 88.89%; intersecting
 * reproduced 88.89% exactly.
 */
import { test, expect } from "bun:test";
import { mergedLcovLineCoverage } from "../scripts/check-coverage.ts";

/** Build an LCOV report body from `file → [line, hits][]`. */
function lcov(files: Record<string, [number, number][]>): string {
  const records = Object.entries(files).map(([file, das]) =>
    [`SF:${file}`, ...das.map(([l, h]) => `DA:${l},${h}`), "end_of_record"].join("\n"),
  );
  return `${records.join("\n")}\n`;
}

test("a line only one shard's instrumentation reported is not counted as a miss", () => {
  // Both shards agree on lines 1-2 of a.ts; only shard 2 instrumented line 3. Under the old union
  // that phantom line was an automatic miss (2/3 = 66.7%). It must not be counted at all.
  const shard1 = lcov({ "src/a.ts": [[1, 1], [2, 1]] });
  const shard2 = lcov({ "src/a.ts": [[1, 0], [2, 0], [3, 0]] });
  expect(mergedLcovLineCoverage([shard1, shard2])).toBe(100);
});

test("a line covered in either shard counts as covered", () => {
  const shard1 = lcov({ "src/a.ts": [[1, 1], [2, 0]] });
  const shard2 = lcov({ "src/a.ts": [[1, 0], [2, 3]] });
  expect(mergedLcovLineCoverage([shard1, shard2])).toBe(100);
});

test("a line no shard ever executed is still a miss", () => {
  const shard1 = lcov({ "src/a.ts": [[1, 1], [2, 0]] });
  const shard2 = lcov({ "src/a.ts": [[1, 0], [2, 0]] });
  expect(mergedLcovLineCoverage([shard1, shard2])).toBe(50);
});

test("a file only one shard loaded is measured on its own reported lines", () => {
  // Test files are like this: each shard only ever loads its own. Dropping them would be as wrong
  // as inventing lines for them.
  const shard1 = lcov({ "tests/only-here.test.ts": [[1, 1], [2, 0]] });
  const shard2 = lcov({ "src/b.ts": [[1, 1], [2, 1]] });
  expect(mergedLcovLineCoverage([shard1, shard2])).toBe(75); // 3 of 4
});

test("the ratio does not move when the same work is split differently across shards", () => {
  // The property that failed in CI: the same suite, re-sharded, must score the same.
  const a = lcov({ "src/a.ts": [[1, 1], [2, 1], [3, 0]] });
  const b = lcov({ "src/a.ts": [[1, 0], [2, 0], [3, 0]] });
  const split1 = mergedLcovLineCoverage([a, b]);
  const split2 = mergedLcovLineCoverage([b, a]);
  expect(split1).toBe(split2);
  expect(split1).toBeCloseTo((2 / 3) * 100, 10);
});

test("reports with no DA records at all fail loudly instead of scoring 0%", () => {
  expect(() => mergedLcovLineCoverage([lcov({}), lcov({})])).toThrow(/no DA records/);
});
