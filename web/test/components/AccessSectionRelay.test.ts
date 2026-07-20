// Regression cover for the relay toggle's payload shape in AccessSection.vue.
//
// The Advanced "use a different relay" field and the on/off Switch share one ref. Turning the relay
// ON deliberately carries a typed address along, so "type your own relay, then flip it on" works
// without a separate Save. Turning it OFF must NOT: sweeping up text the owner typed but never
// confirmed would silently repoint cfg.relay.url at a host they were still considering, and the
// daemon would then announce against it the next time the relay was enabled.
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

const RELAY_DEFAULT = "https://repoyeti-relay.lunawerx.workers.dev";

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

/** The relay Switch, found by the aria-label the panel gives it. */
function relaySwitch(wrapper: ReturnType<typeof mountAccess>) {
  return wrapper
    .findAll('[role="switch"]')
    .find((s) => s.attributes("aria-label") === i18n.global.t("settings.relayLabel"));
}

describe("AccessSection — relay toggle payload", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("turning the relay ON with no typed address lets the daemon pick its default", async () => {
    const store = useStore();
    store.mode = "remote";
    const spy = vi.spyOn(store, "setRelay").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    await relaySwitch(wrapper)?.trigger("click");

    expect(spy).toHaveBeenCalledWith({ enabled: true });
  });

  it("turning the relay OFF sends the flag ALONE, never an unsaved typed address", async () => {
    const store = useStore();
    store.mode = "remote";
    store.relayConfig = { enabled: true, url: RELAY_DEFAULT, id: "a".repeat(32), defaultUrl: RELAY_DEFAULT };
    store.relayUrl = `${RELAY_DEFAULT}/r/${"a".repeat(32)}`;
    store.relayAnnounced = true;
    const spy = vi.spyOn(store, "setRelay").mockResolvedValue(undefined);

    const wrapper = mountAccess();
    // The owner opens Advanced and types a candidate relay, but never hits Save…
    await wrapper.find("button.self-start").trigger("click");
    const input = wrapper.find(`input[aria-label="${i18n.global.t("settings.relayUrlLabel")}"]`);
    await input.setValue("https://scratch.example");
    // …then changes their mind and just switches the relay off.
    await relaySwitch(wrapper)?.trigger("click");

    expect(spy).toHaveBeenCalledWith({ enabled: false });
    // The half-typed host must not have been persisted as the relay to use.
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ url: "https://scratch.example" }));
  });
});
