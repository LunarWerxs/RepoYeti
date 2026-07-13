/**
 * Temp-path import guard (owner directive): "a repository whose absolute path is under the OS
 * temp directory must never be imported into RepoYeti, by any path." Covers:
 *   - isUnderTempDir (src/paths.ts): the predicate itself, incl. the boundary case and a custom
 *     TEMP/TMP override.
 *   - upsertRepo (src/db.ts): the single write choke point refuses a temp path (returns null,
 *     inserts nothing) while a normal path still inserts.
 *   - registerRepo (src/service/repo-mgmt.ts): the manual "Point to Folder" pin surfaces the
 *     refusal as an ok:false RepoMutation instead of throwing or silently succeeding.
 *   - pruneTempRepos (src/db.ts): the startup repair migration removes existing temp-path rows
 *     (even ones whose folder still exists) and leaves normal rows alone.
 *
 * The rest of the suite fabricates its scratch git repos under tests/helpers/scratch.ts's
 * repo-local root (NOT the OS temp dir; see that file's doc comment) precisely so upsertRepo's
 * guard never fires on them. This file is the one place that deliberately points at (or
 * overrides) a real temp root, to prove the guard actually fires there.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isUnderTempDir } from "../src/paths.ts";
import { upsertRepo, getRepo, getRepos, pruneTempRepos } from "../src/db.ts";
import { registerRepo } from "../src/service/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// ── isUnderTempDir ────────────────────────────────────────────────────────────────────────

test("isUnderTempDir matches the OS temp root itself and anything nested inside it", () => {
  const root = tmpdir();
  expect(isUnderTempDir(root)).toBe(true);
  expect(isUnderTempDir(join(root, "gm-probe-1"))).toBe(true);
  expect(isUnderTempDir(join(root, "nested", "deeper", "repo"))).toBe(true);
});

test("isUnderTempDir does NOT match a sibling directory that merely shares a string prefix", () => {
  const root = tmpdir();
  // Siblings of the temp root with the SAME parent, whose name starts with the temp root's own
  // basename: the classic "C:\Temp" vs "C:\Temperature" / "C:\Temp2" false-positive trap that a
  // naive `startsWith` check would fall into. Segment-boundary-aware containment must reject both.
  const siblingA = `${root}2`;
  const siblingB = `${root}erature`;
  expect(isUnderTempDir(siblingA)).toBe(false);
  expect(isUnderTempDir(siblingB)).toBe(false);
});

test("isUnderTempDir honors a custom TEMP/TMP override, restored after the test", () => {
  const prevTemp = process.env.TEMP;
  const prevTmp = process.env.TMP;
  try {
    const customRoot = mkdtempSync(join(tmpdir(), "gm-customtemp-"));
    // Point TEMP/TMP somewhere that ISN'T the current os.tmpdir() result at all (a fresh sibling
    // dir under it), so this only passes if isUnderTempDir actually reads the env var, not just
    // falling back to a cached os.tmpdir() value from before the override.
    const overrideRoot = mkdtempSync(join(customRoot, "override-"));
    process.env.TEMP = overrideRoot;
    process.env.TMP = overrideRoot;
    expect(isUnderTempDir(join(overrideRoot, "some-repo"))).toBe(true);
  } finally {
    process.env.TEMP = prevTemp;
    process.env.TMP = prevTmp;
  }
});

test("isUnderTempDir is case-insensitive on win32", () => {
  if (process.platform !== "win32") return;
  const root = tmpdir();
  expect(isUnderTempDir(join(root.toUpperCase(), "repo"))).toBe(true);
  expect(isUnderTempDir(join(root.toLowerCase(), "repo"))).toBe(true);
});

// ── upsertRepo refuses a temp path ────────────────────────────────────────────────────────

test("upsertRepo refuses a path under os.tmpdir(): returns null and inserts nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-guard-refuse-"));
  const id = upsertRepo(dir, "guard-refuse", "auto", false);
  expect(id).toBeNull();
  // Not just a null id: genuinely never wrote a row. No repo in the live DB has this abs path.
  expect(getRepos().some((r) => r.absPath === dir)).toBe(false);
});

test("upsertRepo still inserts a normal (non-temp) path", () => {
  // A repo directory that is NOT under any temp root: the shared repo-local scratch root (see
  // tests/helpers/scratch.ts), which every other test in the suite already relies on being
  // outside the guard's reach.
  const dir = mkScratchDir("guard-normal-");
  const id = upsertRepo(dir, "guard-normal", "auto", false);
  expect(id).not.toBeNull();
  expect(getRepo(id!)?.absPath).toBe(dir);
});

test("upsertRepo's temp-path refusal does not throw (non-throwing by design)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-guard-nothrow-"));
  expect(() => upsertRepo(dir, "guard-nothrow", "auto", false)).not.toThrow();
});

// ── registerRepo (manual "Point to Folder" pin) surfaces the refusal ────────────────────────

test("registerRepo refuses to pin a folder under the OS temp dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-guard-register-"));
  mkdirSync(join(dir, ".git"), { recursive: true }); // looks like a real git repo on disk

  const result = await registerRepo(dir);

  expect(result.ok).toBe(false);
  expect(result.code).toBe("TEMP_PATH_REFUSED");
  expect(result.message).toContain("temporary directory");
  expect(result.repo).toBeUndefined();
});

test("registerRepo still pins a normal (non-temp) folder", async () => {
  const dir = mkScratchDir("guard-register-ok-");
  mkdirSync(join(dir, ".git"), { recursive: true });

  const result = await registerRepo(dir);

  expect(result.ok).toBe(true);
  expect(result.repo?.absPath).toBe(resolve(dir));
});

// ── pruneTempRepos (startup repair migration) ────────────────────────────────────────────

/** A scratch DB with the same `repos` shape initDb() creates, for exercising pruneTempRepos in
 *  isolation (mirrors tests/identity-hygiene.test.ts's scratchPreMigrationDb pattern). */
function scratchReposDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "repoyeti-prune-scratch-"));
  const handle = new Database(join(dir, "scratch.db"), { create: true });
  handle.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY, abs_path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto', vcs TEXT NOT NULL DEFAULT 'git',
      is_submodule INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
  `);
  return handle;
}

test("pruneTempRepos removes seeded temp-path rows, including one whose folder still exists on disk", () => {
  const handle = scratchReposDb();
  const insert = handle.query(
    `INSERT INTO repos (id, abs_path, name, updated_at) VALUES (?, ?, ?, ?)`,
  );

  // A temp-path row whose folder is long gone (the historic-junk-row shape: %TEMP%\gm-*).
  insert.run("junk-1", join(tmpdir(), "gm-junk-does-not-exist-12345"), "gm-junk-1", Date.now());

  // A temp-path row whose folder DOES still exist: pruneTempRepos must remove this too (distinct
  // from cleanupMissingRepos, which is existence-based; this guard is path-based).
  const stillThere = mkdtempSync(join(tmpdir(), "gm-junk-exists-"));
  insert.run("junk-2", stillThere, "gm-junk-2", Date.now());

  // A normal (non-temp) row that must survive untouched.
  const normalDir = mkScratchDir("prune-normal-");
  insert.run("keep-1", normalDir, "keep-1", Date.now());

  const removed = pruneTempRepos(handle);
  expect(removed).toBe(2);

  const remaining = handle.query(`SELECT id FROM repos ORDER BY id`).all() as { id: string }[];
  expect(remaining.map((r) => r.id)).toEqual(["keep-1"]);

  rmSync(stillThere, { recursive: true, force: true });
});

test("pruneTempRepos is idempotent: a clean DB (no temp-path rows) deletes nothing", () => {
  const handle = scratchReposDb();
  const normalDir = mkScratchDir("prune-clean-");
  handle
    .query(`INSERT INTO repos (id, abs_path, name, updated_at) VALUES (?, ?, ?, ?)`)
    .run("clean-1", normalDir, "clean-1", Date.now());

  const first = pruneTempRepos(handle);
  expect(first).toBe(0);
  const second = pruneTempRepos(handle);
  expect(second).toBe(0);
  expect((handle.query(`SELECT COUNT(*) AS n FROM repos`).get() as { n: number }).n).toBe(1);
});
