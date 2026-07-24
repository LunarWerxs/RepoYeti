// Regression coverage for the explicit address chooser in AccessSection.vue.
//
// The address is no longer an advanced relay URL plus a separate custom-domain switch. Remote
// access offers exactly three user-facing choices: RepoYeti's hosted app address, the generated
// Cloudflare quick-tunnel address, or a named custom domain.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import AccessSection from "@/components/settings/AccessSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const RELAY_DEFAULT = "https://app.repoyeti.com";

function mountAccess() {
  return mount(AccessSection, {
    props: { open: true },
    global: {
      plugins: [i18n],
      components: { TooltipProvider },
      stubs: { teleport: true },
    },
  });
}

function choice(wrapper: ReturnType<typeof mountAccess>, key: "hosted" | "cloudflare" | "custom") {
  return wrapper
    .findAll("button")
    .find((button) => button.text().includes(i18n.global.t(`settings.address.${key}`)))!;
}

async function revealChoices(wrapper: ReturnType<typeof mountAccess>) {
  const button = wrapper
    .findAll("button")
    .find((candidate) => candidate.text().includes(i18n.global.t("settings.addressChange")))!;
  await button.trigger("click");
}

describe("AccessSection — address choices", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("shows app.repoyeti.com as the zero-input default behind progressive disclosure", async () => {
    const store = useStore();
    store.mode = "remote";
    store.relayConfig = {
      enabled: true,
      url: RELAY_DEFAULT,
      id: "a".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"a".repeat(32)}`;
    store.relayAnnounced = true;

    const wrapper = mountAccess();
    expect(wrapper.text()).toContain(`${RELAY_DEFAULT}/r/${"a".repeat(32)}`);
    expect(wrapper.text()).toContain(i18n.global.t("settings.relayRegistered"));
    expect(choice(wrapper, "cloudflare")).toBeUndefined();
    expect(choice(wrapper, "custom")).toBeUndefined();

    await revealChoices(wrapper);
    expect(choice(wrapper, "hosted").attributes("class")).toContain("border-primary");
    expect(choice(wrapper, "cloudflare").exists()).toBe(true);
    expect(choice(wrapper, "custom").exists()).toBe(true);
    expect(wrapper.find(`input[aria-label="${i18n.global.t("settings.tunnelHostLabel")}"]`).exists()).toBe(
      false,
    );
  });

  it("selecting Cloudflare uses the generated quick-tunnel address", async () => {
    const store = useStore();
    store.mode = "remote";
    store.tunnelUrl = "https://snowy-yeti.trycloudflare.com";
    store.relayConfig = {
      enabled: true,
      url: RELAY_DEFAULT,
      id: "a".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    const relaySpy = vi.spyOn(store, "setRelay").mockImplementation(async (patch) => {
      store.relayConfig.enabled = patch.enabled ?? store.relayConfig.enabled;
      store.relayUrl = null;
    });

    const wrapper = mountAccess();
    await revealChoices(wrapper);
    await choice(wrapper, "cloudflare").trigger("click");

    expect(relaySpy).toHaveBeenCalledWith({ enabled: false, url: "" });
    expect(wrapper.text()).toContain("https://snowy-yeti.trycloudflare.com");
    expect(wrapper.text()).toContain(i18n.global.t("settings.address.cloudflareNotice"));
  });

  it("a custom domain is explicit and saves through the named-tunnel settings", async () => {
    const store = useStore();
    store.mode = "remote";
    store.relayConfig = {
      enabled: true,
      url: RELAY_DEFAULT,
      id: "a".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    const spy = vi.spyOn(store, "setTunnel").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    await revealChoices(wrapper);
    await choice(wrapper, "custom").trigger("click");
    await wrapper
      .find(`input[aria-label="${i18n.global.t("settings.tunnelHostLabel")}"]`)
      .setValue("work.example.com");
    await wrapper
      .find(`input[aria-label="${i18n.global.t("settings.tunnelTokenLabel")}"]`)
      .setValue("cloudflare-token");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes(i18n.global.t("settings.tunnelSave")))!
      .trigger("click");

    expect(spy).toHaveBeenCalledWith({
      hostname: "work.example.com",
      token: "cloudflare-token",
    });
  });

  it("leaving a named custom domain clears it before selecting the hosted default", async () => {
    const store = useStore();
    store.mode = "remote";
    store.tunnelConfig = {
      named: true,
      hostname: "work.example.com",
      hasToken: true,
      tokenFromEnv: false,
    };
    store.relayConfig = {
      enabled: false,
      url: RELAY_DEFAULT,
      id: "a".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    const tunnelSpy = vi.spyOn(store, "setTunnel").mockImplementation(async () => {
      store.tunnelConfig = { named: false, hostname: null, hasToken: false, tokenFromEnv: false };
    });
    const relaySpy = vi.spyOn(store, "setRelay").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    await revealChoices(wrapper);
    await choice(wrapper, "hosted").trigger("click");

    expect(tunnelSpy).toHaveBeenCalledWith({ hostname: "", token: "" });
    expect(relaySpy).toHaveBeenCalledWith({ enabled: true, url: "" });
  });

  it("updates a panel that mounted before relay status finished loading", async () => {
    const store = useStore();
    store.mode = "remote";
    store.tunnelUrl = "https://temporary.trycloudflare.com";
    store.relayConfig = {
      enabled: false,
      url: null,
      id: null,
      defaultUrl: RELAY_DEFAULT,
    };
    const wrapper = mountAccess();
    expect(wrapper.text()).toContain(i18n.global.t("settings.address.cloudflareNotice"));

    store.relayConfig = {
      enabled: true,
      url: RELAY_DEFAULT,
      id: "b".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"b".repeat(32)}`;
    store.relayAnnounced = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(i18n.global.t("settings.address.hosted"));
    expect(wrapper.text()).toContain(`${RELAY_DEFAULT}/r/${"b".repeat(32)}`);
    expect(wrapper.text()).not.toContain(i18n.global.t("settings.address.cloudflareNotice"));
  });

  it("shows the relay failure instead of claiming it is still connecting", async () => {
    const store = useStore();
    store.mode = "remote";
    store.tunnelUrl = "https://temporary.trycloudflare.com";
    store.relayConfig = {
      enabled: true,
      url: RELAY_DEFAULT,
      id: "c".repeat(32),
      defaultUrl: RELAY_DEFAULT,
    };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"c".repeat(32)}`;
    store.relayAnnounced = false;
    store.relayError = "bad signature";

    const wrapper = mountAccess();

    expect(wrapper.text()).toContain(
      i18n.global.t("settings.relayFailed", { error: "bad signature" }),
    );
    expect(wrapper.text()).not.toContain(i18n.global.t("settings.relayPending"));
  });
});
