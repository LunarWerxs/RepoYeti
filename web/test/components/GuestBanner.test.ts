import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import GuestBanner from "@/components/GuestBanner.vue";

describe("GuestBanner", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("turns Leave into the store's explicit share-exit flow", async () => {
    const store = useStore();
    store.shareViewer = {
      label: "Guest",
      perm: "view",
      expiresAt: null,
      collaborative: true,
    };
    const leave = vi.spyOn(store, "leaveShare").mockResolvedValue();
    const wrapper = mount(GuestBanner, { global: { plugins: [i18n] } });

    await wrapper.get("button").trigger("click");

    expect(leave).toHaveBeenCalledOnce();
  });
});
