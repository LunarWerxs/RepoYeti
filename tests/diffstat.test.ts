import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { parsePatchStats, computeDiffStats } from "../src/read/diffstat.ts";
import { readStatus, readChanges } from "../src/read/status.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

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
  expect(s.removedChars).toBe("- old comment".length + "--".length);
  expect(s.addedChars).toBe("- new comment".length + "++".length);
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
  expect(s).toEqual({ addedLines: 1, removedLines: 1, addedChars: 2, removedChars: 1 });
});

// ── against a real repo ───────────────────────────────────────────────────────────

async function seedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-diffstat-"));
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
