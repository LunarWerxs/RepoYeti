import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, ref } from "vue";
import { i18n } from "@/i18n";
import { api } from "@/api";
import { useStore } from "@/store";
import type { Share } from "@/types";
import RemoteAccess from "@/components/RemoteAccess.vue";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const RELAY = "https://app.repoyeti.com/r/0123456789abcdef";
const DIRECT = "https://temporary-name.trycloudflare.com";

function share(patch: Partial<Share> = {}): Share {
  return {
    id: "share-1",
    label: "Design review",
    perm: "view",
    collaborative: true,
    scopeAll: true,
    repoIds: [],
    createdAt: 0,
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    live: true,
    origin: RELAY,
    stale: false,
    url: `${RELAY}/#share-token`,
    ...patch,
  };
}

function mountRemote() {
  const host = defineComponent({
    components: { RemoteAccess },
    setup: () => ({ open: ref(true) }),
    template: '<RemoteAccess v-model:open="open" />',
  });
  return mount(host, {
    global: {
      plugins: [i18n],
      stubs: {
        teleport: true,
        Dialog: { template: "<div><slot /></div>" },
        DialogContent: { template: "<section><slot /></section>" },
        DialogHeader: { template: "<header><slot /></header>" },
        DialogTitle: { template: "<h2><slot /></h2>" },
        DialogDescription: { template: "<p><slot /></p>" },
        Tooltip: { template: "<span><slot /></span>" },
        TooltipTrigger: { template: "<span><slot /></span>" },
        TooltipContent: { template: "<span><slot /></span>" },
      },
    },
    attachTo: document.body,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RemoteAccess — stable address and existing shares", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useStore();
    store.mode = "remote";
    store.tunnelUrl = DIRECT;
    store.relayConfig = {
      enabled: true,
      url: "https://app.repoyeti.com",
      id: "0123456789abcdef",
      defaultUrl: "https://app.repoyeti.com",
    };
    store.relayUrl = RELAY;
    store.relayAnnounced = true;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the stable hosted address and the retained existing share link", async () => {
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [share()] });
    const wrapper = mountRemote();
    await flush();

    expect(wrapper.text()).toContain(RELAY);
    expect(wrapper.text()).not.toContain(DIRECT);
    expect(wrapper.text()).toContain(`${RELAY}/#share-token`);
    expect(wrapper.text()).toContain(i18n.global.t("remote.shareManage"));

    const remote = wrapper.findComponent(RemoteAccess);
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes(i18n.global.t("remote.shareManage")))!
      .trigger("click");
    expect(remote.emitted("shareLinks")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps the compact create action when no live share exists", async () => {
    vi.spyOn(api, "listShares").mockResolvedValue({ shares: [] });
    const wrapper = mountRemote();
    await flush();

    expect(wrapper.text()).toContain(i18n.global.t("remote.shareNewTitle"));
    expect(wrapper.text()).toContain(i18n.global.t("remote.shareCta"));
    expect(wrapper.text()).not.toContain(i18n.global.t("remote.shareManage"));
    wrapper.unmount();
  });
});
