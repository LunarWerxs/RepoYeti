import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  clearHistoryOverride,
  hasHistoryOverride,
  historyScrollStyle,
  HISTORY_HEIGHT_PX,
  MIN_HISTORY_PX,
  setHistoryOverride,
} from "@/lib/history-view";

const KEY = "repoyeti:historyHeight";

describe("history viewport height", () => {
  beforeEach(() => {
    clearHistoryOverride();
    localStorage.clear();
  });

  it("contributes no inline height until resized, leaving the stylesheet cap in charge", () => {
    expect(hasHistoryOverride()).toBe(false);
    expect(historyScrollStyle()).toEqual({});
  });

  it("pins an exact height and clears the cap, so a drag can go past the default", () => {
    setHistoryOverride(HISTORY_HEIGHT_PX + 400);

    expect(hasHistoryOverride()).toBe(true);
    expect(historyScrollStyle()).toEqual({ height: "976px", maxHeight: "none" });
  });

  it("persists the height and double-click's clear path restores the default cap", async () => {
    setHistoryOverride(820);
    await nextTick();

    expect(JSON.parse(localStorage.getItem(KEY) ?? "0")).toBe(820);

    clearHistoryOverride();
    expect(hasHistoryOverride()).toBe(false);
    expect(historyScrollStyle()).toEqual({});
  });

  it("keeps the minimum usable height without imposing an upper ceiling", () => {
    setHistoryOverride(1);
    expect(historyScrollStyle()).toEqual({ height: `${MIN_HISTORY_PX}px`, maxHeight: "none" });

    setHistoryOverride(6000);
    expect(historyScrollStyle()).toEqual({ height: "6000px", maxHeight: "none" });
  });

  it("rounds a fractional drag height, since the value is written to an inline style", () => {
    setHistoryOverride(432.6);
    expect(historyScrollStyle()).toEqual({ height: "433px", maxHeight: "none" });
  });
});
