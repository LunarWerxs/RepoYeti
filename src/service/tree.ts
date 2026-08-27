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
import { gitFor, safeGitEnv } from "../git.ts";
import { readGate } from "../gitgate.ts";
import { normalizeRelPath, pathTouchesVcsMarker, pathWithin } from "../paths.ts";

/** One entry in a listed directory. */
export interface RepoTreeEntry {
  name: string;
  /** Repo-relative, forward slashes — the same path shape `/api/repos/:id/file` accepts. */
  path: string;
  type: "dir" | "file";
  /**
   * True when git is ignoring this path. Present only on directory listings (the panel dims
   * them, the way an editor's explorer does); absent on search results, where the default
   * already excludes ignored paths and the opt-in mode is explicitly asking for them.
   */
  ignored?: boolean;
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

/**
 * Which of `paths` git is ignoring, as a Set. Empty when there is no git to ask.
 *
 * `git check-ignore` is the only correct answer here: gitignore is not a glob list, it is
 * negations, nested .gitignore files, core.excludesFile and .git/info/exclude, evaluated in a
 * defined order. One process per directory listing, ~0.17s measured on a large repo, which is
 * why this marks a listing rather than being consulted per entry.
 *
 * Paths go in over stdin, NUL-separated, so neither a directory of 5,000 entries nor a filename
 * containing a space, a quote or a newline can break the call — as arguments, the first would
 * exceed the Windows command-line limit and the second would be re-split.
 */
async function ignoredAmong(absPath: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  try {
    return await readGate.run(async () => {
      const proc = Bun.spawn(["git", "check-ignore", "-z", "--stdin"], {
        cwd: absPath,
        env: safeGitEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      proc.stdin.write(paths.join("\0"));
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited; // exit 1 simply means "none of them are ignored"
      return new Set(out.split("\0").filter((p) => p !== ""));
    });
  } catch {
    return new Set(); // not a git working copy, or git refused — nothing gets dimmed
  }
}

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

  // Cap FIRST, then ask git about exactly the rows that ship. Marking the full set would pay for
  // up to 5,000 paths nobody will see, and the two lists must not be able to disagree.
  const truncated = entries.length > MAX_TREE_ENTRIES;
  const shipped = truncated ? entries.slice(0, MAX_TREE_ENTRIES) : entries;

  // What git is ignoring, so the panel can dim it the way an editor's explorer does.
  const ignored = await ignoredAmong(
    repo.absPath,
    shipped.map((e) => e.path),
  );
  for (const e of shipped) {
    if (ignored.has(e.path)) e.ignored = true;
  }

  if (truncated) {
    return { ok: true, code: "OK", path: clean, entries: shipped, total: entries.length, truncated: true };
  }
  return { ok: true, code: "OK", path: clean, entries: shipped, total: entries.length };
}

// ── search ───────────────────────────────────────────────────────────────────
// A filter over only the folders you already expanded would be worse than no search at all: it
// looks like it searched the repository and quietly didn't. So this searches the real tree.
//
// TWO PATHS, because the two questions have different right answers:
//   • ignored EXCLUDED (the default) — ask git. `ls-files --cached --others --exclude-standard`
//     is that question, and it is both exact and far cheaper than walking.
//   • ignored INCLUDED (opt-in) — walk the filesystem, because no index knows about the files
//     git was told to forget. The tree itself is unbounded (200,000+ files in this checkout), so
//     that walk is breadth-first and stopped by BOTH a result cap and a wall-clock budget, which
//     lets it end early without the top results changing.

export interface RepoTreeSearchResult {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  entries?: RepoTreeEntry[];
  /** True when the search stopped early (cap or time budget) — there may be more matches. */
  truncated?: boolean;
  /**
   * Whether ignored paths were actually searched. Usually just echoes the request, but a repo
   * with no git to ask (a Lore working copy) can only be walked, and a walk sees everything. The
   * client shows what really happened rather than what was asked for.
   */
  ignoredIncluded?: boolean;
}

/** Enough to choose from; far past the point where a longer query is the better move. */
export const MAX_TREE_SEARCH_RESULTS = 200;
/** Wall-clock ceiling for one search. A full walk of a big checkout is seconds; this keeps a
 *  keystroke's worth of work bounded even on a cold cache or a network share. */
export const TREE_SEARCH_BUDGET_MS = 3_000;
/** Don't walk on a near-empty needle — mirrors the changed-files content search's floor. */
export const MIN_TREE_SEARCH = 2;

/**
 * The non-ignored path set, straight from git, or null when this repo has no git to ask.
 *
 * `git ls-files --cached --others --exclude-standard` IS the question "what would I see if
 * .gitignore were respected", answered by the tool that owns the answer. One subprocess, and on
 * a large repo it is not close: 18,583 paths in 0.55s where walking the same checkout yields
 * 200,000+ in 4.5s. So the default search is both the cheaper one and the exact one — no
 * hand-rolled ignore matching to drift from git's real semantics (negations, nested .gitignore
 * files, core.excludesFile, .git/info/exclude).
 */
async function gitVisiblePaths(absPath: string): Promise<string[] | null> {
  try {
    // A git child, so it takes a read-gate slot like every other one. Called from an HTTP
    // request, so it rides the foreground lane (see src/gitgate.ts).
    const raw = await readGate.run(() =>
      gitFor(absPath).raw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    );
    return raw.split("\0").filter((p) => p !== "");
  } catch {
    return null; // not a git working copy (Lore), or git refused — caller falls back to walking
  }
}

/** Shallow paths first, then alphabetical: a capped answer should be the useful half. */
function compareByDepth(a: string, b: string): number {
  const da = a.split("/").length;
  const db = b.split("/").length;
  return da !== db ? da - db : a.localeCompare(b);
}

/** Fast path: search git's own file list rather than walking the filesystem. ls-files reports
 *  FILES; their ancestors are the directories, so those are derived too — otherwise searching
 *  "components" would find every file inside it but never the folder itself. */
function searchViaGitLsFiles(visible: string[], needle: string, marker: string): RepoTreeSearchResult {
  const dirs = new Set<string>();
  for (const p of visible) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const files = visible
    .filter((p) => p.toLowerCase().includes(needle) && !pathTouchesVcsMarker(p, marker))
    .sort(compareByDepth);
  const matchedDirs = [...dirs]
    .filter((p) => p.toLowerCase().includes(needle) && !pathTouchesVcsMarker(p, marker))
    .sort(compareByDepth);

  const all: RepoTreeEntry[] = [
    ...matchedDirs.map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, type: "dir" as const })),
    ...files.map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, type: "file" as const })),
  ];
  if (all.length > MAX_TREE_SEARCH_RESULTS) {
    return {
      ok: true,
      code: "OK",
      entries: all.slice(0, MAX_TREE_SEARCH_RESULTS),
      truncated: true,
      ignoredIncluded: false,
    };
  }
  return { ok: true, code: "OK", entries: all, truncated: false, ignoredIncluded: false };
}

/** Fallback when there's no git to ask (a Lore working copy): a bounded BFS of the filesystem
 *  itself. Always includes ignored paths — see `ignoredIncluded` on the result. */
async function searchViaFilesystemWalk(
  repo: { absPath: string },
  needle: string,
  marker: string,
): Promise<RepoTreeSearchResult> {
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

  // A walk sees everything on disk, so this branch always searched ignored paths — whether it
  // was asked to or only fell here because there was no git to ask.
  return { ok: true, code: "OK", entries, truncated, ignoredIncluded: true };
}

/**
 * Repo-relative paths matching `query` (literal, case-insensitive, matched against the whole
 * path so "src/api" works as well as "api"). Shallow matches first, and bounded; `truncated`
 * says the answer is a head rather than the whole set.
 *
 * By default this searches only what git would show you — `dist/` and `node_modules/` are
 * genuinely browsable in the tree, but a two-word query that returns four hundred vendored
 * `tsconfig.json`s is not a search result, it is a haystack. `includeIgnored` opts back in.
 *
 * The ignored-excluded path asks git and takes a read-gate slot; the include-ignored path walks
 * the filesystem itself and, like listRepoTree, stays outside the op queue and the gate.
 */
export async function searchRepoTree(
  repoId: string,
  query: string,
  opts: { includeIgnored?: boolean } = {},
): Promise<RepoTreeSearchResult> {
  const repo = getRepo(repoId);
  if (!repo) return { ok: false, code: "NOT_FOUND", message: "repo not found" };
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_TREE_SEARCH) return { ok: true, code: "OK", entries: [] };

  const marker = backendFor(repo.vcs).marker;

  if (!opts.includeIgnored) {
    const visible = await gitVisiblePaths(repo.absPath);
    if (visible) return searchViaGitLsFiles(visible, needle, marker);
    // No git to ask (a Lore working copy): fall through and walk. The result then includes
    // ignored paths, which is why the client is told what actually happened — see `ignoredIncluded`.
  }

  return searchViaFilesystemWalk(repo, needle, marker);
}
