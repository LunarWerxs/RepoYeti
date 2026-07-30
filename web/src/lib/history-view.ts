// History commit-detail changed-files view: nested folder tree or the flat full-path list.
//
// A GLOBAL preference, unlike the Changes panel's per-repo display mode: the History detail is
// a compact read-only listing where one taste applies everywhere, so a single Settings switch
// (Appearance → "History files as folder tree") beats hunting a per-card toggle. Same
// localStorage pattern as @/lib/changes-view.
import { useLocalStorage } from "@vueuse/core";

export type HistoryFilesView = "tree" | "list";

/** How an expanded commit's changed files render in History. Default: folder tree. */
export const historyFilesView = useLocalStorage<HistoryFilesView>("repoyeti:historyFilesView", "tree");

// ── History viewport height ───────────────────────────────────────────────────
// How tall the commit list's scroll viewport is, set by dragging the grip under it.
//
// GLOBAL, unlike the Changes panel's per-repo height (@/lib/changes-view): that one is a
// fit-to-content measurement, and a repo with four changed files genuinely wants a different
// workspace than one with four hundred. Every repo's history is an unbounded list instead, so its
// height is only ever "how much screen am I giving this" — a taste, which should hold for every
// card rather than have to be re-dragged on each one.
//
// Absent = the stylesheet's max-height cap, so a repo with three commits still renders three rows
// tall. A drag pins an EXACT height, including well past the content, on the same reasoning as the
// changed-files grip: someone deliberately making the panel bigger should get the room they asked
// for. Double-clicking the grip clears it.

/** The default cap. Mirrors `.history-scroll`'s max-height in LogPanel.vue (36rem @ 16px). */
export const HISTORY_HEIGHT_PX = 576;

/** Minimum usable height — the column header plus a couple of rows. No upper ceiling. */
export const MIN_HISTORY_PX = 180;

/** Dragged viewport height in px. 0 (the default) = never resized, use the CSS cap. */
const historyHeight = useLocalStorage<number>("repoyeti:historyHeight", 0);

export function hasHistoryOverride(): boolean {
  return historyHeight.value >= MIN_HISTORY_PX;
}

/**
 * Inline style for the history scroller. Untouched, it contributes nothing and the stylesheet's
 * max-height keeps a short list content-sized; once resized it pins the exact height and must
 * clear that cap, since the whole point of the drag is to be able to go past it.
 */
export function historyScrollStyle(): Record<string, string> {
  return hasHistoryOverride() ? { height: `${historyHeight.value}px`, maxHeight: "none" } : {};
}

export function setHistoryOverride(px: number): void {
  historyHeight.value = Math.max(MIN_HISTORY_PX, Math.round(px));
}

export function clearHistoryOverride(): void {
  historyHeight.value = 0;
}
