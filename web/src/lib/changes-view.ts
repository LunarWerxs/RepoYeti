// Controls how tall the per-repo changed-files tree is.
//
// Two layers, both persisted to localStorage (client-side preference, like the theme):
//   1. A global default size (small / medium / tall) chosen in Settings. Acts as a
//      `max-height` — the list fits its content and only scrolls when it overflows.
//   2. An optional per-repo override set by dragging the resize grip on a card. Acts
//      as a fixed `height` — an explicit "make this one taller" that sticks until reset.
import { useLocalStorage } from "@vueuse/core";

export type ChangesViewSize = "small" | "medium" | "tall";

/** Preset → max-height in px (the default, fit-to-content cap). */
export const CHANGES_SIZE_PX: Record<ChangesViewSize, number> = {
  small: 200,
  medium: 340,
  tall: 560,
};

/** Clamp range for the drag-to-resize override. */
export const MIN_CHANGES_PX = 96;
export const MAX_CHANGES_PX = 1400;

/** Global default, shared by every card that has no manual override. */
export const changesViewSize = useLocalStorage<ChangesViewSize>("repoyeti:changesViewSize", "medium");

/** repoId → manually-dragged fixed height (px). Absent = use the global preset. */
const overrides = useLocalStorage<Record<string, number>>("repoyeti:changesViewHeights", {});

export function hasChangesOverride(repoId: string): boolean {
  return typeof overrides.value[repoId] === "number";
}

/**
 * The inline style for a card's scroll container. With no override we cap the height
 * (content fits, scrolls past the cap); with an override we pin an exact height.
 */
export function changesTreeStyle(repoId: string): Record<string, string> {
  const o = overrides.value[repoId];
  return typeof o === "number"
    ? { height: `${o}px` }
    : { maxHeight: `${CHANGES_SIZE_PX[changesViewSize.value]}px` };
}

export function setChangesOverride(repoId: string, px: number): void {
  overrides.value[repoId] = Math.min(MAX_CHANGES_PX, Math.max(MIN_CHANGES_PX, Math.round(px)));
}

export function clearChangesOverride(repoId: string): void {
  delete overrides.value[repoId];
}
