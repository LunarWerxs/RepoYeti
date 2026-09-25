// Dashboard-wide "select multiple repositories" mode.
//
// Module-level singleton (same shape as @/lib/file-viewer and @/lib/changes-view) rather than
// provide/inject: the three participants are SIBLINGS, not a parent/child chain — AppHeader's ⋮
// menu turns the mode on, every RepoCardHeader renders a checkbox and toggles membership, and
// RepoBulkBar acts on the result. Deliberately NOT persisted: a selection is a momentary
// intent, and finding the dashboard still in select mode after a reload would be a trap.
//
// Gestures go through the request model in @/lib/multi-select: a tap, Shift-tap, Ctrl+A or Escape
// becomes set-all / set-range requests that this module applies to its own ID-keyed Set.
import { computed, nextTick, ref } from "vue";
import {
  applySelectionRequests,
  itemRequests,
  type SelectModifiers,
  type SelectionRequest,
} from "@/lib/multi-select";

const active = ref(false);
const selected = ref<Set<string>>(new Set());
// The last repo picked by a plain tap: where a Shift-tap ranges from.
let anchor: string | null = null;
// The repo ids in on-screen order, supplied by whoever renders the list (RepoBulkBar, which knows
// the filters and the collapsed sections). The selection can't derive it: order is the list's.
let rangeOrder: () => readonly string[] = () => [];
// Whatever opened select mode (the header's ⋮ button). Leaving the mode unmounts the bulk bar,
// which destroys the very control the user just activated — without this, focus would fall to
// <body> and a keyboard/screen-reader user would lose their place entirely.
let returnFocusTo: HTMLElement | null = null;

/** True while the dashboard is in multi-select mode (cards show checkboxes, rows don't expand). */
export const selectionActive = computed(() => active.value);
/**
 * Measured height of the bulk bar while it's mounted (0 otherwise), published by RepoBulkBar.
 *
 * Toasts are bottom-RIGHT, and the bulk bar is bottom-anchored across the same content width, so
 * at the default offset a toast lands squarely on top of the bar's right-hand buttons — Undo
 * included, which is the one control a bulk action most needs to stay reachable. App.vue lifts the
 * toaster by this much while select mode is on. Measured rather than hard-coded because the bar
 * wraps to a second row on narrow viewports.
 */
export const bulkBarHeight = ref(0);
/** How many repos are currently ticked. */
export const selectionCount = computed(() => selected.value.size);
/** The ticked repo ids, in no particular order. */
export const selectionIds = computed(() => [...selected.value]);

export function isSelected(repoId: string): boolean {
  return selected.value.has(repoId);
}

export function toggleSelected(repoId: string): void {
  // Reassign rather than mutate: a plain Set isn't deeply reactive, so callers watching
  // `selected` would never see an in-place add/delete.
  const next = new Set(selected.value);
  if (!next.delete(repoId)) next.add(repoId);
  selected.value = next;
}

/** Publish the on-screen order Shift-ranges resolve against; returns an unregister function. */
export function provideRangeOrder(order: () => readonly string[]): () => void {
  rangeOrder = order;
  return () => {
    if (rangeOrder === order) rangeOrder = () => [];
  };
}

/** Apply selection requests; `order` defaults to the published on-screen order. */
export function applyRequests(requests: readonly SelectionRequest[], order = rangeOrder()): void {
  selected.value = applySelectionRequests(selected.value, requests, order);
}

/**
 * A card row was tapped (or Enter/Space pressed on it) in select mode. A plain tap toggles that
 * repo; with Shift it sets every repo between the anchor and this one to the anchor's state.
 */
export function activateRepo(repoId: string, mods: SelectModifiers): void {
  const r = itemRequests(repoId, mods, anchor, isSelected);
  anchor = r.anchor;
  applyRequests(r.requests);
}

export function clearSelection(): void {
  selected.value = new Set();
}

/**
 * Enter select mode with nothing ticked. Pass the control that opened it (the header's ⋮
 * button) so focus can be handed back when the mode ends.
 */
export function startSelecting(trigger?: HTMLElement | null): void {
  returnFocusTo = trigger ?? null;
  anchor = null;
  selected.value = new Set();
  active.value = true;
}

/** Leave select mode, drop the selection, and hand focus back to whatever opened it. */
export function stopSelecting(): void {
  active.value = false;
  anchor = null;
  selected.value = new Set();
  const el = returnFocusTo;
  returnFocusTo = null;
  // After the DOM settles, so we're focusing across the bulk bar's unmount, not into it.
  if (el) void nextTick(() => { if (el.isConnected) el.focus(); });
}

/**
 * Drop ids that no longer exist (a repo removed by a bulk action, a rescan, or another
 * session). Without this a stale id would keep inflating the count and get sent to the daemon,
 * which would reject it.
 */
export function pruneSelection(liveIds: string[]): void {
  const live = new Set(liveIds);
  const next = new Set([...selected.value].filter((id) => live.has(id)));
  if (next.size !== selected.value.size) selected.value = next;
}
