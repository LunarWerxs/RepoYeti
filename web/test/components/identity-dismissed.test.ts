import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import IdentityManager from "@/components/IdentityManager.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DetectedIdentity } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function detected(id: string): DetectedIdentity {
  return {
    id,
    source: "git-global",
    title: `Suggestion ${id}`,
    detail: "Octo Cat · octo@example.com",
    confidence: "high",
    suggestion: {
      displayName: "Octo Cat",
      gitUsername: "Octo Cat",
      gitEmail: "octo@example.com",
      sshKeyPath: null,
    },
    missing: [],
  };
}

let activeWrapper: ReturnType<typeof mount> | undefined;

function mountManager() {
  activeWrapper = mount(
    {
      components: { IdentityManager, TooltipProvider },
      template: "<TooltipProvider><IdentityManager /></TooltipProvider>",
    },
    {
      global: {
        plugins: [autoAnimatePlugin, i18n],
      },
      attachTo: document.body,
    },
  );
  return activeWrapper;
}

// The show/hide button is the only header toggle: its label flips between "{n} hidden — show"
// and "hide", so match on aria-expanded (which the reload/edit buttons don't set here).
const dismissedToggle = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll("button").find((b) => b.attributes("aria-expanded") !== undefined);

describe("IdentityManager dismissed list", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("does not auto-reopen the hidden list after Restore all empties it", async () => {
    // The expand flag used to survive an empty list: restoring every hidden suggestion hid the
    // toggle but left showDismissed true, so the NEXT dismissal re-showed the toggle already expanded.
    const store = useStore();
    store.detectedIdentitiesReady = true;
    store.dismissedDetectedIdentities = [detected("d1")];

    vi.spyOn(store, "restoreDetectedIdentities").mockImplementation(async () => {
      const restored = store.dismissedDetectedIdentities;
      store.dismissedDetectedIdentities = [];
      store.detectedIdentities = restored;
    });

    const wrapper = mountManager();
    await wrapper.vm.$nextTick();

    const toggle = dismissedToggle(wrapper);
    expect(toggle).toBeTruthy();
    expect(toggle!.attributes("aria-expanded")).toBe("false");

    // Expand the hidden list for review, then restore everything.
    await toggle!.trigger("click");
    await wrapper.vm.$nextTick();
    expect(dismissedToggle(wrapper)!.attributes("aria-expanded")).toBe("true");
    expect(wrapper.text()).toContain("Hidden suggestions");

    const restoreAll = wrapper.findAll("button").find((b) => b.text().includes("Restore all"));
    expect(restoreAll).toBeTruthy();
    await restoreAll!.trigger("click");
    await new Promise((r) => setTimeout(r, 0));

    // List is empty, so the toggle is gone entirely.
    expect(dismissedToggle(wrapper)).toBeUndefined();

    // Dismiss the now-visible suggestion and re-check: the toggle must come back collapsed.
    vi.spyOn(store, "dismissDetectedIdentity").mockImplementation(async (id) => {
      const item = store.detectedIdentities.find((d) => d.id === id);
      store.detectedIdentities = store.detectedIdentities.filter((d) => d.id !== id);
      if (item) store.dismissedDetectedIdentities = [item];
    });
    const dismissButton = wrapper.findAll("button").find((b) => b.attributes("aria-label") === "Dismiss suggestion");
    expect(dismissButton).toBeTruthy();
    await dismissButton!.trigger("click");
    await wrapper.vm.$nextTick();

    const reopened = dismissedToggle(wrapper);
    expect(reopened).toBeTruthy();
    expect(reopened!.attributes("aria-expanded")).toBe("false");
    expect(wrapper.text()).not.toContain("Hidden suggestions");
  });
});
