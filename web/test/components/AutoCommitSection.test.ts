// Proves the auto-commit incident ledger surface (src/http/routes/auto-commit-incidents.ts) is
// actually wired into the Settings UI: it loads on open, shows unacked incidents with a badge,
// and Acknowledge calls through to the store. Would fail if the panel were removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AutoCommitSection from "@/components/settings/AutoCommitSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { useStore } from "@/store";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: VueWrapper | undefined;

function mountSection() {
  activeWrapper = mount(
    {
      components: { AutoCommitSection, TooltipProvider },
      template: '<TooltipProvider><AutoCommitSection :open="true" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  return activeWrapper.findComponent(AutoCommitSection);
}

describe("AutoCommitSection - incident ledger", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("loads incidents on open and shows the unacked count", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadAutoCommitIncidents").mockImplementation(async () => {
      store.autoCommitIncidents = [
        { id: "i1", repoId: "r1", repoName: "widgets", at: Date.now(), reason: "CONFLICT", ackedAt: null },
      ];
      store.autoCommitIncidentsUnacked = 1;
    });

    const section = mountSection();
    await flushPromises();

    expect(load).toHaveBeenCalled();
    expect(section.text()).toContain("widgets");
    expect(section.text()).toContain("CONFLICT");
    expect(section.text()).toContain("1");
  });

  it("Acknowledge calls the store and the row moves out of the unacked list", async () => {
    const store = useStore();
    vi.spyOn(store, "loadAutoCommitIncidents").mockImplementation(async () => {
      store.autoCommitIncidents = [
        { id: "i1", repoId: "r1", repoName: "widgets", at: Date.now(), reason: "CONFLICT", ackedAt: null },
      ];
      store.autoCommitIncidentsUnacked = 1;
    });
    const ack = vi.spyOn(store, "ackAutoCommitIncident").mockImplementation(async (id: string) => {
      store.autoCommitIncidents = store.autoCommitIncidents.map((i) =>
        i.id === id ? { ...i, ackedAt: Date.now() } : i,
      );
      store.autoCommitIncidentsUnacked = 0;
    });

    const section = mountSection();
    await flushPromises();

    const ackButton = section
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.autoCommitIncidentAck")));
    expect(ackButton).toBeDefined();
    await ackButton!.trigger("click");
    await flushPromises();

    expect(ack).toHaveBeenCalledWith("i1");
    expect(section.findAll("button").some((b) => b.text().includes("Acknowledge"))).toBe(false);
  });
});
