// Lightweight, dependency-free diff-rendering model for the Smart Commit *combined* per-commit
// review — turns a file's daemon FileDiff (either whole-file "models" original+modified, or a
// git "patch" for large files) into a flat list of colourised rows the UI can stack cheaply.
//
// Why not Monaco here: the combined view shows EVERY file in a commit at once, so it must stay
// light (one Monaco per file would be many heavyweight editors). Single-file review still uses
// the rich Monaco viewer (SmartCommitFileDiff); this is the "scan the whole commit" companion.
// All cases fall out of the existing per-file diff endpoint: new files arrive as models with an
// empty original (→ all additions), deletions as an empty modified, large files as a patch.

export interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  /** meta only: a run of N unchanged lines was elided here (the UI renders a translated marker). */
  collapsed?: number;
}

/** Above this many lines on either side we don't line-diff in the browser (the LCS below is
 *  O(n·m) space). The caller shows a "open the file for its full diff" note and the rich Monaco
 *  viewer handles those. In practice the daemon already ships big MODIFIED files as a patch, so
 *  this only guards a pathologically large newly-added / deleted file. */
export const MAX_MODELS_LINES = 1200;

/** Split text into lines, dropping a single trailing newline so a file doesn't render a phantom
 *  blank last line. Empty string → no lines (an added file's empty original, etc.). */
function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\n$/, "").split(/\r?\n/);
}

/**
 * Parse a unified `git diff` patch (already hunk-collapsed by git's default context) into rows.
 * File-header / index / rename noise is dropped; `@@` hunk headers are kept as meta; the leading
 * +/‑/space marker classifies each line and is stripped from the text.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("\\") // "\ No newline at end of file"
    ) {
      continue;
    }
    if (line.startsWith("@@")) rows.push({ kind: "meta", text: line });
    else if (line.startsWith("Binary files")) rows.push({ kind: "meta", text: line });
    else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1) });
    // anything else (stray blank line between files, etc.) is ignored
  }
  return rows;
}

/**
 * Longest-common-subsequence line diff of two whole files (models mode). Returns null when either
 * side exceeds MAX_MODELS_LINES — too big to diff cheaply in the browser. Not yet context-collapsed
 * (see collapseContext); a caller wanting a compact view runs both.
 */
export function diffModels(original: string, modified: string): DiffRow[] | null {
  const a = splitLines(original);
  const b = splitLines(modified);
  const n = a.length;
  const m = b.length;
  if (n > MAX_MODELS_LINES || m > MAX_MODELS_LINES) return null;

  // dp[i][j] = LCS length of a[i:] and b[j:]. Filled bottom-up; Int32Array keeps it compact.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const di = dp[i]!;
    const di1 = dp[i + 1]!;
    const ai = a[i]!;
    for (let j = m - 1; j >= 0; j--) {
      di[j] = ai === b[j]! ? di1[j + 1]! + 1 : Math.max(di1[j]!, di[j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++]! });
  while (j < m) rows.push({ kind: "add", text: b[j++]! });
  return rows;
}

/**
 * Collapse long runs of unchanged context down to `context` lines on each side of a change; the
 * elided middle becomes a single meta row carrying the hidden-line count (GitHub-style folding).
 * Meta rows are always kept.
 */
export function collapseContext(rows: DiffRow[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "meta") {
      keep[i] = true;
    } else if (r.kind === "add" || r.kind === "del") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(rows.length - 1, i + context);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }
  const out: DiffRow[] = [];
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (run > 0) {
        out.push({ kind: "meta", text: "", collapsed: run });
        run = 0;
      }
      out.push(rows[i]!);
    } else {
      run++;
    }
  }
  if (run > 0) out.push({ kind: "meta", text: "", collapsed: run });
  return out;
}

/** The subset of the daemon's FileDiff this module needs. */
export interface FileDiffLike {
  mode?: "models" | "patch";
  original?: string;
  modified?: string;
  patch?: string;
  binary?: boolean;
}

export interface RenderedDiff {
  rows: DiffRow[];
  /** Binary file — no textual diff to show. */
  binary: boolean;
  /** A models-mode file too large to line-diff in the browser (open it in the full viewer). */
  tooLarge: boolean;
}

/**
 * Turn a file's diff into render-ready, context-collapsed rows. Patch mode is already hunked by
 * git, so it's parsed as-is; models mode is line-diffed then collapsed. Binary / oversized files
 * report a flag instead of rows so the UI can point at the rich single-file viewer.
 */
export function renderFileDiff(d: FileDiffLike): RenderedDiff {
  if (d.binary) return { rows: [], binary: true, tooLarge: false };
  if (d.mode === "patch") return { rows: parsePatch(d.patch ?? ""), binary: false, tooLarge: false };
  const raw = diffModels(d.original ?? "", d.modified ?? "");
  if (raw === null) return { rows: [], binary: false, tooLarge: true };
  return { rows: collapseContext(raw), binary: false, tooLarge: false };
}

/** One file's slice of a multi-file `git show`/`git diff` patch. */
export interface ParsedFile {
  /** New path (the `b/…` side); the old path for a pure deletion. */
  path: string;
  /** Old path — present only for a rename/copy (when it differs from `path`). */
  oldPath?: string;
  /** Binary file — no textual rows. */
  binary: boolean;
  /** Added / removed line counts (for the "+N −N" stat). */
  adds: number;
  dels: number;
  /** Colourised rows (via parsePatch), ready to render. */
  rows: DiffRow[];
}

/**
 * Split a multi-file unified diff — one big `git show -p` string, as the commit-detail endpoint
 * returns — into per-file slices, each already parsed into render-ready rows + an add/del stat.
 * Files are delimited by their `diff --git a/<old> b/<new>` header. A trailing "…[truncated]"
 * marker (the daemon caps huge commits) just means the last file's rows are partial — still valid.
 */
export function splitUnifiedDiff(diff: string): ParsedFile[] {
  if (!diff.trim()) return [];
  const out: ParsedFile[] = [];
  for (const block of diff.split(/\r?\n(?=diff --git )/)) {
    if (!block.startsWith("diff --git")) continue;
    const nl = block.indexOf("\n");
    const header = nl === -1 ? block : block.slice(0, nl);
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    const oldPath = m?.[1];
    const path = m?.[2] ?? oldPath ?? "";
    const rows = parsePatch(block);
    let adds = 0;
    let dels = 0;
    let binary = false;
    for (const r of rows) {
      if (r.kind === "add") adds++;
      else if (r.kind === "del") dels++;
      else if (r.kind === "meta" && r.text.startsWith("Binary files")) binary = true;
    }
    out.push({ path, oldPath: oldPath && oldPath !== path ? oldPath : undefined, binary, adds, dels, rows });
  }
  return out;
}
