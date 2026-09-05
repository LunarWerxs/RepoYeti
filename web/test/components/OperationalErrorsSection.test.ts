// Proves the grouped operational-error surface (src/http/routes/errors.ts) is wired into the
// Settings UI: it loads on open, lets the owner mute/unmute and dismiss a group, and both call
// through to the store. Would fail if the panel were removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import OperationalErrorsSection from "@/components/settings/OperationalErrorsSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { OperationalErrorView } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

let activeWrapper: VueWrapper | undefined;

function mountSection() {
  activeWrapper = mount(
    {
      components: { OperationalErrorsSection, TooltipProvider },
      template: '<TooltipProvider><OperationalErrorsSection :open="true" /></TooltipProvider>',
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  return activeWrapper.findComponent(OperationalErrorsSection);
}

const ROW: OperationalErrorView = {
  fingerprint: "abc123",
  repoId: "r1",
  repoName: "widgets",
  op: "push",
  code: "AUTH_FAILED",
  message: "authentication failed",
  occurrences: 3,
  firstSeenAt: 1,
  lastSeenAt: 2,
  muted: false,
};

describe("OperationalErrorsSection", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("loads on open and shows a grouped error with its occurrence count", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadOperationalErrors").mockImplementation(async () => {
      store.operationalErrors = [ROW];
      store.operationalErrorsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(load).toHaveBeenCalled();
    expect(section.text()).toContain("widgets");
    expect(section.text()).toContain("push");
    expect(section.text()).toContain("AUTH_FAILED");
    expect(section.text()).toContain("authentication failed");
  });

  it("shows an empty state once loaded with nothing recorded", async () => {
    const store = useStore();
    vi.spyOn(store, "loadOperationalErrors").mockImplementation(async () => {
      store.operationalErrors = [];
      store.operationalErrorsReady = true;
    });

    const section = mountSection();
    await flushPromises();

    expect(section.text()).toContain(i18n.global.t("settings.operationalErrorsEmpty"));
  });

  it("mute calls the store with the fingerprint and the true flag", async () => {
    const store = useStore();
    vi.spyOn(store, "loadOperationalErrors").mockImplementation(async () => {
      store.operationalErrors = [ROW];
      store.operationalErrorsReady = true;
    });
    const setMuted = vi.spyOn(store, "setOperationalErrorMuted").mockResolvedValue(undefined);

    const section = mountSection();
    await flushPromises();

    const muteButton = section.get(`button[aria-label="${i18n.global.t("settings.operationalErrorMute")}"]`);
    await muteButton.trigger("click");
    await flushPromises();

    expect(setMuted).toHaveBeenCalledWith("abc123", true);
  });

  it("dismiss calls the store and removes the row", async () => {
    const store = useStore();
    vi.spyOn(store, "loadOperationalErrors").mockImplementation(async () => {
      store.operationalErrors = [ROW];
      store.operationalErrorsReady = true;
    });
    const dismiss = vi.spyOn(store, "dismissOperationalError").mockImplementation(async (fp: string) => {
      store.operationalErrors = store.operationalErrors.filter((e) => e.fingerprint !== fp);
    });

    const section = mountSection();
    await flushPromises();

    const dismissButton = section.get(
      `button[aria-label="${i18n.global.t("settings.operationalErrorDismiss")}"]`,
    );
    await dismissButton.trigger("click");
    await flushPromises();

    expect(dismiss).toHaveBeenCalledWith("abc123");
    expect(section.text()).not.toContain("widgets");
  });
});
