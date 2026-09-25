// Multi-selection as a list of REQUESTS, not as state the list owns.
//
// Idea adapted from Dear ImGui's BeginMultiSelect/EndMultiSelect (ocornut/imgui, MIT): the list
// widget never holds the selection. A click, a Shift-click, Ctrl+A or Escape is turned into
// "set all" and "set range" requests, and the owner of the selection applies them to its own
// ID-keyed store. Written fresh for RepoYeti; no code was copied.
//
// Why a request model here: the dashboard's select mode used to know one gesture (tap = toggle),
// so picking ten repos meant ten taps. Ranges need an ORDER, and the order belongs to whoever
// renders the list (sections, filters, collapsed groups), not to the selection store. Keeping the
// requests ID-keyed ("from repo A to repo B") and resolving them against an order supplied at apply
// time means the same interpreter serves any list, including one whose rows are virtualized or
// re-sorted between the two clicks.

/** One change to a selection. Ranges are ID-keyed and inclusive of both ends, in either order. */
export type SelectionRequest =
  | { type: "setAll"; selected: boolean }
  | { type: "setRange"; first: string; last: string; selected: boolean };

/** The modifier state of a click or an Enter/Space press on an item. */
export interface SelectModifiers {
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  ctrl: boolean;
}

/** The subset of a KeyboardEvent the key interpreter reads (a plain object is enough in tests). */
export interface SelectKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface ItemRequests {
  requests: SelectionRequest[];
  /** The anchor the NEXT Shift-click should range from. */
  anchor: string | null;
}

/**
 * Interpret activating item `id` in checkbox-style selection (every plain tap toggles one item and
 * nothing else is cleared, which is what a phone needs; Ctrl-click therefore toggles too).
 *
 * Shift with a known anchor sets the whole anchor..id range to the ANCHOR's state, so a range
 * extends whatever the last plain tap did: tick one, Shift-tick another, and everything between is
 * ticked; untick one first and the same gesture unticks the range. The anchor stays put across
 * Shift-clicks so a range can be grown or shrunk from the same end, as file managers do.
 */
export function itemRequests(
  id: string,
  mods: SelectModifiers,
  anchor: string | null,
  isSelected: (id: string) => boolean,
): ItemRequests {
  if (mods.shift && anchor !== null && anchor !== id) {
    return {
      requests: [{ type: "setRange", first: anchor, last: id, selected: isSelected(anchor) }],
      anchor,
    };
  }
  return { requests: [{ type: "setRange", first: id, last: id, selected: !isSelected(id) }], anchor: id };
}

/**
 * Interpret a key pressed while the list has the selection scope: Ctrl/Cmd+A selects everything,
 * Escape clears (only when there is something to clear, so an idle Escape still reaches whatever
 * else listens for it). Anything else returns null, meaning "not a selection key, leave it alone".
 */
export function keyRequests(e: SelectKey, hasSelection: boolean): SelectionRequest[] | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
    return [{ type: "setAll", selected: true }];
  }
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && hasSelection) {
    return [{ type: "setAll", selected: false }];
  }
  return null;
}

/**
 * Apply requests to a selection and return the new one (the input is never mutated).
 *
 * `order` is the list as the user sees it right now. "Select all" means exactly that list, so a
 * repo filtered off screen is never swept in. A range whose far end is no longer in the order
 * (filtered away, removed, or in a collapsed section) shrinks to the item actually clicked rather
 * than guessing at where the missing end used to be.
 */
export function applySelectionRequests(
  selected: ReadonlySet<string>,
  requests: readonly SelectionRequest[],
  order: readonly string[],
): Set<string> {
  let next = new Set(selected);
  for (const req of requests) {
    if (req.type === "setAll") {
      next = req.selected ? new Set(order) : new Set();
      continue;
    }
    const a = order.indexOf(req.first);
    const b = order.indexOf(req.last);
    const span = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [req.last];
    for (const id of span) {
      if (req.selected) next.add(id);
      else next.delete(id);
    }
  }
  return next;
}
