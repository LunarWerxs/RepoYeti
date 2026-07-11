import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import IdentityManager from "@/components/IdentityManager.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

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

describe("IdentityManager.vue", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("opens and focuses the new identity form from the empty state", async () => {
    const wrapper = mountManager();
    // The identity.description blurb now lives behind the SettingsGroup's InfoHint (circle-i)
    // tooltip trigger rather than as always-visible page text — assert the trigger renders.
    const infoHint = wrapper.findAll("button").find((b) => b.attributes("aria-label") === "More information");
    expect(infoHint).toBeTruthy();

    const addButton = wrapper.findAll("button").find((b) => b.text().includes("Add identity"));
    expect(addButton).toBeTruthy();

    await addButton!.trigger("click");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(wrapper.text()).toContain("New identity");
    const firstInput = wrapper.find('input[data-slot="input"]');
    expect(firstInput.exists()).toBe(true);
    expect(document.activeElement).toBe(firstInput.element);
  });

  it("prefills the form from a detected local identity without saving it", async () => {
    const store = useStore();
    store.detectedIdentitiesReady = true;
    store.detectedIdentities.push({
      id: "detected-1",
      source: "git-global",
      title: "Global Git config",
      detail: "Octo Cat · octo@example.com",
      confidence: "high",
      suggestion: {
        displayName: "Octo Cat",
        gitUsername: "Octo Cat",
        gitEmail: "octo@example.com",
        sshKeyPath: null,
      },
      missing: [],
    });
    const createSpy = vi.spyOn(store, "createIdentity");

    const wrapper = mountManager();
    const useButton = wrapper.findAll("button").find((b) => b.text().includes("Use"));
    expect(useButton).toBeTruthy();
    expect(wrapper.text()).not.toContain("No saved identities yet");

    await useButton!.trigger("click");
    await wrapper.vm.$nextTick();

    const inputs = wrapper.findAll('input[data-slot="input"]');
    expect(inputs.map((input) => (input.element as HTMLInputElement).value)).toEqual([
      "Octo Cat",
      "Octo Cat",
      "octo@example.com",
      "",
    ]);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
