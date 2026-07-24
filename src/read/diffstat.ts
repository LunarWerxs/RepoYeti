/**
 * Diff statistics — added/removed line + character counts, per file and aggregated.
 *
 * The header on every (even collapsed) repo card wants a *total* line delta, so the
 * aggregate has to ride RepoStatus (computed in status.ts, broadcast over SSE). Line
 * counts are cheap, but CHARACTER counts need the actual patch text — so the whole
 * feature is gated behind an owner setting (off by default; see `diffStatsEnabled`).
 * When off, neither status reads nor the changes endpoint pay any of this cost.
 *
 * A "modified" line shows in a unified diff as one `-` (old) plus one `+` (new), so a
 * single edit counts as 1 removed + 1 added line, and its old/new lengths as removed/
 * added characters. The net (added − removed) then reflects how much the file grew or
 * shrank — which is exactly the intuition behind "lines/characters changed".
 */
import { join } from "node:path";
import { safeGitEnv } from "../git.ts";
import { normalizeRelPath } from "../paths.ts";

export interface DiffStat {
  addedLines: number;
  removedLines: number;
  addedChars: number;
  removedChars: number;
}

export function emptyStat(): DiffStat {
  return { addedLines: 0, removedLines: 0, addedChars: 0, removedChars: 0 };
}

export function addStat(a: DiffStat, b: DiffStat): DiffStat {
  return {
    addedLines: a.addedLines + b.addedLines,
    removedLines: a.removedLines + b.removedLines,
    addedChars: a.addedChars + b.addedChars,
    removedChars: a.removedChars + b.removedChars,
  };
}

// ── runtime on/off flag (mirrors cfg.diffStats; set at boot + on the toggle route) ──
let _enabled = false;
export function diffStatsEnabled(): boolean {
  return _enabled;
}
export function setDiffStatsEnabled(value: boolean): void {
  _enabled = value;
}

// ── unified-diff parsing ────────────────────────────────────────────────────────

/** Decode git's C-style quoted path (`"a/sp ace\t.txt"`) back to a plain string. */
function unquotePath(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  try {
    return JSON.parse(s) as string; // handles the common \" \\ \t escapes
  } catch {
    return s.slice(1, -1); // best-effort: drop the quotes
  }
}

/** Turn a `--- a/path` / `+++ b/path` header value into a clean repo-relative path. */
function headerPath(raw: string): string | null {
  let s = raw.trim();
  const tab = s.indexOf("\t"); // git may append a tab + timestamp
  if (tab >= 0) s = s.slice(0, tab);
  s = unquotePath(s);
  if (s === "/dev/null") return null;
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return normalizeRelPath(s);
}

/**
 * Parse a unified diff patch into per-file stats. Counts content lines only: `+`/`-`
 * lines that aren't the `+++`/`---` file headers, ignoring hunk headers (`@@`) and the
 * "\ No newline at end of file" marker. The path is taken from the `+++ b/…` header
 * (falling back to `--- a/…` for deletions, where the new side is /dev/null).
 */
export function parsePatchStats(patch: string): Map<string, DiffStat> {
  const out = new Map<string, DiffStat>();
  let minusPath: string | null = null;
  let cur: DiffStat | null = null;
  // The `---`/`+++` file headers only appear before a file's first `@@` hunk. Once we're
  // inside a hunk, every `+`/`-` is content — including a line whose text itself starts
  // with `--`/`++` (e.g. a `--` comment or a `---` rule), which would otherwise be misread
  // as a header. Tracking the hunk boundary removes that ambiguity.
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      minusPath = null;
      cur = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) {
      minusPath = headerPath(line.slice(4));
    } else if (!inHunk && line.startsWith("+++ ")) {
      const p = headerPath(line.slice(4)) ?? minusPath;
      if (p) {
        cur = out.get(p) ?? emptyStat();
        out.set(p, cur);
      }
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (cur && inHunk && !line.startsWith("\\")) {
      if (line.startsWith("+")) {
        cur.addedLines++;
        cur.addedChars += line.length - 1;
      } else if (line.startsWith("-")) {
        cur.removedLines++;
        cur.removedChars += line.length - 1;
      }
    }
  }
  return out;
}

/** An untracked file contributes its whole content as additions (nothing removed). */
function countAddedText(content: string): DiffStat {
  const s = emptyStat();
  if (content === "") return s;
  s.addedChars = content.length;
  s.addedLines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return s;
}

// ── bounded git diff runner ───────────────────────────────────────────────────────
// Mirrors git-actions.boundedGit: stream stdout, stop + kill at the cap so a giant diff
// can't blow up memory or block the per-repo queue. Read-only; daemon-safe env.
const DIFF_CAP_BYTES = 5_000_000; // generous — real dirty trees almost never exceed this
const DIFF_TIMEOUT_MS = 30_000;
const UNTRACKED_TOTAL_CAP = 2_000_000; // total bytes read across all untracked files
const UNTRACKED_FILE_CAP = 1_000_000; // skip any single untracked file larger than this

async function runGitCapped(absPath: string, args: string[], cap: number): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: absPath,
    env: safeGitEnv(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const killTimer = setTimeout(() => proc.kill(), DIFF_TIMEOUT_MS);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  try {
    while (out.length < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    if (out.length > cap) out = out.slice(0, cap);
  } catch {
    /* child killed or stream errored — keep whatever we read */
  } finally {
    clearTimeout(killTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** A NUL byte in the head of the file is the cheap, git-style "this is binary" signal. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Compute per-file + aggregate diff stats for a repo's working tree vs HEAD.
 *
 * MUST be called from inside an existing readGate slot (status.ts holds one): it spawns
 * its own `git diff` directly rather than taking another gate, so it never nests/deadlocks
 * the read pool. Tracked changes come from `git diff HEAD` (rename-aware, `-M`); untracked
 * files (passed in from the porcelain status) are read off disk and counted as additions.
 * On an unborn HEAD the diff is empty and only untracked files contribute — acceptable for
 * a brand-new repo. Binary/oversized untracked files are skipped, not counted.
 */
export async function computeDiffStats(
  absPath: string,
  untrackedPaths: string[],
): Promise<{ perFile: Map<string, DiffStat>; total: DiffStat }> {
  const patch = await runGitCapped(
    absPath,
    ["diff", "HEAD", "-M", "--no-color", "--no-ext-diff"],
    DIFF_CAP_BYTES,
  );
  const perFile = parsePatchStats(patch);

  let budget = UNTRACKED_TOTAL_CAP;
  for (const rel of untrackedPaths) {
    if (budget <= 0) break;
    try {
      const file = Bun.file(join(absPath, rel));
      if (!(await file.exists())) continue;
      const size = file.size;
      if (size > UNTRACKED_FILE_CAP) continue;
      const slice = size > budget ? file.slice(0, budget) : file;
      const bytes = new Uint8Array(await slice.arrayBuffer());
      budget -= bytes.length;
      if (looksBinary(bytes)) continue;
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      perFile.set(normalizeRelPath(rel), countAddedText(content));
    } catch {
      /* unreadable (gone, permissions, a directory entry) — skip it */
    }
  }

  let total = emptyStat();
  for (const s of perFile.values()) total = addStat(total, s);
  return { perFile, total };
}
