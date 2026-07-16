/**
 * Repo removal + rename: the two things the dashboard had no button for.
 *
 * The load-bearing property here is the TOMBSTONE. Removing an auto-discovered repo is only
 * meaningful if a later scan can't silently re-import it — without that, "Remove" deletes a row
 * that discovery puts straight back, which reads to the owner as a button that does nothing.
 * So these tests pin the choke-point behaviour (upsertRepo refuses an ignored path), not just
 * the happy-path delete.
 *
 * Rename is the mirror-image trap: `upsertRepo` overwrites `name` from the folder basename on
 * every scan, so a label stored in `name` would revert. It lives in `display_name`, and the
 * "survives a rescan" test below is the one that would catch a regression back to `name`.
 */
import { test, expect } from "bun:test";
import {
  upsertRepo,
  getRepo,
  getRepos,
  forgetRepo,
  isPathIgnored,
  listIgnoredPaths,
  unignorePath,
  setRepoDisplayName,
} from "../src/db.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

// ── removal ────────────────────────────────────────────────────────────────────────────

test("forgetRepo drops the row and tombstones the path so a rescan can't re-add it", () => {
  const dir = mkScratchDir("rm-tombstone-");
  const id = mustUpsertRepo(dir, "victim", "auto", false);
  expect(getRepo(id)).not.toBeNull();

  const removed = forgetRepo(id);
  expect(removed?.absPath).toBe(dir);
  expect(getRepo(id)).toBeNull();
  expect(isPathIgnored(dir)).toBe(true);

  // The whole point: discovery finds this folder again on the next sweep and must refuse it.
  expect(upsertRepo(dir, "victim", "auto", false)).toBeNull();
  expect(getRepos().some((r) => r.absPath === dir)).toBe(false);
});

test("forgetRepo(id, false) forgets the row WITHOUT tombstoning — a rescan may re-add it", () => {
  const dir = mkScratchDir("rm-keep-");
  const id = mustUpsertRepo(dir, "keeper", "auto", false);

  forgetRepo(id, false);
  expect(getRepo(id)).toBeNull();
  expect(isPathIgnored(dir)).toBe(false);

  // This variant is for "the folder is already gone" cleanup, where re-adding is correct if the
  // folder ever comes back.
  const reAdded = upsertRepo(dir, "keeper", "auto", false);
  expect(reAdded).not.toBeNull();
});

test("unignorePath lifts the tombstone and lets the path be imported again", () => {
  const dir = mkScratchDir("rm-restore-");
  const id = mustUpsertRepo(dir, "restore-me", "auto", false);
  forgetRepo(id);
  expect(upsertRepo(dir, "restore-me", "auto", false)).toBeNull();

  unignorePath(dir);
  expect(isPathIgnored(dir)).toBe(false);
  const back = upsertRepo(dir, "restore-me", "auto", false);
  expect(back).not.toBeNull();
  expect(getRepo(back!)?.absPath).toBe(dir);
});

test("listIgnoredPaths reports what the owner removed (the Settings undo surface)", () => {
  const dir = mkScratchDir("rm-list-");
  const id = mustUpsertRepo(dir, "listed", "auto", false);
  forgetRepo(id);

  const entry = listIgnoredPaths().find((p) => p.absPath === dir);
  expect(entry).toBeDefined();
  expect(entry!.name).toBe("listed");
  expect(entry!.ignoredAt).toBeGreaterThan(0);
});

test("forgetRepo on an unknown id is a no-op returning null (not a throw)", () => {
  expect(forgetRepo("no-such-repo-id")).toBeNull();
});

// ── rename ─────────────────────────────────────────────────────────────────────────────

test("a display label survives a rescan, which overwrites `name` from the folder basename", () => {
  const dir = mkScratchDir("rn-survives-");
  const id = mustUpsertRepo(dir, "folder-name", "auto", false);
  setRepoDisplayName(id, "My Nice Label");
  expect(getRepo(id)?.displayName).toBe("My Nice Label");

  // Exactly what a rescan does to this row.
  upsertRepo(dir, "folder-name", "auto", false);

  const after = getRepo(id);
  expect(after?.displayName).toBe("My Nice Label"); // the label is untouched…
  expect(after?.name).toBe("folder-name"); // …and `name` still tracks the folder
});

test("clearing a label falls back to the folder name; blank input clears rather than blanks", () => {
  const dir = mkScratchDir("rn-clear-");
  const id = mustUpsertRepo(dir, "on-disk", "auto", false);

  setRepoDisplayName(id, "temporary");
  expect(getRepo(id)?.displayName).toBe("temporary");

  setRepoDisplayName(id, null);
  expect(getRepo(id)?.displayName).toBeNull();

  // A whitespace-only label would otherwise render an empty, unclickable card title.
  setRepoDisplayName(id, "   ");
  expect(getRepo(id)?.displayName).toBeNull();
});

test("a label is trimmed, and `name` always stays the real folder basename", () => {
  const dir = mkScratchDir("rn-trim-");
  const id = mustUpsertRepo(dir, "real-folder", "auto", false);
  setRepoDisplayName(id, "  Padded Label  ");

  const repo = getRepo(id);
  expect(repo?.displayName).toBe("Padded Label");
  expect(repo?.name).toBe("real-folder"); // renaming NEVER touches the folder or its recorded name
});
