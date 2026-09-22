// Regressions for the automation history surface (components/settings/AutomationHistorySection.vue
// + store/automation-runs.ts):
//   - a detail fetch that fails below HTTP level must not leave the expansion blank
//   - expanding an in-flight round must refetch once the round settles, not keep a partial list
//   - a cancel answered with `cancelled: false` must clear the optimistic flags, not stick on Stop
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AutomationHistorySection from "@/components/settings/AutomationHistorySection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { api } from "@/api";
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

function repo(over: Partial<AutomationRunRepo>): AutomationRunRepo {
  return {
    id: "rr1",
    runId: "r1",
    repoId: "repo1",
    repoName: "widgets",
    at: Date.now(),
    durationMs: 4200,
    outcome: "committed",
    detail: null,
    ...over,
  };
}

describe("automation history regressions", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("shows 'detail unavailable' instead of blank when the detail request rejects", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [run({ id: "r1" })];
      store.automationRunsReady = true;
    });
    // Offline / non-JSON body: the store rethrows anything that is not an ApiError.
    vi.spyOn(store, "loadAutomationRunDetail").mockRejectedValue(new Error("offline"));

    const section = mountSection();
    await flushPromises();

    const row = section.get('[role="button"]');
    await expect(row.trigger("click")).resolves.not.toThrow();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.automationHistoryDetailUnavailable"));
  });

  it("refetches an in-flight round's detail once it settles, so the repo list is complete", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutomationRuns").mockImplementation(async () => {
      store.automationRuns = [
        run({ id: "r1", outcome: null, endedAt: null, reposDone: 1, reposTotal: 5 }),
      ];
      store.automationRunsReady = true;
    });
    const detail = vi.spyOn(store, "loadAutomationRunDetail");
    detail.mockResolvedValueOnce({
      run: run({ id: "r1", outcome: null, endedAt: null }),
      repos: [repo({ id: "rr1", repoName: "only-repo-so-far" })],
    });
    detail.mockResolvedValueOnce({
      run: run({ id: "r1", outcome: "completed", endedAt: Date.now() }),
      repos: [repo({ id: "rr1", repoName: "only-repo-so-far" }), repo({ id: "rr2", repoName: "finished-later" })],
    });

    const section = mountSection();
    await flushPromises();

    await section.get('[role="button"]').trigger("click");
    await flushPromises();
    expect(section.text()).toContain("only-repo-so-far");
    expect(section.text()).not.toContain("finished-later");

    // The terminal event settles the very same row in place (same id, now a real endedAt).
    store.automationRuns = [run({ id: "r1", outcome: "completed", endedAt: Date.now(), reposDone: 5 })];
    await flushPromises();

    expect(detail).toHaveBeenCalledTimes(2);
    expect(section.text()).toContain("finished-later");
  });

  it("clears the cancelling flag when cancel answers cancelled: false", async () => {
    const store = useStore();
    vi.spyOn(api.automation, "cancel").mockResolvedValue({ ok: true, kind: "auto_commit", cancelled: false });
    store.automationActiveRounds.auto_commit = { running: true, cancelling: false };

    await store.cancelAutomationRound("auto_commit");

    // No round was in flight, so no terminal SSE will ever clear these optimistic flags.
    expect(store.automationActiveRounds.auto_commit).toEqual({ running: false, cancelling: false });
  });
});
