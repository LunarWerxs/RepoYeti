import type { DiffStat } from "@/types";

/** True when a stat carries any non-zero delta worth rendering. */
export function hasStat(s?: DiffStat | null): s is DiffStat {
  return (
    !!s && (s.addedLines > 0 || s.removedLines > 0 || s.addedChars > 0 || s.removedChars > 0)
  );
}

/** Group-separated number (e.g. 1,234) for the larger character counts. */
export function fmtCount(n: number): string {
  return n.toLocaleString();
}
