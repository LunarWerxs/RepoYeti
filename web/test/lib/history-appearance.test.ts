import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const ACTIVITY_KEY = "repoyeti:historyActivityEnabled";
const ACTIVITY_SCALE_KEY = "repoyeti:historyActivityScale";
const GRAPH_KEY = "repoyeti:historyGraphEnabled";
const CHANGES_KEY = "repoyeti:historyChangesDisplay";

async function preferences() {
  return import("@/lib/history-appearance");
}

describe("History appearance preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to activity and graph enabled, daily activity, and numeric change totals", async () => {
    const {
      historyActivityEnabled,
      historyActivityScale,
      historyGraphEnabled,
      historyChangesDisplay,
    } = await preferences();

    expect(historyActivityEnabled.value).toBe(true);
    expect(historyActivityScale.value).toBe("daily");
    expect(historyGraphEnabled.value).toBe(true);
    expect(historyChangesDisplay.value).toBe("numbers");
  });

  it("persists each appearance choice under its own localStorage key", async () => {
    const {
      historyActivityEnabled,
      historyActivityScale,
      historyGraphEnabled,
      historyChangesDisplay,
    } = await preferences();

    historyActivityEnabled.value = false;
    historyActivityScale.value = "monthly";
    historyGraphEnabled.value = false;
    historyChangesDisplay.value = "bars";
    await nextTick();

    expect(localStorage.getItem(ACTIVITY_KEY)).toBe("false");
    expect(localStorage.getItem(ACTIVITY_SCALE_KEY)).toBe("monthly");
    expect(localStorage.getItem(GRAPH_KEY)).toBe("false");
    expect(localStorage.getItem(CHANGES_KEY)).toBe("bars");
  });

  it("restores persisted choices when the preference module is loaded again", async () => {
    localStorage.setItem(ACTIVITY_KEY, "false");
    localStorage.setItem(ACTIVITY_SCALE_KEY, "hourly");
    localStorage.setItem(GRAPH_KEY, "false");
    localStorage.setItem(CHANGES_KEY, "bars");

    const {
      historyActivityEnabled,
      historyActivityScale,
      historyGraphEnabled,
      historyChangesDisplay,
    } = await preferences();

    expect(historyActivityEnabled.value).toBe(false);
    expect(historyActivityScale.value).toBe("hourly");
    expect(historyGraphEnabled.value).toBe(false);
    expect(historyChangesDisplay.value).toBe("bars");
  });
});
