/** Group-separated number (e.g. 1,234) for the larger character counts. */
export function fmtCount(n: number): string {
  return n.toLocaleString();
}

/** Compact count so a narrow column can't blow out: 1234 → "1.2k", 20500 → "21k". */
export function compactN(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

// ── proportional change bars ──────────────────────────────────────────────────
// The GitKraken-style bar the History panel has always drawn, extracted here so the work-tree
// changed-files list can render exactly the same thing (the owner asked for the History "visual
// bars" option in the Changes view too, and two copies of a scaling formula is how the status
// colours drifted once already). Pure functions of numbers — no LogEntry, no DiffStat, so both
// a commit-level total and a single file's delta feed them unchanged.

/** Total lines touched. The bar's LENGTH encodes this; its SPLIT encodes added vs removed. */
export const churn = (added: number, removed: number): number => added + removed;

/**
 * Bar length as a CSS width, square-root-scaled against the largest churn in the same list.
 *
 * Linear scaling is unusable in practice: one generated-file commit (or one lockfile in the work
 * tree) is routinely 100× the median, which flattens every other bar to an invisible sliver.
 * Square root compresses that range while keeping the ordering honest. The 7% floor means a
 * one-line change still draws something rather than nothing.
 *
 * Clamped at 100 as well as floored at 7. `max` comes from the caller's own list, so a row can
 * legitimately arrive with total > max: the History panel's window is capped at 500 retained
 * commits, and the changed-files list is refreshed independently of the stat that scales it — a
 * stale max was measured producing a 224% width. The track is overflow-hidden so that clipped
 * rather than visibly broke, which is exactly why it would have gone unnoticed.
 */
export function barWidth(total: number, max: number): string {
  if (!total) return "0%";
  return `${Math.min(100, Math.max(7, Math.sqrt(total / Math.max(1, max)) * 100))}%`;
}

/** One side's share of the bar, as a CSS width. */
export function barShare(added: number, removed: number, kind: "added" | "removed"): string {
  const total = churn(added, removed);
  if (!total) return "0%";
  return `${((kind === "added" ? added : removed) / total) * 100}%`;
}
