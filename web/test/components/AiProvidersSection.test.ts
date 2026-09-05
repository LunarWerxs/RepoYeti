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
    // A configured provider also triggers the key-pool status fetch on mount (see
    // AiProvidersSection's open-watcher): mock it too, same as listProviderModels above, so
    // this test isn't exercising a real network call.
    vi.spyOn(store, "loadKeyPool").mockResolvedValue(undefined);

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

describe("AiProvidersSection - backup key pool (src/ai/credential-pool.ts)", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  function configureGroq() {
    const store = useStore();
    store.aiCatalog = [{ id: "groq", label: "Groq", keyPlaceholder: "gsk_…" }];
    store.aiSettings = {
      ...store.aiSettings,
      providers: { groq: { configured: true, model: "llama-3.3-70b-versatile" } },
      defaultProvider: "groq",
    };
    vi.spyOn(store, "listProviderModels").mockResolvedValue({
      models: [{ id: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile" }],
      discoveryAvailable: true,
    });
    return store;
  }

  async function openGroqRow(section: VueWrapper): Promise<void> {
    const providerButton = section.findAll("button").find((b) => b.text().includes("Groq"));
    expect(providerButton).toBeDefined();
    await providerButton!.trigger("click");
    await flushPromises();
  }

  it("shows masked fingerprints and health for the pool, never a raw key", async () => {
    const store = configureGroq();
    vi.spyOn(store, "loadKeyPool").mockResolvedValue(undefined);
    store.keyPools = {
      groq: {
        provider: "groq",
        total: 2,
        available: 1,
        entries: [
          { id: "gsk_…aaaa1111", status: "ok", successes: 4, failures: 0, lastError: null, lastUsedAt: 1 },
          {
            id: "gsk_…bbbb2222",
            status: "cooldown",
            successes: 0,
            failures: 2,
            lastError: "rate limited",
            lastUsedAt: 2,
          },
        ],
      },
    };

    const section = mountSection();
    await flushPromises();
    await openGroqRow(section);

    expect(section.text()).toContain("gsk_…aaaa1111");
    expect(section.text()).toContain("gsk_…bbbb2222");
    expect(section.text()).toContain(i18n.global.t("settings.aiKeyStatusOk"));
    expect(section.text()).toContain(i18n.global.t("settings.aiKeyStatusCooldown"));
    // The real secret value must never reach the rendered DOM.
    expect(section.text()).not.toContain("rate limited");
  });

  it("adding a row then saving replaces the pool with exactly the typed keys", async () => {
    const store = configureGroq();
    vi.spyOn(store, "loadKeyPool").mockResolvedValue(undefined);
    const setKeyPool = vi.spyOn(store, "setKeyPool").mockResolvedValue(undefined);

    const section = mountSection();
    await flushPromises();
    await openGroqRow(section);

    const addButton = section
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.aiKeyPoolAdd")));
    expect(addButton).toBeDefined();
    await addButton!.trigger("click");
    await nextTick();

    const keyInput = section.get(
      `input[aria-label="${i18n.global.t("settings.aiKeyPoolEntryLabel", { n: 1 })}"]`,
    );
    await keyInput.setValue("extra-backup-key");

    const saveButton = section
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.aiKeyPoolSave")));
    expect(saveButton).toBeDefined();
    await saveButton!.trigger("click");
    await flushPromises();

    expect(setKeyPool).toHaveBeenCalledWith("groq", ["extra-backup-key"]);
  });

  it("removing a row before saving drops it from the submitted list", async () => {
    const store = configureGroq();
    vi.spyOn(store, "loadKeyPool").mockResolvedValue(undefined);
    const setKeyPool = vi.spyOn(store, "setKeyPool").mockResolvedValue(undefined);

    const section = mountSection();
    await flushPromises();
    await openGroqRow(section);

    const addLabel = i18n.global.t("settings.aiKeyPoolAdd");
    const addButton = () => section.findAll("button").find((b) => b.text().includes(addLabel));
    await addButton()!.trigger("click");
    await nextTick();
    await addButton()!.trigger("click");
    await nextTick();

    await section
      .get(`input[aria-label="${i18n.global.t("settings.aiKeyPoolEntryLabel", { n: 1 })}"]`)
      .setValue("keep-me");
    await section
      .get(`input[aria-label="${i18n.global.t("settings.aiKeyPoolEntryLabel", { n: 2 })}"]`)
      .setValue("drop-me");

    const removeButton = section
      .findAll(`button[aria-label="${i18n.global.t("settings.aiKeyPoolRemove")}"]`)
      .at(1); // remove the SECOND row ("drop-me")
    expect(removeButton).toBeDefined();
    await removeButton!.trigger("click");
    await nextTick();

    const saveButton = section
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.aiKeyPoolSave")));
    await saveButton!.trigger("click");
    await flushPromises();

    expect(setKeyPool).toHaveBeenCalledWith("groq", ["keep-me"]);
  });
});
