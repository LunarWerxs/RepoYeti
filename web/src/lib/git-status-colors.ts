/**
 * VS Code-style git-status colours for the one-letter M/A/U/D/R/C badges — the single shared map
 * (ChangesTree, FileViewerInner, LogPanel, SmartCommitCommitDiff all render the same letters, and
 * per-component copies had already drifted once).
 */
export const STATUS_COLOR: Record<string, string> = {
  M: "#e2c08d", // modified
  A: "#73c991", // added
  U: "#73c991", // untracked
  D: "#f14c4c", // deleted
  R: "#6cb6ff", // renamed
  C: "#d18616", // copied/conflicted
};

/** Colour for a status letter, falling back to a neutral grey for anything unknown/absent. */
export const statusColor = (s?: string): string => (s ? (STATUS_COLOR[s] ?? "#9aa0a6") : "#9aa0a6");
