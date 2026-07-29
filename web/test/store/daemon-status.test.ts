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
import type { Repo } from "@/types";

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    name: "repo",
    displayName: null,
    absPath: "D:/repo",
    source: "pinned",
    vcs: "git",
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("store daemon_status reconciliation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("keeps one SSE connection and releases its watches on disconnect", async () => {
    const status = ref<"OPEN" | "CONNECTING" | "CLOSED">("CLOSED");
    const event = ref<string | null>(null);
    const data = ref<string | null>(null);
    const close = vi.fn();
    vi.mocked(useEventSource).mockReturnValue({
      status,
      event,
      data,
      error: ref(null),
      close,
      open: vi.fn(),
    });
    vi.spyOn(api, "collaborationSnapshots").mockResolvedValue({ snapshots: [] });

    const store = useStore();
    store.connect();
    store.connect();
    expect(useEventSource).toHaveBeenCalledOnce();

    status.value = "OPEN";
    await nextTick();
    expect(store.connected).toBe(true);

    store.disconnect();
    expect(close).toHaveBeenCalledOnce();
    expect(store.connected).toBe(false);

    status.value = "OPEN";
    await nextTick();
    expect(store.connected).toBe(false);
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

  it("does not duplicate a locally-added repo when its repo_added SSE echo arrives", async () => {
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
    vi.spyOn(api, "registerRepo").mockResolvedValue(repo());

    const store = useStore();
    store.connect();

    // Build the O(1) lookup before the local add. A direct array push used to leave that lookup
    // unaware of the new repo, so the subsequent SSE upsert appended a duplicate.
    event.value = "repo_state_changed";
    data.value = JSON.stringify({ id: "not-present", status: null });
    await nextTick();

    await store.addRepo("register", "D:/repo");
    event.value = "repo_added";
    data.value = JSON.stringify({ repo: repo({ displayName: "From SSE", updatedAt: 2 }) });
    await nextTick();

    expect(store.repos).toHaveLength(1);
    expect(store.repos[0]?.displayName).toBe("From SSE");
  });
});
