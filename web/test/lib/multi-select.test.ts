// The selection request model (@/lib/multi-select): gestures become ID-keyed set-all / set-range
// requests that the owner applies against the list's on-screen order. Pinned here as pure
// functions because the order-resolution rules are where a bulk Remove could reach a repo the
// owner never saw: a range must not sweep ids outside the supplied order, and "all" means the
// supplied order, nothing more.
import { describe, it, expect } from "vitest";
import { applySelectionRequests, itemRequests, keyRequests } from "@/lib/multi-select";

const order = ["a", "b", "c", "d", "e"];
const none = { shift: false, ctrl: false };
const shift = { shift: true, ctrl: false };

describe("itemRequests", () => {
  it("a plain tap toggles one item and becomes the anchor", () => {
    const r = itemRequests("c", none, "a", () => false);
    expect(r.requests).toEqual([{ type: "setRange", first: "c", last: "c", selected: true }]);
    expect(r.anchor).toBe("c");
  });

  it("Shift sets the anchor..item range to the anchor's own state and keeps the anchor", () => {
    const ticked = itemRequests("d", shift, "b", (id) => id === "b");
    expect(ticked.requests).toEqual([{ type: "setRange", first: "b", last: "d", selected: true }]);
    expect(ticked.anchor).toBe("b");

    const unticked = itemRequests("d", shift, "b", () => false);
    expect(unticked.requests[0]).toMatchObject({ selected: false });
  });

  it("Shift without an anchor is a plain toggle", () => {
    const r = itemRequests("d", shift, null, () => false);
    expect(r.requests).toEqual([{ type: "setRange", first: "d", last: "d", selected: true }]);
    expect(r.anchor).toBe("d");
  });
});

describe("keyRequests", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, ...mods });

  it("Ctrl+A and Cmd+A select all", () => {
    expect(keyRequests(key("a", { ctrlKey: true }), false)).toEqual([{ type: "setAll", selected: true }]);
    expect(keyRequests(key("A", { metaKey: true }), false)).toEqual([{ type: "setAll", selected: true }]);
  });

  it("Escape clears only when something is selected", () => {
    expect(keyRequests(key("Escape"), true)).toEqual([{ type: "setAll", selected: false }]);
    expect(keyRequests(key("Escape"), false)).toBeNull();
  });

  it("leaves every other key alone", () => {
    expect(keyRequests(key("a"), true)).toBeNull();
    expect(keyRequests(key("a", { ctrlKey: true, shiftKey: true }), true)).toBeNull();
  });
});

describe("applySelectionRequests", () => {
  it("resolves a range by on-screen order, in either direction, without mutating the input", () => {
    const before = new Set(["a"]);
    const after = applySelectionRequests(before, [{ type: "setRange", first: "d", last: "b", selected: true }], order);
    expect([...after].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...before]).toEqual(["a"]);
  });

  it("unticks a range", () => {
    const after = applySelectionRequests(new Set(order), [{ type: "setRange", first: "b", last: "d", selected: false }], order);
    expect([...after].sort()).toEqual(["a", "e"]);
  });

  it("shrinks a range whose far end left the order to the clicked item alone", () => {
    const after = applySelectionRequests(new Set(), [{ type: "setRange", first: "gone", last: "d", selected: true }], order);
    expect([...after]).toEqual(["d"]);
  });

  it("select all is exactly the supplied order, and clear empties", () => {
    const all = applySelectionRequests(new Set(["off-screen"]), [{ type: "setAll", selected: true }], order);
    expect([...all]).toEqual(order);
    expect(applySelectionRequests(all, [{ type: "setAll", selected: false }], order).size).toBe(0);
  });
});
