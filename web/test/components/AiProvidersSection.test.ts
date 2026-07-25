import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import AiProvidersSection from "@/components/settings/AiProvidersSection.vue";
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
      components: { AiProvidersSection, TooltipProvider },
      template:
        '<TooltipProvider><AiProvidersSection :open="true" /></TooltipProvider>',
    },
    {
      global: {
        plugins: [i18n],
        directives: { autoAnimate: {} },
      },
      attachTo: document.body,
    },
  );
  return activeWrapper.findComponent(AiProvidersSection);
}

async function showCompatibleAddForm(section: VueWrapper): Promise<void> {
  const setup = section.vm as unknown as {
    beginAdd: (id: "compatible") => void;
  };
  setup.beginAdd("compatible");
  await nextTick();
}

describe("AiProvidersSection — OpenAI-compatible provider", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("requires a key for a remote base URL and discloses the exact destination", async () => {
    const store = useStore();
    store.aiCatalog = [
      {
        id: "compatible",
        label: "OpenAI-compatible",
        keyPlaceholder: "sk-…",
        customBaseUrl: true,
      },
    ];
    const connect = vi.spyOn(store, "connectProvider").mockResolvedValue({
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
    });

    const section = mountSection();
    await showCompatibleAddForm(section);

    const connectButton = section
      .findAll("button")
      .find((button) => button.text().includes(i18n.global.t("settings.btnConnect")));
    expect(connectButton).toBeDefined();
    expect((connectButton!.element as HTMLButtonElement).disabled).toBe(true);

    await section
      .get(`input[aria-label="${i18n.global.t("settings.compatibleBaseUrl")}"]`)
      .setValue("https://models.example.test/v1");
    expect(section.text()).toContain(
      "Selected diffs and prompts will be sent to https://models.example.test/v1/chat/completions",
    );
    expect(section.text()).toContain(
      "API key is required unless the base URL is an HTTP(S) loopback address such as localhost.",
    );
    expect((connectButton!.element as HTMLButtonElement).disabled).toBe(true);

    await section
      .get(`input[aria-label="${i18n.global.t("settings.compatibleManualModel")}"]`)
      .setValue("acme/chat");
    await section.get('input[aria-label="OpenAI-compatible API key"]').setValue("secret-key");
    expect((connectButton!.element as HTMLButtonElement).disabled).toBe(false);

    await connectButton!.trigger("click");
    await flushPromises();
    expect(connect).toHaveBeenCalledWith("compatible", "secret-key", {
      baseUrl: "https://models.example.test/v1",
      model: "acme/chat",
    });
  });

  it("allows an empty key only when the base URL is loopback", async () => {
    const store = useStore();
    store.aiCatalog = [
      {
        id: "compatible",
        label: "OpenAI-compatible",
        keyPlaceholder: "sk-…",
        customBaseUrl: true,
      },
    ];
    const connect = vi.spyOn(store, "connectProvider").mockResolvedValue({
      models: [{ id: "local-model", label: "local-model" }],
      discoveryAvailable: false,
    });

    const section = mountSection();
    await showCompatibleAddForm(section);
    const connectButton = section
      .findAll("button")
      .find((button) => button.text().includes(i18n.global.t("settings.btnConnect")));
    const baseUrl = section.get(
      `input[aria-label="${i18n.global.t("settings.compatibleBaseUrl")}"]`,
    );
    const model = section.get(
      `input[aria-label="${i18n.global.t("settings.compatibleManualModel")}"]`,
    );

    await baseUrl.setValue("https://models.example.test/v1");
    await model.setValue("local-model");
    expect((connectButton!.element as HTMLButtonElement).disabled).toBe(true);

    await baseUrl.setValue("http://127.0.0.1:11434/v1");
    expect((connectButton!.element as HTMLButtonElement).disabled).toBe(false);
    expect(section.text()).toContain(
      "API key is optional because this HTTP(S) endpoint is on a loopback address.",
    );
    expect(
      section.get('input[aria-label="OpenAI-compatible API key"]').attributes("placeholder"),
    ).toBe("API key (optional for loopback)");

    await connectButton!.trigger("click");
    await flushPromises();
    expect(connect).toHaveBeenCalledWith("compatible", "", {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
    });
  });

  it("shows the saved destination and manual-model fallback when discovery is unavailable", async () => {
    const store = useStore();
    store.aiCatalog = [
      {
        id: "compatible",
        label: "OpenAI-compatible",
        keyPlaceholder: "sk-…",
        customBaseUrl: true,
      },
    ];
    store.aiSettings = {
      ...store.aiSettings,
      providers: {
        compatible: {
          configured: true,
          model: "acme/chat",
          baseUrl: "https://models.example.test/v1",
        },
      },
      defaultProvider: "compatible",
    };
    vi.spyOn(store, "listProviderModels").mockResolvedValue({
      models: [{ id: "acme/chat", label: "acme/chat" }],
      discoveryAvailable: false,
    });

    const section = mountSection();
    await flushPromises();
    const providerButton = section
      .findAll("button")
      .find((button) => button.text().includes("OpenAI-compatible"));
    expect(providerButton).toBeDefined();
    await providerButton!.trigger("click");
    await flushPromises();

    expect(section.text()).toContain(
      "Selected diffs and prompts are sent to https://models.example.test/v1/chat/completions",
    );
    expect(section.text()).toContain(
      "This endpoint did not provide a model list. RepoYeti is using your saved manual model instead.",
    );
    expect(section.text()).not.toContain("AI Pass");
  });
});
