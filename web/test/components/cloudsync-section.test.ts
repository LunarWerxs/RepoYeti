// Regression coverage for CloudSyncSection.vue's "Sync now" button.
//
// pullSync/pushSync do not throw on a handled daemon failure — the route answers HTTP 200 with
// {ok:false, error, retryAfterSeconds} and the store absorbs it into syncError. The button used to
// rely on the try/catch alone, so it toasted a green "settings.cloudSync.pushDone" on exactly the
// path that means nothing was pushed or pulled. The fix inspects the returned status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { api } from "@/api";
import type { SyncStatus } from "@/api";
import CloudSyncSection from "@/components/settings/CloudSyncSection.vue";
import { toast } from "vue-sonner";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    ok: true,
    enabled: true,
    connected: true,
    lastSyncedAt: null,
    version: 1,
    appearance: null,
    ...overrides,
  };
}

function mountSection() {
  const store = useStore();
  store.owner = "owner@example.com";
  store.syncStatus = syncStatus();
  const wrapper = mount(CloudSyncSection, { global: { plugins: [i18n] } });
  const button = wrapper
    .findAll("button")
    .find((b) => b.text().includes(i18n.global.t("settings.cloudSync.syncNow")))!;
  return { wrapper, button };
}

describe("CloudSyncSection — Sync now", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("surfaces a pull failure instead of a green success toast", async () => {
    vi.spyOn(api, "syncPull").mockResolvedValue(
      syncStatus({ ok: false, error: "sync_failed", retryAfterSeconds: 30 }),
    );
    const push = vi.spyOn(api, "syncPush").mockResolvedValue(syncStatus());
    const { button } = mountSection();

    await button.trigger("click");
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith(i18n.global.t("settings.cloudSync.pullFailed"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("surfaces a push failure instead of a green success toast", async () => {
    vi.spyOn(api, "syncPull").mockResolvedValue(syncStatus());
    vi.spyOn(api, "syncPush").mockResolvedValue(
      syncStatus({ ok: false, error: "sync_failed" }),
    );
    const { button } = mountSection();

    await button.trigger("click");
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith(i18n.global.t("settings.cloudSync.pushFailed"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("still reports success when both legs genuinely succeed", async () => {
    vi.spyOn(api, "syncPull").mockResolvedValue(syncStatus());
    vi.spyOn(api, "syncPush").mockResolvedValue(syncStatus({ version: 2 }));
    const { button } = mountSection();

    await button.trigger("click");
    await flushPromises();

    expect(toast.success).toHaveBeenCalledWith(i18n.global.t("settings.cloudSync.pushDone"));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
