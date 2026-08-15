// Controls how tall the per-repo changed-files tree is.
//
// Two layers, both persisted to localStorage (client-side preferences, like the theme):
//   1. A global default size (small / medium / tall) chosen in Settings. This is a max-height,
//      so an untouched list stays content-sized and only scrolls once it reaches the preset.
//   2. An optional per-repo height set by dragging the resize grip. This is an exact height:
//      someone who deliberately makes a short list taller should see the grip follow the pointer
//      and the chosen workspace stay that size until they double-click to reset it.
import { useLocalStorage } from "@vueuse/core";

export type ChangesViewSize = "small" | "medium" | "tall";

/** Preset → max-height in px (the default, fit-to-content cap). */
export const CHANGES_SIZE_PX: Record<ChangesViewSize, number> = {
  small: 200,
  medium: 340,
  tall: 560,
};

/** Minimum usable height for a drag-to-resize override. There is deliberately no upper ceiling. */
export const MIN_CHANGES_PX = 96;

/** Global default, shared by every card that has no manual override. */
export const changesViewSize = useLocalStorage<ChangesViewSize>("repoyeti:changesViewSize", "medium");

/** repoId → manually-dragged fixed height (px). Absent = use the global preset. */
const overrides = useLocalStorage<Record<string, number>>("repoyeti:changesViewHeights", {});

export function hasChangesOverride(repoId: string): boolean {
  return typeof overrides.value[repoId] === "number";
}

/**
 * The inline style for a card's scroll container. The Settings preset remains a content-fitting
 * cap; a deliberate per-repo resize pins the exact height, including above the content height.
 */
export function changesTreeStyle(repoId: string): Record<string, string> {
  const o = overrides.value[repoId];
  return typeof o === "number"
    ? { height: `${o}px` }
    : { maxHeight: `${CHANGES_SIZE_PX[changesViewSize.value]}px` };
}

export function setChangesOverride(repoId: string, px: number): void {
  overrides.value[repoId] = Math.max(MIN_CHANGES_PX, Math.round(px));
}

export function clearChangesOverride(repoId: string): void {
  delete overrides.value[repoId];
}

// ── tree ⇄ list view mode ─────────────────────────────────────────────────────
// The changed files render as a VS Code-style nested folder tree by default; some people
// prefer a flat list of full paths. This is a per-repo client preference (same localStorage
// pattern as the height override above): absent = "tree", so existing cards are unchanged.
export type ChangesDisplayMode = "tree" | "list";

/** repoId → chosen display mode. Absent = "tree" (the default). */
const displayModes = useLocalStorage<Record<string, ChangesDisplayMode>>(
  "repoyeti:changesDisplayMode",
  {},
);

/** The card's current display mode ("tree" unless the owner switched it to "list"). */
export function changesDisplayMode(repoId: string): ChangesDisplayMode {
  return displayModes.value[repoId] === "list" ? "list" : "tree";
}

/** Set (or reset to the default) a card's display mode. Storing "tree" drops the key so the
 *  record only ever holds the non-default choices — matches clearChangesOverride's tidiness. */
export function setChangesDisplayMode(repoId: string, mode: ChangesDisplayMode): void {
  if (mode === "list") displayModes.value[repoId] = "list";
  else delete displayModes.value[repoId];
}

// ── changes ⇄ all-files panel mode ────────────────────────────────────────────
// The panel shows the CHANGED files by default. "All files" swaps in a lazy browser over the
// whole working tree (RepoFileTree) — same card, same viewer, same icons, just no filter on
// "did this change". Per-repo and browser-local, like the height and tree/list prefs above:
// which repo you happen to be browsing is per-screen ergonomics, not a stated preference.
//
// Unlike those, this one is NOT gated on the repo being dirty — a clean repo is exactly when
// you want to read the code, so the toggle lives outside the changed-files section entirely
// (see RepoCardChanges.vue's header row).
export type ChangesPanelMode = "changes" | "all";

/** repoId → chosen panel. Absent = "changes" (the default). */
const panelModes = useLocalStorage<Record<string, ChangesPanelMode>>(
  "repoyeti:changesPanelMode",
  {},
);

/** The card's current panel ("changes" unless the owner switched to browsing all files). */
export function changesPanelMode(repoId: string): ChangesPanelMode {
  return panelModes.value[repoId] === "all" ? "all" : "changes";
}

/** Set (or reset to the default) a card's panel. Storing "changes" drops the key, so the record
 *  only ever holds the non-default choices — same tidiness rule as setChangesDisplayMode. */
export function setChangesPanelMode(repoId: string, mode: ChangesPanelMode): void {
  if (mode === "all") panelModes.value[repoId] = "all";
  else delete panelModes.value[repoId];
}

// ── per-file change totals: how they render ───────────────────────────────────
// Deliberately NOT here. `changesStatDisplay` (numbers vs bars) and `changesChars` (show the
// character half) are DAEMON settings — see src/config.ts and store/settings.ts — not the
// browser-local pattern the rest of this file uses. They shipped as localStorage first, but a
// preference the owner sets once should follow him to the phone and the remote tunnel, which
// localStorage cannot do; they ride the same Connections prefs sync as `diffStats`.
//
// The everything-else-in-this-file rule still stands: heights, tree/list mode and collapse state
// stay local, because those are per-screen ergonomics rather than a stated preference.
