// Regression coverage for BuzzIntegrationSection.vue.
//
// A preflight result is evidence about exactly one community. The selection watcher clears the
// result on switch, so an in-flight response that resolves after the owner picked another community
// must not overwrite that cleared state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { BuzzCommunity, BuzzPreflight } from "@/types";
import BuzzIntegrationSection from "@/components/settings/BuzzIntegrationSection.vue";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const COMMUNITY_A: BuzzCommunity = { id: "a", name: "Community A", url: "https://a.example" };
const COMMUNITY_B: BuzzCommunity = { id: "b", name: "Community B", url: "https://b.example" };

const A_MESSAGE = "checked against A";

function preflightFor(message: string): BuzzPreflight {
  const check = { status: "pass" as const, code: "ok", message };
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    git: check,
    credentialHelper: check,
    useHttpPath: check,
    relay: check,
    authentication: check,
  };
}

function mountSection() {
  return mount(BuzzIntegrationSection, {
    props: { open: true },
    global: {
      plugins: [i18n],
      stubs: { teleport: true },
    },
  });
}

function runChecksButton(wrapper: ReturnType<typeof mountSection>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().includes(i18n.global.t("settings.buzzRunPreflight")))!;
}

describe("BuzzIntegrationSection — preflight belongs to one community", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("drops a response that resolves after the owner switched communities", async () => {
    const store = useStore();
    store.buzzEnabled = true;
    store.buzzCommunities = [COMMUNITY_A, COMMUNITY_B];
    vi.spyOn(store, "loadBuzzConfig").mockResolvedValue(undefined);

    let resolve!: (value: BuzzPreflight) => void;
    const pending = new Promise<BuzzPreflight>((r) => {
      resolve = r;
    });
    const spy = vi.spyOn(store, "runBuzzPreflight").mockReturnValue(pending);

    const wrapper = mountSection();
    await flushPromises();
    expect(wrapper.findComponent({ name: "Select" }).exists()).toBe(true);

    await runChecksButton(wrapper).trigger("click");
    await wrapper.vm.$nextTick();
    expect(spy).toHaveBeenCalledWith("a");

    // The owner switches the dropdown while the run is still in flight.
    wrapper.vm.selectedCommunityId = "b";
    await wrapper.vm.$nextTick();

    resolve(preflightFor(A_MESSAGE));
    await flushPromises();

    // Community A's rows must not reappear under Community B.
    expect(wrapper.text()).not.toContain(A_MESSAGE);
    expect(wrapper.text()).toContain(i18n.global.t("settings.buzzNotChecked"));
  });

  it("commits a response when the selection did not move", async () => {
    const store = useStore();
    store.buzzEnabled = true;
    store.buzzCommunities = [COMMUNITY_A, COMMUNITY_B];
    vi.spyOn(store, "loadBuzzConfig").mockResolvedValue(undefined);
    vi.spyOn(store, "runBuzzPreflight").mockResolvedValue(preflightFor(A_MESSAGE));

    const wrapper = mountSection();
    await flushPromises();

    await runChecksButton(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(A_MESSAGE);
  });
});
