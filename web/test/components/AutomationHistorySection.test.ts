// Proves the automation run history surface (src/http/routes/automation.ts, src/automation-run.ts)
// is wired into the Settings UI: recent runs render with a distinct label per outcome, a running
// round shows a live progress line + Stop, and expanding a row loads its per-repository detail.
// Would fail if the panel were removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AutomationHistorySection from "@/components/settings/AutomationHistorySection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { AutomationRun, AutomationRunRepo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: VueWrapper | undefined;

function mountSection() {
  activeWrapper = mount(
    {
      components: { AutomationHistorySection, TooltipProvider },
      template: '<TooltipProvider><AutomationHistorySection :open="true" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  return activeWrapper.findComponent(AutomationHistorySection);
}

function run(over: Partial<AutomationRun>): AutomationRun {
  return {
    id: "r1",
    kind: "auto_commit",
    trigger: "timer",
    startedAt: Date.now() - 10_000,
    endedAt: Date.now() - 5_000,
    outcome: "completed",
    reposTotal: 3,
    reposDone: 3,
    reposBlocked: 0,
    error: null,
    ...over,
  };
}

describe("AutomationHistorySection", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks(); // the module-level vue-sonner mock's call history survives restoreAllMocks
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("loads on open and shows the empty state once loaded with nothing recorded", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [];
      store.automationRunsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(load).toHaveBeenCalled();
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryEmpty"));
  });

  it("renders one row per run with its outcome label", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [
        run({ id: "r1", outcome: "completed" }),
        run({ id: "r2", kind: "sync_check", outcome: "cancelled" }),
      ];
      store.automationRunsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeCompleted"));
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeCancelled"));
  });

  it("a run with outcome: null renders as running, not as completed", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [run({ id: "r1", outcome: null, endedAt: null })];
      store.automationRunsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeRunning"));
    expect(section.text()).not.toContain(i18n.global.t("settings.automationHistoryOutcomeCompleted"));
  });

  it("labels an interrupted run distinctly from a failed one", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [
        run({ id: "r1", outcome: "failed", error: "boom", endedAt: Date.now() }),
        run({ id: "r2", outcome: "interrupted", endedAt: null }),
      ];
      store.automationRunsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeFailed"));
    expect(section.text()).toContain("boom");
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeInterrupted"));
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryOutcomeInterruptedHint"));
    // Distinct labels, not the same word doing double duty.
    expect(i18n.global.t("settings.automationHistoryOutcomeFailed")).not.toBe(
      i18n.global.t("settings.automationHistoryOutcomeInterrupted"),
    );
  });

  it("shows the live progress line and Stop button only for the loop that is running, disabled while cancelling", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [];
      store.automationRunsReady = true;
      store.automationActiveRounds.auto_commit = { running: true, cancelling: false };
      store.automationLiveRuns.auto_commit = { runId: "live1", done: 2, blocked: 0, total: 5, current: "widgets" };
    });
    const cancel = vi.spyOn(store, "cancelAutomationRound").mockResolvedValue(undefined);

    const section = mountSection();
    await flushPromises();

    // Running loop: progress line present, Stop enabled.
    expect(section.text()).toContain("widgets");
    expect(section.text()).toContain("2");
    expect(section.text()).toContain("5");
    const stopButton = section.findAll("button").find((b) => b.text() === i18n.global.t("settings.automationHistoryStop"));
    expect(stopButton).toBeDefined();
    expect(stopButton!.attributes("disabled")).toBeUndefined();

    // Not-running loop (sync_check) shows no progress/Stop of its own.
    expect(section.text()).not.toContain(i18n.global.t("settings.automationHistoryKindSyncCheck"));

    await stopButton!.trigger("click");
    await flushPromises();
    expect(cancel).toHaveBeenCalledWith("auto_commit");

    // Now cancelling: disabled + "Stopping…"
    store.automationActiveRounds.auto_commit = { running: true, cancelling: true };
    await flushPromises();
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryStopping"));
    const stoppingButton = section
      .findAll("button")
      .find((b) => b.text() === i18n.global.t("settings.automationHistoryStopping"));
    expect(stoppingButton!.attributes("disabled")).toBeDefined();
  });

  it("clicking a row loads and shows its per-repository detail", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [run({ id: "r1" })];
      store.automationRunsReady = true;
    });
    const repoRow: AutomationRunRepo = {
      id: "rr1",
      runId: "r1",
      repoId: "repo1",
      repoName: "widgets",
      at: Date.now(),
      durationMs: 4200,
      outcome: "committed",
      detail: { commits: 2, pulled: true, pushed: false },
    };
    const detail = vi
      .spyOn(store, "loadAutomationRunDetail")
      .mockResolvedValue({ run: run({ id: "r1" }), repos: [repoRow] });

    const section = mountSection();
    await flushPromises();

    const row = section.get('[role="button"]');
    await row.trigger("click");
    await flushPromises();

    expect(detail).toHaveBeenCalledWith("r1");
    expect(section.text()).toContain("widgets");
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryRepoOutcomeCommitted"));
    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryDetailPulled"));

    // Toggling again does not re-fetch.
    await row.trigger("click");
    await row.trigger("click");
    await flushPromises();
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it("a detail call returning null shows the 'no longer kept' line and does not throw", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [run({ id: "r1" })];
      store.automationRunsReady = true;
    });
    vi.spyOn(store, "loadAutomationRunDetail").mockResolvedValue(null);

    const section = mountSection();
    await flushPromises();

    const row = section.get('[role="button"]');
    await expect(row.trigger("click")).resolves.not.toThrow();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryDetailUnavailable"));
  });
});
