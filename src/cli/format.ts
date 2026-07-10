/**
 * Zero-dependency terminal output helpers for the CLI git verbs: a tiny column/table
 * printer and a handful of ANSI colour functions. Kept deliberately small — these only
 * exist so `repoyeti repos`/`log`/`branches`/… render as readable columns instead of raw
 * JSON. Colour is suppressed when NO_COLOR is set (https://no-color.org) or stdout isn't a
 * TTY, so piped/redirected output stays plain text.
 */

/** True unless NO_COLOR is set or stdout is not a terminal. */
function colorOn(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  return Boolean(process.stdout?.isTTY);
}

const wrap = (code: number) => (s: string): string => (colorOn() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const cyan = wrap(36);

/** Visible length of a string, ignoring ANSI escape sequences (so colour never skews padding). */
function visibleLen(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI CSI escape (\x1b[…m) is the whole point — strip color codes so padding isn't skewed by invisible bytes.
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Right-pad to `width` columns, counting only visible (non-ANSI) characters. */
function pad(s: string, width: number): string {
  const gap = width - visibleLen(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/**
 * Print a simple left-aligned table: a dim header row followed by the rows, every column
 * padded to the widest cell in it (last column is never padded, so trailing space is avoided).
 * Cells may already contain ANSI colour — padding accounts for it. An empty `rows` prints
 * just the header.
 */
export function printTable(headers: string[], rows: string[][]): void {
  const cols = headers.length;
  const widths: number[] = headers.map((h) => visibleLen(h));
  for (const row of rows) {
    for (let i = 0; i < cols; i++) widths[i] = Math.max(widths[i] ?? 0, visibleLen(row[i] ?? ""));
  }
  const render = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === cols - 1 ? cell : pad(cell, widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  console.log(dim(render(headers)));
  for (const row of rows) console.log(render(row));
}

/** Human-friendly "3 days ago" from an epoch-ms timestamp. */
export function relativeTime(epochMs: number): string {
  if (!epochMs) return "";
  const secs = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  const units: Array<[number, string]> = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.345, "w"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let n = secs;
  let unit = "s";
  for (const [step, label] of units) {
    if (n < step) {
      unit = label;
      break;
    }
    n = Math.floor(n / step);
    unit = label;
  }
  return `${n}${unit} ago`;
}
