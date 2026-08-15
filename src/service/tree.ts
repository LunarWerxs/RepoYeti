/**
 * Working-directory browsing: list ONE directory level of a repo, on demand.
 *
 * This backs the file panel's "All files" mode, which shows the whole repository rather than
 * only the changed files. It is deliberately one level per call, not a recursive listing.
 *
 * WHY LAZY. "All files" means everything on disk, ignored paths included — that is the point of
 * the mode (a `dist/` or a vendored bundle you need to open is exactly what `git ls-files` hides).
 * But a full walk of a working repo is not a bounded thing: this project's own checkout holds
 * over 200,000 files once `node_modules` is counted, takes seconds of disk I/O to enumerate, and
 * would ship a multi-megabyte payload the browser then has to turn into 200,000 tree nodes. One
 * directory is ~1 ms and a few dozen entries. So the tree fetches a folder's children the moment
 * that folder is opened, and never walks what nobody looked at — which is also why the mode can
 * afford to include ignored paths at all.
 *
 * Deliberately NOT behind the per-repo op queue or the git read gate (see gitgate.ts): this
 * spawns no git child and touches no index, so queueing it behind a fetch would reintroduce
 * exactly the stall the gate's foreground lane exists to remove. It is pure `readdir`.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepo } from "../db.ts";
import { backendFor } from "../vcs/index.ts";
import { normalizeRelPath, pathTouchesVcsMarker, pathWithin } from "../paths.ts";

/** One entry in a listed directory. */
export interface RepoTreeEntry {
  name: string;
  /** Repo-relative, forward slashes — the same path shape `/api/repos/:id/file` accepts. */
  path: string;
  type: "dir" | "file";
}

export interface RepoTreeResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  /** The directory that was listed ("" = repo root). */
  path?: string;
  entries?: RepoTreeEntry[];
  /** Entry count before the cap (present only when `truncated`). */
  total?: number;
  /** True when `entries` was capped at MAX_TREE_ENTRIES. */
  truncated?: boolean;
}

/**
 * Cap on ONE directory's listing. Generated trees really do produce single folders with tens of
 * thousands of siblings, and a flat run of those is unusable in the panel and slow to render.
 * Far above any hand-authored directory, so a real source folder is never clipped.
 */
export const MAX_TREE_ENTRIES = 5_000;

/** Directories first, then files; each case-insensitive alphabetical, with a case-sensitive
 *  tiebreak so the order is total (two names differing only in case must not compare equal). */
function compareEntries(a: RepoTreeEntry, b: RepoTreeEntry): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return lower !== 0 ? lower : a.name.localeCompare(b.name);
}

/**
 * List one directory inside a repo's working tree.
 *
 * `relPath` is repo-relative; "" (or absent) lists the repo root. Untrusted-path safe in the
 * same way as the file reader: normalised, confined to the repo, and refusing the VCS metadata
 * directory. Symlinks are reported as files and never descended — `Dirent.isDirectory()` is
 * false for a symlink, so a link pointing at an ancestor cannot make the tree infinite.
 */
export async function listRepoTree(repoId: string, relPath = ""): Promise<RepoTreeResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };

  // Root is the one legitimate empty path, so it can't go through resolveRepoPath (which
  // requires a non-empty path — every other caller is addressing a specific file).
  const clean = normalizeRelPath(relPath);
  const marker = backendFor(repo.vcs).marker;
  if (clean && pathTouchesVcsMarker(clean, marker)) {
    return { ok: false, code: "ERROR", message: `refusing to list inside ${marker}` };
  }
  const abs = clean ? resolve(repo.absPath, clean) : resolve(repo.absPath);
  if (!pathWithin(repo.absPath, abs)) {
    return { ok: false, code: "ERROR", message: "path escapes the repository" };
  }

  try {
    // Reject a non-directory explicitly rather than letting readdir's ENOTDIR surface as a
    // generic error — the client shows this verbatim.
    const info = await stat(abs);
    if (!info.isDirectory()) return { ok: false, code: "ERROR", message: "not a directory" };
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "directory not found" };
  }

  let dirents: Dirent[];
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }

  const entries: RepoTreeEntry[] = [];
  for (const d of dirents) {
    // The repo's own bookkeeping is never browsable — same boundary the read/write/move routes
    // apply. Checked per ENTRY (not just on the requested path) so it can't be reached by
    // opening the root and clicking down.
    if (pathTouchesVcsMarker(d.name, marker)) continue;
    entries.push({
      name: d.name,
      path: clean ? `${clean}/${d.name}` : d.name,
      type: d.isDirectory() ? "dir" : "file",
    });
  }
  entries.sort(compareEntries);

  if (entries.length > MAX_TREE_ENTRIES) {
    return {
      ok: true,
      code: "OK",
      path: clean,
      entries: entries.slice(0, MAX_TREE_ENTRIES),
      total: entries.length,
      truncated: true,
    };
  }
  return { ok: true, code: "OK", path: clean, entries, total: entries.length };
}

// ── search ───────────────────────────────────────────────────────────────────
// A filter over only the folders you already expanded would be worse than no search at all: it
// looks like it searched the repository and quietly didn't. So this walks the real tree.
//
// Which means it must be bounded on BOTH axes, because the tree is not: 200,000+ files here.
// Breadth-first, so shallow matches (nearly always the wanted ones) are found before the walk
// reaches a vendored dependency tree, and both a result cap and a wall-clock budget can stop it
// early without the top results changing.

export interface RepoTreeSearchResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  entries?: RepoTreeEntry[];
  /** True when the walk stopped early (cap or time budget) — there may be more matches. */
  truncated?: boolean;
}

/** Enough to choose from; far past the point where a longer query is the better move. */
export const MAX_TREE_SEARCH_RESULTS = 200;
/** Wall-clock ceiling for one search. A full walk of a big checkout is seconds; this keeps a
 *  keystroke's worth of work bounded even on a cold cache or a network share. */
export const TREE_SEARCH_BUDGET_MS = 3_000;
/** Don't walk on a near-empty needle — mirrors the changed-files content search's floor. */
export const MIN_TREE_SEARCH = 2;

/**
 * Repo-relative paths matching `query` (literal, case-insensitive, matched against the whole
 * path so "src/api" works as well as "api"). Breadth-first and bounded; `truncated` says the
 * answer is a head rather than the whole set.
 *
 * Like listRepoTree, deliberately outside the op queue and the git read gate: no git child is
 * spawned and no index is touched.
 */
export async function searchRepoTree(repoId: string, query: string): Promise<RepoTreeSearchResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_TREE_SEARCH) return { ok: true, code: "OK", entries: [] };

  const marker = backendFor(repo.vcs).marker;
  const deadline = Date.now() + TREE_SEARCH_BUDGET_MS;
  const entries: RepoTreeEntry[] = [];
  let truncated = false;

  // BFS frontier of repo-relative directory paths ("" = root).
  const frontier: string[] = [""];
  let head = 0;
  while (head < frontier.length) {
    if (entries.length >= MAX_TREE_SEARCH_RESULTS || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const dir = frontier[head++]!;
    let dirents: Dirent[];
    try {
      dirents = await readdir(resolve(repo.absPath, dir), { withFileTypes: true });
    } catch {
      continue; // permission denied / vanished mid-walk — skip it, don't fail the search
    }
    for (const d of dirents) {
      if (pathTouchesVcsMarker(d.name, marker)) continue;
      const path = dir ? `${dir}/${d.name}` : d.name;
      const isDir = d.isDirectory(); // false for a symlink, so links are never descended
      if (path.toLowerCase().includes(needle)) {
        if (entries.length >= MAX_TREE_SEARCH_RESULTS) {
          truncated = true;
          break;
        }
        entries.push({ name: d.name, path, type: isDir ? "dir" : "file" });
      }
      if (isDir) frontier.push(path);
    }
  }

  return { ok: true, code: "OK", entries, truncated };
}
