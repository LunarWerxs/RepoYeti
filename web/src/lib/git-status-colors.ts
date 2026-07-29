/**
 * VS Code-style git-status colours for the one-letter M/A/N/D/R/C badges — the single shared map
 * (ChangesTree, FileViewerInner, LogPanel, SmartCommitCommitDiff all render the same letters, and
 * per-component copies had already drifted once).
 *
 * Untracked is "N" (new), not VS Code's "U": sitting next to "M" for modified, a "U" badge reads
 * as "updated", which is the opposite of what it means. Commit-side letters come straight from
 * git's name-status and never include it.
 */
export const STATUS_COLOR: Record<string, string> = {
  M: "#e2c08d", // modified
  A: "#73c991", // added (staged)
  N: "#73c991", // new — untracked, git has never seen this path
  D: "#f14c4c", // deleted
  R: "#6cb6ff", // renamed
  C: "#d18616", // copied/conflicted
};

/** Colour for a status letter, falling back to a neutral grey for anything unknown/absent. */
export const statusColor = (s?: string): string => (s ? (STATUS_COLOR[s] ?? "#9aa0a6") : "#9aa0a6");

// ── merge conflicts ───────────────────────────────────────────────────────────
// A conflicted file used to render as a bare orange "C", which says a conflict exists but not
// what KIND — and "both of us edited this" and "they deleted the file you were editing" need
// completely different responses from the owner. Worse, once a conflict was staged (resolved)
// the file silently reverted to a plain "M", so a half-finished merge was indistinguishable from
// ordinary edits and it was easy to commit a merge with conflicts still outstanding.

/** Green — this one is DONE, and the point of showing it is that it no longer needs attention. */
export const RESOLVED_COLOR = "#73c991";
