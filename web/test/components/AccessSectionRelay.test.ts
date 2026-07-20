// Regression cover for the stable-address panel in AccessSection.vue.
//
// The relay's on/off Switch is gone — the stable address is DEFAULT-ON daemon-side (see
// config.ts relayEffective) and the only toggle left is "Custom address". What must not
// regress now:
//   · the default (relay) address renders with its registered/pending truth-telling,
//   · saving a self-hosted relay sends {url} and nothing else,
//   · the Custom-address switch never removes a configured domain without the inline confirm.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import AccessSection from "@/components/settings/AccessSection.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const RELAY_DEFAULT = "https://go.repoyeti.com";

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

/** The Custom-address Switch, found by the aria-label the panel gives it. */
function customSwitch(wrapper: ReturnType<typeof mountAccess>) {
  return wrapper
    .findAll('[role="switch"]')
    .find((s) => s.attributes("aria-label") === i18n.global.t("settings.customAddress"));
}

describe("AccessSection — stable address panel", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("shows the default relay address + registered state, with no relay on/off switch", async () => {
    const store = useStore();
    store.mode = "remote";
    store.relayConfig = { enabled: true, url: RELAY_DEFAULT, id: "a".repeat(32), defaultUrl: RELAY_DEFAULT };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"a".repeat(32)}`;
    store.relayAnnounced = true;

    const wrapper = mountAccess();
    expect(wrapper.text()).toContain(`${RELAY_DEFAULT}/r/${"a".repeat(32)}`);
    expect(wrapper.text()).toContain(i18n.global.t("settings.relayRegistered"));
    // The old consent switch is gone — the only switches left are access mode + custom address.
    const labels = wrapper.findAll('[role="switch"]').map((s) => s.attributes("aria-label"));
    expect(labels).toContain(i18n.global.t("settings.customAddress"));
    expect(labels).not.toContain("Permanent link");
  });

  it("saving a self-hosted relay sends {url} alone", async () => {
    const store = useStore();
    store.mode = "remote";
    store.relayConfig = { enabled: true, url: RELAY_DEFAULT, id: "a".repeat(32), defaultUrl: RELAY_DEFAULT };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"a".repeat(32)}`;
    store.relayAnnounced = true;
    const spy = vi.spyOn(store, "setRelay").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    const advanced = wrapper
      .findAll("button")
      .find((b) => b.text() === i18n.global.t("settings.relayShowAdvanced"))!;
    await advanced.trigger("click");
    const input = wrapper.find(`input[aria-label="${i18n.global.t("settings.relayUrlLabel")}"]`);
    await input.setValue("https://relay.example");
    const save = wrapper
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.relaySave")))!;
    await save.trigger("click");

    expect(spy).toHaveBeenCalledWith({ url: "https://relay.example" });
  });

  it("switching Custom address off with a configured domain arms a confirm instead of removing it", async () => {
    const store = useStore();
    store.mode = "remote";
    store.tunnelConfig = { named: true, hostname: "app.example.com", hasToken: true, tokenFromEnv: false };
    const spy = vi.spyOn(store, "setTunnel").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    const sw = customSwitch(wrapper)!;
    expect(sw.attributes("aria-checked")).toBe("true"); // reflects the configured domain
    await sw.trigger("click"); // attempt to turn OFF
    // Nothing destroyed yet — the inline confirm is showing instead.
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(i18n.global.t("settings.customAddressRemove"));
    // Confirming actually removes it (hostname + token cleared in one call).
    const remove = wrapper
      .findAll("button")
      .find((b) => b.text().includes(i18n.global.t("settings.customAddressRemove")))!;
    await remove.trigger("click");
    expect(spy).toHaveBeenCalledWith({ hostname: "", token: "" });
  });
});
