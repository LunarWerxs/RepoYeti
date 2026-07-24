import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";

vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  return { ...actual, useEventSource: vi.fn() };
});

import { useEventSource } from "@vueuse/core";
import { api } from "@/api";
import { useStore } from "@/store";

describe("store daemon_status reconciliation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("keeps a healthy tunnel URL when a later relay-only patch reports an error", async () => {
    const status = ref<"OPEN" | "CONNECTING" | "CLOSED">("CLOSED");
    const event = ref<string | null>(null);
    const data = ref<string | null>(null);
    vi.mocked(useEventSource).mockReturnValue({
      status,
      event,
      data,
      error: ref(null),
      close: vi.fn(),
      open: vi.fn(),
    });
    vi.spyOn(api, "collaborationSnapshots").mockResolvedValue({ snapshots: [] });

    const store = useStore();
    store.connect();

    event.value = "daemon_status";
    data.value = JSON.stringify({
      tunnelUrl: "https://temporary.trycloudflare.com",
      tunnelActive: true,
    });
    await nextTick();
    expect(store.tunnelUrl).toBe("https://temporary.trycloudflare.com");

    data.value = JSON.stringify({
      relayUrl: "https://app.repoyeti.com/r/stable",
      relayAnnounced: false,
      relayError: "bad signature",
    });
    await nextTick();

    expect(store.tunnelUrl).toBe("https://temporary.trycloudflare.com");
    expect(store.tunnelActive).toBe(true);
    expect(store.relayAnnounced).toBe(false);
    expect(store.relayError).toBe("bad signature");
  });
});
