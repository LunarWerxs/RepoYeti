import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";

import { join } from "node:path";
import { $ } from "bun";
import {
  parsePatchStats,
  computeDiffStats,
  createPatchStatParser,
  PATCH_LINE_BUFFER_CHARS,
} from "../src/read/diffstat.ts";
import { readStatus, readChanges } from "../src/read/status.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// ── pure patch parser ───────────────────────────────────────────────────────────

test("parsePatchStats counts added/removed lines + chars per file", () => {
  // A modified line shows as one '-' (old) and one '+' (new); a true addition is just '+'.
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index e69de29..0cfbf08 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,3 @@",
    " hello",
    "-world",
    "+there",
    "+you",
    "",
  ].join("\n");

  const m = parsePatchStats(patch);
  const a = m.get("a.txt")!;
  expect(a.addedLines).toBe(2); // "there", "you"
  expect(a.removedLines).toBe(1); // "world"
  expect(a.addedChars).toBe("there".length + "you".length); // 8
  expect(a.removedChars).toBe("world".length); // 5
});

test("parsePatchStats handles new + deleted files (path falls back to the --- side)", () => {
  const patch = [
    "diff --git a/b.txt b/b.txt",
    "new file mode 100644",
    "index 0000000..1234567",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1 @@",
    "+new",
    "diff --git a/c.txt b/c.txt",
    "deleted file mode 100644",
    "index 1234567..0000000",
    "--- a/c.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  const m = parsePatchStats(patch);
  expect(m.get("b.txt")).toEqual({ addedLines: 1, removedLines: 0, addedChars: 3, removedChars: 0 });
  // c.txt's new side is /dev/null, so the path comes from the "--- a/c.txt" header.
  expect(m.get("c.txt")).toEqual({ addedLines: 0, removedLines: 1, addedChars: 0, removedChars: 3 });
});

test("parsePatchStats treats in-hunk lines starting with --/++ as content, not headers", () => {
  // A removed "-- a comment" line renders as "--- a comment" and an added one as
  // "+++ more" — both must count as content because they're inside a hunk.
  const patch = [
    "diff --git a/q.sql b/q.sql",
    "--- a/q.sql",
    "+++ b/q.sql",
    "@@ -1,2 +1,2 @@",
    "-- old comment",
    "+- new comment",
    "@@ -10 +10 @@",
    "---",
    "+++",
    "",
  ].join("\n");
  const s = parsePatchStats(patch).get("q.sql")!;
  // removed: "-- old comment" and "---"; added: "+- new comment" and "+++"
  expect(s.removedLines).toBe(2);
  expect(s.addedLines).toBe(2);
  // Chars are intra-line: "old"→"new" is 3 each, "--"→"++" is 2 each. The shared "- " prefix
  // and " comment" suffix aren't charged to either side.
  expect(s.removedChars).toBe("old".length + "--".length);
  expect(s.addedChars).toBe("new".length + "++".length);
});

test("parsePatchStats ignores hunk headers and the no-newline marker", () => {
  const patch = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1 +1 @@",
    "-a",
    "+ab",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const s = parsePatchStats(patch).get("f")!;
  // "a" → "ab" appends one character; the shared "a" is charged to neither side.
  expect(s).toEqual({ addedLines: 1, removedLines: 1, addedChars: 1, removedChars: 0 });
});

test("parsePatchStats charges only the edited middle of a long line", () => {
  // The reported case: one character flipped on an 800-char JSON line used to read as
  // "+800 −800 characters" because both whole lines were charged.
  const long = (mid: string) => `  "_doc": "${"x".repeat(400)}${mid}${"y".repeat(400)}",`;
  const patch = [
    "diff --git a/p.json b/p.json",
    "--- a/p.json",
    "+++ b/p.json",
    "@@ -1 +1 @@",
    `-${long("—")}`,
    `+${long("-")}`,
    "",
  ].join("\n");
  const s = parsePatchStats(patch).get("p.json")!;
  expect(s).toEqual({ addedLines: 1, removedLines: 1, addedChars: 1, removedChars: 1 });
});

test("parsePatchStats charges unpaired lines in full", () => {
  // 1 removed, 3 added: the first added line pairs with it, the other two are genuinely new
  // text and must count every character.
  const patch = [
    "diff --git a/g b/g",
    "--- a/g",
    "+++ b/g",
    "@@ -1 +1,3 @@",
    "-alpha",
    "+alpaca",
    "+bravo",
    "+charlie",
    "",
  ].join("\n");
  const s = parsePatchStats(patch).get("g")!;
  expect(s.removedLines).toBe(1);
  expect(s.addedLines).toBe(3);
  // "alpha" → "alpaca": shared "alp" prefix and "a" suffix leave "h" vs "ac".
  expect(s.removedChars).toBe(1);
  expect(s.addedChars).toBe(2 + "bravo".length + "charlie".length);
});

test("streaming parser bounds a newline-free minified patch line", () => {
  const parser = createPatchStatParser();
  parser.push("diff --git a/min.json b/min.json\n--- a/min.json\n+++ b/min.json\n@@ -1 +1 @@\n-");
  const chunk = "x".repeat(128_000);
  const chunks = 32;
  for (let i = 0; i < chunks; i++) {
    parser.push(chunk);
    expect(parser.retainedChars()).toBeLessThanOrEqual(PATCH_LINE_BUFFER_CHARS);
  }
  parser.push("\n+");
  for (let i = 0; i < chunks; i++) {
    parser.push(chunk);
    expect(parser.retainedChars()).toBeLessThanOrEqual(PATCH_LINE_BUFFER_CHARS);
  }
  parser.push("\n");

  // The line count remains exact. Once a line crosses the memory bound, character stats
  // deliberately fall back to whole-line accounting instead of retaining both giant bodies.
  expect(parser.finish().get("min.json")).toEqual({
    addedLines: 1,
    removedLines: 1,
    addedChars: chunk.length * chunks,
    removedChars: chunk.length * chunks,
  });
});

// ── against a real repo ───────────────────────────────────────────────────────────

async function seedRepo(): Promise<string> {
  const dir = mkScratchDir("gm-diffstat-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  // Modify a tracked file and drop in an untracked one.
  writeFileSync(join(dir, "a.txt"), "hello\nthere\nyou\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  return dir;
}

test("computeDiffStats sums tracked edits + untracked files", async () => {
  const dir = await seedRepo();
  const { perFile, total } = await computeDiffStats(dir, ["b.txt"]);

  const a = perFile.get("a.txt")!;
  expect(a.addedLines).toBe(2);
  expect(a.removedLines).toBe(1);

  const b = perFile.get("b.txt")!;
  expect(b.addedLines).toBe(1); // untracked → all additions
  expect(b.removedLines).toBe(0);

  expect(total.addedLines).toBe(a.addedLines + b.addedLines);
  expect(total.removedLines).toBe(a.removedLines);
});

// ── past the old buffer caps ──────────────────────────────────────────────────────
// This used to concatenate the whole patch into one string behind a 5 MB cap, and to read
// untracked files behind a 1 MB-per-file / 2 MB-total cap. Every file past a cap simply got
// no stat — rendered as blank, indistinguishable from "unchanged". Counting is streamed now,
// so the assertions below are deliberately on the LAST file and on an untracked file that the
// old per-file cap would have skipped outright.
const BIG_FILES = 6;
const BIG_LINES = 5_000;
const UNTRACKED_LINES = 20_000;
/** A 99-character line; the modified copy appends one char, so every line reads as changed. */
const bigLine = (n: number) => `${String(n).padStart(6, "0")}${"x".repeat(93)}`;
const bigBody = (suffix: string) =>
  `${Array.from({ length: BIG_LINES }, (_, i) => bigLine(i) + suffix).join("\n")}\n`;

async function seedBigRepo(): Promise<string> {
  const dir = mkScratchDir("gm-diffstat-big-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  for (let f = 0; f < BIG_FILES; f++) writeFileSync(join(dir, `big${f}.txt`), bigBody(""));
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  for (let f = 0; f < BIG_FILES; f++) writeFileSync(join(dir, `big${f}.txt`), bigBody("!"));
  // ~2 MB — comfortably over the 1 MB single-file cap the untracked reader used to enforce.
  writeFileSync(
    join(dir, "untracked.txt"),
    `${Array.from({ length: UNTRACKED_LINES }, (_, i) => bigLine(i)).join("\n")}\n`,
  );
  return dir;
}

test("computeDiffStats counts every file of a multi-megabyte patch", async () => {
  const dir = await seedBigRepo();
  const { perFile, total, truncated } = await computeDiffStats(dir, ["untracked.txt"]);

  // 6 files × 5000 changed lines × ~100 chars × both sides ≈ 6 MB of patch text.
  expect(truncated).toBe(false);
  expect(perFile.size).toBe(BIG_FILES + 1);
  for (let f = 0; f < BIG_FILES; f++) {
    expect(perFile.get(`big${f}.txt`)).toEqual({
      addedLines: BIG_LINES,
      removedLines: BIG_LINES,
      addedChars: BIG_LINES, // every line pairs; each gained exactly the one "!"
      removedChars: 0,
    });
  }
  expect(perFile.get("untracked.txt")).toEqual({
    addedLines: UNTRACKED_LINES,
    removedLines: 0,
    addedChars: UNTRACKED_LINES * 100, // 99 content chars + the newline
    removedChars: 0,
  });
  expect(total.addedLines).toBe(BIG_FILES * BIG_LINES + UNTRACKED_LINES);
  expect(total.removedLines).toBe(BIG_FILES * BIG_LINES);
}, 60_000);

test.skipIf(process.platform !== "win32")(
  "repeated untracked-file stats keep native RSS bounded",
  async () => {
    // Production reproduction: pap3r has ~12k untracked paths. Bun.file().stream() retained a
    // native allocation per opened file, so every refresh permanently added ~220 MB even though
    // heapUsed stayed flat. Hundreds of moderate files reproduce that allocator leak quickly.
    const dir = mkScratchDir("gm-diffstat-rss-");
    await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
    await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
    const paths = Array.from({ length: 800 }, (_, i) => `generated-${i}.txt`);
    const body = `${"x".repeat(16_000)}\n`;
    for (const rel of paths) writeFileSync(join(dir, rel), body);

    await computeDiffStats(dir, paths); // warm the runtime/allocator before measuring
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let counted = 0;
    for (let i = 0; i < 6; i++) {
      counted += (await computeDiffStats(dir, paths)).perFile.size;
      Bun.gc(true);
    }
    const growth = process.memoryUsage().rss - before;

    expect(counted).toBe(paths.length * 6);
    expect(growth).toBeLessThan(96 * 1024 * 1024);
  },
  60_000,
);

test("readChanges attaches per-file stats only when asked", async () => {
  const dir = await seedRepo();

  const without = await readChanges(dir);
  expect(without.every((f) => f.stat === undefined)).toBe(true);

  const withStats = await readChanges(dir, true);
  const a = withStats.find((f) => f.path === "a.txt");
  const b = withStats.find((f) => f.path === "b.txt");
  expect(a?.stat?.addedLines).toBe(2);
  expect(b?.stat?.addedLines).toBe(1);
});

test("readStatus only computes the aggregate diff when withDiff is on", async () => {
  const dir = await seedRepo();

  const off = await readStatus(dir);
  expect(off.diff).toBeNull();

  const on = await readStatus(dir, true);
  expect(on.diff).not.toBeNull();
  expect(on.diff!.addedLines).toBeGreaterThan(0);
});

// ── settings route ──────────────────────────────────────────────────────────────

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("GET /api/status defaults diffStats to false; PUT /api/settings flips it", async () => {
  const app = createApp(localCfg());

  const before = await (await app.request("/api/status")).json();
  expect(before.diffStats).toBe(false);

  const put = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ diffStats: true }),
  });
  expect(put.status).toBe(200);
  expect((await put.json()).diffStats).toBe(true);

  const after = await (await app.request("/api/status")).json();
  expect(after.diffStats).toBe(true);

  // reset the process-global flag so it can't leak into other test files
  await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ diffStats: false }),
  });
});
