import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  changesPanelMode,
  changesTreeStyle,
  changesViewSize,
  clearChangesOverride,
  hasChangesOverride,
  MIN_CHANGES_PX,
  setChangesOverride,
  setChangesPanelMode,
} from "@/lib/changes-view";

const KEY = "repoyeti:changesViewHeights";
const PANEL_KEY = "repoyeti:changesPanelMode";
const repoId = "resize-test-repo";

describe("changed-files workspace height", () => {
  beforeEach(() => {
    clearChangesOverride(repoId);
    changesViewSize.value = "medium";
    localStorage.clear();
  });

  it("uses the Settings preset as a content-fitting cap until manually resized", () => {
    expect(hasChangesOverride(repoId)).toBe(false);
    expect(changesTreeStyle(repoId)).toEqual({ maxHeight: "340px" });
  });

  it("pins a manual resize as an exact height, even far beyond short content", () => {
    setChangesOverride(repoId, 2400);

    expect(hasChangesOverride(repoId)).toBe(true);
    expect(changesTreeStyle(repoId)).toEqual({ height: "2400px" });
  });

  it("persists the chosen per-repo height and double-click's clear path restores the preset", async () => {
    setChangesOverride(repoId, 725);
    await nextTick();

    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toMatchObject({ [repoId]: 725 });

    clearChangesOverride(repoId);
    expect(changesTreeStyle(repoId)).toEqual({ maxHeight: "340px" });
  });

  it("keeps the minimum usable height without imposing an upper ceiling", () => {
    setChangesOverride(repoId, 1);
    expect(changesTreeStyle(repoId)).toEqual({ height: `${MIN_CHANGES_PX}px` });

    setChangesOverride(repoId, 5000);
    expect(changesTreeStyle(repoId)).toEqual({ height: "5000px" });
  });
});

describe("changes ⇄ all-files panel mode", () => {
  const a = "panel-repo-a";
  const b = "panel-repo-b";

  beforeEach(() => {
    setChangesPanelMode(a, "changes");
    setChangesPanelMode(b, "changes");
    localStorage.clear();
  });

  it("defaults to the changed-files panel", () => {
    expect(changesPanelMode(a)).toBe("changes");
  });

  it("is per repo — browsing one card does not switch another", () => {
    setChangesPanelMode(a, "all");

    expect(changesPanelMode(a)).toBe("all");
    expect(changesPanelMode(b)).toBe("changes");
  });

  it("persists only the non-default choice, so the store stays tidy", async () => {
    setChangesPanelMode(a, "all");
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}")).toEqual({ [a]: "all" });

    setChangesPanelMode(a, "changes");
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}")).toEqual({});
  });
});
