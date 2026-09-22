// Regression tests for two review findings in src/ai/conflict-resolve.ts (group "conflict-resolve").
//
// A dedicated file rather than additions to tests/conflict-resolve.test.ts, which is the existing
// suite for this module and the file the group rule names — that name is already taken, so the
// regressions live here. Network-free: the provider call is intercepted with an injected fetch.
//
//   F027 — a malformed first block for a region used to mark the region "seen" before it passed
//          its format checks, so a later, well-formed block for the same region was discarded as
//          a "duplicate" and the model's usable answer thrown away.
//   F028 — `windowed` was re-derived by substring-matching the prompt for "unchanged line"
//          instead of using windowFile's own result, so a small file containing that literal text
//          (or a windowed file whose kept lines elide nothing) reported the flag wrong.
import { expect, test } from "bun:test";
import {
  type ConflictHunk,
  generateConflictResolution,
  parseConflictFile,
  parseConflictResolution,
} from "../src/ai/conflict-resolve.ts";
import type { FetchFn } from "../src/ai/commit-message.ts";

const MARK = {
  ours: "<".repeat(7),
  base: "|".repeat(7),
  sep: "=".repeat(7),
  theirs: ">".repeat(7),
};

/** A two-way conflict (git's default `merge` conflictStyle) with optional surrounding lines. */
function twoWay(ours: string, theirs: string, { before = "", after = "" } = {}): string {
  return (
    `${before}${MARK.ours} HEAD\n${ours}${MARK.sep}\n${theirs}${MARK.theirs} feature\n${after}`
  );
}

const hunksOf = (file: string): ConflictHunk[] => parseConflictFile(file)!.hunks;

const block = (n: number, confidence: string, note: string, content: string): string =>
  `<<<REPOYETI-HUNK ${n}>>>\nCONFIDENCE: ${confidence}\nNOTE: ${note}\n---CONTENT---\n${content}\n<<<REPOYETI-END ${n}>>>\n`;

// ── F027 ─────────────────────────────────────────────────────────────────────────────

test("F027 a well-formed block after a malformed one for the same region is not discarded as duplicate", () => {
  const hunks = hunksOf(twoWay("a\n", "b\n"));
  // First block omits `---CONTENT---` entirely (rejected as "malformed"); the second is usable.
  const malformed = `<<<REPOYETI-HUNK 1>>>\nCONFIDENCE: high\nno content marker at all\n<<<REPOYETI-END 1>>>\n`;
  const reply = malformed + block(1, "high", "real", "merged");
  const { resolutions, rejected } = parseConflictResolution(reply, hunks);
  expect(resolutions.map((r) => r.index)).toEqual([1]);
  expect(resolutions[0]!.content).toBe("merged");
  // The malformed draft's rejection does not stand once a good block supersedes it.
  expect(rejected).toEqual([]);
});

test("F027 a well-formed block after a conflict-markers one for the same region is not discarded", () => {
  const hunks = hunksOf(twoWay("a\n", "b\n"));
  const withMarkers = `${MARK.ours} HEAD\na\n${MARK.sep}\nb\n${MARK.theirs} feature`;
  const reply = block(1, "high", "oops", withMarkers) + block(1, "high", "fixed", "merged");
  const { resolutions, rejected } = parseConflictResolution(reply, hunks);
  expect(resolutions.map((r) => r.index)).toEqual([1]);
  expect(resolutions[0]!.content).toBe("merged");
  expect(rejected).toEqual([]);
});

test("F027 a region whose ONLY block was malformed is rejected, never reported as missing", () => {
  const hunks = hunksOf(twoWay("a\n", "b\n"));
  const { resolutions, rejected } = parseConflictResolution(
    `<<<REPOYETI-HUNK 1>>>\nCONFIDENCE: high\nno content marker\n<<<REPOYETI-END 1>>>\n`,
    hunks,
  );
  expect(resolutions).toEqual([]);
  expect(rejected).toEqual([{ index: 1, reason: "malformed" }]);
});

test("F027 two VALID blocks for one region still keep the first and reject the second as duplicate", () => {
  const hunks = hunksOf(twoWay("a\n", "b\n"));
  const { resolutions, rejected } = parseConflictResolution(
    block(1, "high", "first", "first-answer") + block(1, "low", "second", "second-answer"),
    hunks,
  );
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.content).toBe("first-answer");
  expect(rejected).toEqual([{ index: 1, reason: "duplicate" }]);
});

// ── F028 ─────────────────────────────────────────────────────────────────────────────

/** A fetchImpl that answers every request with a single well-formed resolution for hunk 1. */
const stubReply = (content = "merged"): FetchFn =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: block(1, "high", "x", content) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as FetchFn;

test("F028 a small file containing the literal words 'unchanged line' is not reported as windowed", async () => {
  // windowFile never injects the phrase for a small file, so the old substring probe misfired on
  // text the model actually saw in full.
  const file = twoWay("a\n", "b\n", { before: "// unchanged line count below\n", after: "\n" });
  const parsed = parseConflictFile(file)!;
  const res = await generateConflictResolution(
    "openai",
    "test-key",
    "gpt-4o",
    "src/small.ts",
    file,
    parsed,
    stubReply(),
  );
  expect(res.windowed).toBe(false);
});

test("F028 a large file actually windowed by windowFile is reported as windowed", async () => {
  const filler = "// filler line to push this file past the context budget\n".repeat(2000);
  const file = twoWay("needle-ours\n", "needle-theirs\n", { before: filler, after: filler });
  const parsed = parseConflictFile(file)!;
  const res = await generateConflictResolution(
    "openai",
    "test-key",
    "gpt-4o",
    "src/big.ts",
    file,
    parsed,
    stubReply(),
  );
  expect(res.windowed).toBe(true);
});
