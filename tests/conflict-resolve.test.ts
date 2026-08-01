// Pure-engine tests for AI merge-conflict resolution (src/ai/conflict-resolve.ts).
//
// Everything here is network-free and git-free by design: marker parsing, the byte-exactness of
// a rebuild, the mechanical audit, and the reply protocol are the parts that MUST be right, and
// they are all pure functions. The git-touching half lives in tests/conflict-service.test.ts.
//
// Markers are assembled from `MARK` rather than typed literally. Not superstition: a source file
// carrying real `<<<<<<<` at column 0 is a file that confuses git's own tooling the day someone
// merges it, and this suite's whole subject is what those seven characters mean.
import { expect, test } from "bun:test";
import {
  assessResolution,
  hasConflictMarkers,
  looksSmallTierModel,
  parseConflictFile,
  parseConflictResolution,
  renderResolvedFile,
  resolveSystemPrompt,
  resolveUserPrompt,
} from "../src/ai/conflict-resolve.ts";

const MARK = {
  ours: "<".repeat(7),
  base: "|".repeat(7),
  sep: "=".repeat(7),
  theirs: ">".repeat(7),
};

/** A two-way conflict (git's default `merge` conflictStyle — no ancestor text). */
function twoWay(ours: string, theirs: string, { before = "", after = "" } = {}): string {
  return (
    before +
    `${MARK.ours} HEAD\n${ours}${MARK.sep}\n${theirs}${MARK.theirs} feature\n` +
    after
  );
}

/** A three-way conflict (`diff3`/`zdiff3` conflictStyle — carries the common ancestor). */
function threeWay(ours: string, base: string, theirs: string): string {
  return (
    `${MARK.ours} HEAD\n${ours}${MARK.base} base\n${base}${MARK.sep}\n${theirs}${MARK.theirs} feature\n`
  );
}

// ── marker parsing ────────────────────────────────────────────────────────────────

test("parseConflictFile splits a two-way conflict into verbatim spans and one hunk", () => {
  const file = twoWay("const a = 1;\n", "const a = 2;\n", {
    before: "import x from 'x';\n\n",
    after: "\nexport default a;\n",
  });
  const parsed = parseConflictFile(file);
  expect(parsed).not.toBeNull();
  expect(parsed!.hunks).toHaveLength(1);

  const h = parsed!.hunks[0]!;
  expect(h.index).toBe(1);
  expect(h.oursLabel).toBe("HEAD");
  expect(h.theirsLabel).toBe("feature");
  expect(h.oursText).toBe("const a = 1;\n");
  expect(h.theirsText).toBe("const a = 2;\n");
  expect(h.baseText).toBeUndefined();
  // `line` is 0-based and points at the `<<<<<<<` row — the UI renders it +1.
  expect(h.line).toBe(2);
  // `raw` must be the WHOLE region, because declining a proposal splices it straight back.
  expect(h.raw.startsWith(MARK.ours)).toBe(true);
  expect(h.raw.trimEnd().endsWith("feature")).toBe(true);
});

test("parseConflictFile captures the common ancestor from diff3 markers", () => {
  const parsed = parseConflictFile(threeWay("ours\n", "original\n", "theirs\n"));
  expect(parsed!.hunks[0]!.baseText).toBe("original\n");
  expect(parsed!.hunks[0]!.oursText).toBe("ours\n");
  expect(parsed!.hunks[0]!.theirsText).toBe("theirs\n");
});

test("parseConflictFile numbers multiple hunks in file order", () => {
  const file = `${twoWay("a1\n", "a2\n", { before: "head\n" })}middle\n${twoWay("b1\n", "b2\n", { after: "tail\n" })}`;
  const parsed = parseConflictFile(file);
  expect(parsed!.hunks.map((h) => h.index)).toEqual([1, 2]);
  expect(parsed!.hunks.map((h) => h.oursText)).toEqual(["a1\n", "b1\n"]);
});

test("parseConflictFile refuses a NESTED conflict rather than guessing at its structure", () => {
  // A conflicted file that was itself merged again. Splicing into the wrong nesting level would
  // corrupt the file in a way no later review catches, so the whole file is refused.
  const nested = `${MARK.ours} HEAD\n${MARK.ours} inner\nx\n${MARK.sep}\ny\n${MARK.theirs} inner\n${MARK.sep}\nz\n${MARK.theirs} outer\n`;
  expect(parseConflictFile(nested)).toBeNull();
});

test("parseConflictFile refuses an unterminated region", () => {
  expect(parseConflictFile(`${MARK.ours} HEAD\nours\n${MARK.sep}\ntheirs\n`)).toBeNull();
});

test("parseConflictFile returns null for a file with no conflict at all", () => {
  expect(parseConflictFile("just some code\n")).toBeNull();
});

test("hasConflictMarkers only matches markers at the start of a line", () => {
  expect(hasConflictMarkers(`${MARK.ours} HEAD\n`)).toBe(true);
  expect(hasConflictMarkers(`const arrow = a ${MARK.sep} b;\n`)).toBe(false);
  expect(hasConflictMarkers("const shift = a >> b;\n")).toBe(false);
});

// ── rebuilding ────────────────────────────────────────────────────────────────────

test("renderResolvedFile is byte-exact outside the regions it replaces", () => {
  const before = "line one\r\nline two\r\n";
  const after = "\r\ntail\r\n";
  const file = twoWay("ours\r\n", "theirs\r\n", { before, after });
  const parsed = parseConflictFile(file)!;
  const out = renderResolvedFile(parsed, new Map([[1, "merged"]]));

  expect(out.startsWith(before)).toBe(true);
  expect(out.endsWith(after)).toBe(true);
  expect(hasConflictMarkers(out)).toBe(false);
  // CRLF file → CRLF applied to the model's content, not a stray bare LF.
  expect(out).toContain("merged\r\n");
  expect(/[^\r]\n/.test(out)).toBe(false);
});

test("renderResolvedFile keeps the ORIGINAL markers for hunks that were not accepted", () => {
  const file = twoWay("a1\n", "a2\n") + twoWay("b1\n", "b2\n");
  const parsed = parseConflictFile(file)!;
  const out = renderResolvedFile(parsed, new Map([[1, "resolved-a\n"]]));

  // This is the invariant that makes a PARTIAL apply safe: hunk 2 still carries its markers, so
  // git still sees the path as unmerged and still refuses to commit it.
  expect(out).toContain("resolved-a");
  expect(out).not.toContain("a1");
  expect(hasConflictMarkers(out)).toBe(true);
  expect(out).toContain("b1");
  expect(out).toContain("b2");
  // And the leftover region survives byte-for-byte.
  expect(out).toContain(parsed.hunks[1]!.raw);
});

test("renderResolvedFile does not invent a trailing newline the file never had", () => {
  // Region runs to EOF with no final newline. Adding one would be a one-byte diff on a line
  // nobody edited — the sort of noise that makes a resolution look bigger than it is.
  const file = `head\n${MARK.ours} HEAD\nours\n${MARK.sep}\ntheirs\n${MARK.theirs} feature`;
  const parsed = parseConflictFile(file)!;
  const out = renderResolvedFile(parsed, new Map([[1, "merged"]]));
  expect(out).toBe("head\nmerged");
});

test("renderResolvedFile handles a resolution that is deliberately empty", () => {
  const file = twoWay("gone\n", "also gone\n", { before: "a\n", after: "b\n" });
  const parsed = parseConflictFile(file)!;
  expect(renderResolvedFile(parsed, new Map([[1, ""]]))).toBe("a\nb\n");
});

// ── the mechanical audit ──────────────────────────────────────────────────────────

const hunkOf = (ours: string, theirs: string, base?: string) =>
  parseConflictFile(base === undefined ? twoWay(ours, theirs) : threeWay(ours, base, theirs))!.hunks[0]!;

test("assessResolution flags a line BOTH sides kept but the resolution dropped", () => {
  // The single strongest bad-merge signal: if the two sides agreed on `keepMe()`, dropping it is
  // a mistake regardless of how confident the model sounded.
  const h = hunkOf("keepMe();\nours();\n", "keepMe();\ntheirs();\n");
  const audit = assessResolution(h, "ours();\ntheirs();\n");
  expect(audit.flags).toContain("dropped-shared-lines");
  expect(audit.droppedLines).toEqual(["keepMe();"]);
});

test("assessResolution does NOT flag a correct both-sides merge", () => {
  const h = hunkOf("keepMe();\nours();\n", "keepMe();\ntheirs();\n");
  expect(assessResolution(h, "keepMe();\nours();\ntheirs();\n").flags).toEqual([]);
});

test("assessResolution reports when the model merely picked a side", () => {
  const h = hunkOf("ours();\n", "theirs();\n");
  expect(assessResolution(h, "ours();\n").flags).toContain("identical-to-ours");
  expect(assessResolution(h, "theirs();\n").flags).toContain("identical-to-theirs");
});

test("assessResolution flags invented code but tolerates a line or two of glue", () => {
  const h = hunkOf("a();\nb();\nc();\n", "a();\nb();\nd();\n");
  // One novel line joining two real sides is legitimate merge glue.
  expect(assessResolution(h, "a();\nb();\nc();\nd();\ne();\n").flags).not.toContain("invented-lines");
  // A wholesale rewrite is not.
  const rewrite = assessResolution(h, "x1();\nx2();\nx3();\nx4();\nx5();\n");
  expect(rewrite.flags).toContain("invented-lines");
  expect(rewrite.inventedLines.length).toBeGreaterThan(0);
});

test("assessResolution counts base text as known, so restoring an ancestor line is not 'invented'", () => {
  const h = hunkOf("ours();\n", "theirs();\n", "ancestor();\n");
  expect(assessResolution(h, "ancestor();\nours();\ntheirs();\n").flags).not.toContain("invented-lines");
});

test("assessResolution flags an emptied region and a suspiciously short one", () => {
  expect(assessResolution(hunkOf("a();\n", "b();\n"), "").flags).toContain("emptied");
  const long = hunkOf("a();\nb();\nc();\nd();\n", "a();\nb();\nc();\ne();\n");
  expect(assessResolution(long, "a();\n").flags).toContain("much-shorter");
});

// ── model-tier heuristic ──────────────────────────────────────────────────────────

test("looksSmallTierModel recognises the small/fast tiers, including catalog defaults", () => {
  // These three ARE this app's own `recommended` models (config.ts AI_CATALOG). Matching them is
  // the intended result: they were picked for cheap commit messages, and a merge is not that.
  for (const m of ["gpt-4o-mini", "gemini-2.0-flash", "claude-3-5-haiku-latest"]) {
    expect(looksSmallTierModel(m)).toBe(true);
  }
  for (const m of ["llama-3.1-8b-instant", "qwen2.5-7b-instruct", "gemma-2-2b-it", "phi-4-mini", "ministral-3b"]) {
    expect(looksSmallTierModel(m)).toBe(true);
  }
});

test("looksSmallTierModel does not claim a large model is small", () => {
  for (const m of [
    "llama-3.3-70b-versatile",
    "claude-sonnet-4-5",
    "deepseek-chat",
    "gpt-4o",
    "qwen2.5-coder-32b-instruct",
  ]) {
    expect(looksSmallTierModel(m)).toBe(false);
  }
});

// ── the reply protocol ────────────────────────────────────────────────────────────

const block = (n: number, confidence: string, note: string, content: string): string =>
  `<<<REPOYETI-HUNK ${n}>>>\nCONFIDENCE: ${confidence}\nNOTE: ${note}\n---CONTENT---\n${content}\n<<<REPOYETI-END ${n}>>>\n`;

test("parseConflictResolution reads a well-formed reply and runs the audit on it", () => {
  const hunks = parseConflictFile(twoWay("keep();\nours();\n", "keep();\ntheirs();\n"))!.hunks;
  const { resolutions, rejected } = parseConflictResolution(
    `some preamble the model was told not to write\n${block(1, "high", "kept both", "keep();\nours();\ntheirs();")}`,
    hunks,
  );
  expect(rejected).toEqual([]);
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.confidence).toBe("high");
  expect(resolutions[0]!.note).toBe("kept both");
  expect(resolutions[0]!.content).toBe("keep();\nours();\ntheirs();");
  expect(resolutions[0]!.flags).toEqual([]);
});

test("parseConflictResolution REFUSES a resolution that still carries conflict markers", () => {
  // The guarantee this protects: "applied" can never mean "the markers moved elsewhere".
  const hunks = parseConflictFile(twoWay("a\n", "b\n"))!.hunks;
  const { resolutions, rejected } = parseConflictResolution(
    block(1, "high", "oops", `${MARK.ours} HEAD\na\n${MARK.sep}\nb\n${MARK.theirs} feature`),
    hunks,
  );
  expect(resolutions).toEqual([]);
  expect(rejected).toEqual([{ index: 1, reason: "conflict-markers" }]);
});

test("parseConflictResolution recovers per-hunk: one bad block does not lose the good ones", () => {
  const hunks = parseConflictFile(twoWay("a1\n", "a2\n") + twoWay("b1\n", "b2\n") + twoWay("c1\n", "c2\n"))!.hunks;
  const reply =
    block(1, "high", "fine", "resolved-1") +
    `<<<REPOYETI-HUNK 2>>>\nCONFIDENCE: high\nno content marker at all\n<<<REPOYETI-END 2>>>\n` +
    block(3, "medium", "fine", "resolved-3");
  const { resolutions, rejected } = parseConflictResolution(reply, hunks);
  expect(resolutions.map((r) => r.index)).toEqual([1, 3]);
  expect(rejected).toEqual([{ index: 2, reason: "malformed" }]);
});

test("parseConflictResolution reports a region the model skipped as 'missing', never as silence", () => {
  // "the model did not answer for hunk 2" and "hunk 2 needs no change" must not look the same.
  const hunks = parseConflictFile(twoWay("a1\n", "a2\n") + twoWay("b1\n", "b2\n"))!.hunks;
  const { resolutions, rejected } = parseConflictResolution(block(1, "high", "x", "done"), hunks);
  expect(resolutions.map((r) => r.index)).toEqual([1]);
  expect(rejected).toEqual([{ index: 2, reason: "missing" }]);
});

test("parseConflictResolution keeps the first answer and rejects a duplicate region", () => {
  const hunks = parseConflictFile(twoWay("a\n", "b\n"))!.hunks;
  const { resolutions, rejected } = parseConflictResolution(
    block(1, "high", "first", "first-answer") + block(1, "low", "second", "second-answer"),
    hunks,
  );
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.content).toBe("first-answer");
  expect(rejected).toEqual([{ index: 1, reason: "duplicate" }]);
});

test("parseConflictResolution strips a markdown fence the model added anyway", () => {
  const hunks = parseConflictFile(twoWay("a\n", "b\n"))!.hunks;
  const { resolutions } = parseConflictResolution(
    block(1, "high", "x", "```ts\nconst a = 1;\n```"),
    hunks,
  );
  expect(resolutions[0]!.content).toBe("const a = 1;");
});

test("parseConflictResolution downgrades an unreadable confidence to low, never to high", () => {
  // Guessing "high" would have an owner trusting a proposal nobody vouched for.
  const hunks = parseConflictFile(twoWay("a\n", "b\n"))!.hunks;
  const { resolutions } = parseConflictResolution(block(1, "extremely-sure", "x", "merged"), hunks);
  expect(resolutions[0]!.confidence).toBe("low");
});

test("parseConflictResolution ignores a region number that does not exist", () => {
  const hunks = parseConflictFile(twoWay("a\n", "b\n"))!.hunks;
  const { resolutions, rejected } = parseConflictResolution(
    block(1, "high", "x", "merged") + block(9, "high", "hallucinated", "nonsense"),
    hunks,
  );
  expect(resolutions.map((r) => r.index)).toEqual([1]);
  expect(rejected).toEqual([]);
});

// ── prompts ───────────────────────────────────────────────────────────────────────

test("resolveSystemPrompt tells the model to flag rather than guess, and adapts to a missing base", () => {
  const withBase = resolveSystemPrompt(true);
  expect(withBase).toContain("DO NOT GUESS");
  expect(withBase).toContain("BASE is the common ancestor");

  const withoutBase = resolveSystemPrompt(false);
  expect(withoutBase).toContain("no common-ancestor text available");
  expect(withoutBase).not.toContain("BASE is the common ancestor");
});

test("resolveUserPrompt windows a large file but still shows every region in full", () => {
  const filler = "// filler line to push this file past the context budget\n".repeat(2000);
  const file = twoWay("needle-ours\n", "needle-theirs\n", { before: filler, after: filler });
  const parsed = parseConflictFile(file)!;
  const prompt = resolveUserPrompt("src/big.ts", file, parsed);

  expect(prompt.length).toBeLessThan(file.length);
  expect(prompt).toContain("not shown");
  // Elisions are MARKED so the model can't read a gap as adjacency, and the region survives.
  expect(prompt).toContain("needle-ours");
  expect(prompt).toContain("needle-theirs");
});

test("resolveUserPrompt leaves a small file intact", () => {
  const file = twoWay("a\n", "b\n", { before: "head\n", after: "tail\n" });
  const prompt = resolveUserPrompt("src/small.ts", file, parseConflictFile(file)!);
  expect(prompt).toContain(file);
  expect(prompt).not.toContain("not shown");
});
