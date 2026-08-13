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
import type { UpdateStatus } from "@/types";

/**
 * The two halves of "an update is available" that have to agree with each other: the Settings
 * version badge (drawn from /api/updates) and the offer dialog (prepared from whatever the last
 * SSE announcement said). Issue #20 made the badge an entry point into that dialog, which only
 * works if both are looking at the same answer.
 */

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ok: true,
    service: "repoyeti",
    currentVersion: "0.20.7",
    currentCommit: "1111111",
    remoteCommit: "2222222",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: true,
    canApply: true,
    checkedAt: 0,
    reason: null,
    ...overrides,
  };
}

/** Wire the mocked SSE stream and hand back the refs that drive it. */
function stubEvents() {
  const event = ref<string | null>(null);
  const data = ref<string | null>(null);
  vi.mocked(useEventSource).mockReturnValue({
    status: ref<"OPEN" | "CONNECTING" | "CLOSED">("CLOSED"),
    event,
    data,
    error: ref(null),
    close: vi.fn(),
    open: vi.fn(),
  });
  vi.spyOn(api, "collaborationSnapshots").mockResolvedValue({ snapshots: [] });
  return { event, data };
}

const announce = (canApply = true, reason: string | null = null): string =>
  JSON.stringify({ from: "1111111", to: "2222222", canApply, reason });

describe("update status and the offer that reads it", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // `updateStatus` is filled once, at boot. The daemon's scheduled check runs hours later, so an
  // announcement used to reach the bell while the Settings Version row — same fact, other screen —
  // went on saying there was nothing to install, and the badge that opens the offer never appeared.
  it("re-reads /api/updates when the daemon announces one", async () => {
    const { event, data } = stubEvents();
    vi.spyOn(api, "checkUpdate").mockResolvedValue(status());

    const store = useStore();
    store.connect();

    event.value = "update_available";
    data.value = announce();
    await nextTick();

    await vi.waitFor(() => expect(api.checkUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.updateStatus?.updateAvailable).toBe(true));
  });

  // /api/updates is owner-only; a guest asking would only 403. Same gate the boot check uses.
  it("doesn't ask on behalf of a guest", async () => {
    const { event, data } = stubEvents();
    vi.spyOn(api, "checkUpdate").mockResolvedValue(status());

    const store = useStore();
    store.shareViewer = { label: "Guest", perm: "view", expiresAt: null, collaborative: true };
    store.connect();

    event.value = "update_available";
    data.value = announce();
    await nextTick();

    expect(api.checkUpdate).not.toHaveBeenCalled();
  });

  describe("openUpdatePrompt", () => {
    it("prefers the current status over the announcement that raised the offer", () => {
      // The announcement said "dirty tree" hours ago; the tree has been committed since. Opening
      // from either the bell or the Settings badge must not refuse an install the daemon accepts.
      const store = useStore();
      store.updateBlockedReason = "local changes must be committed or stashed before updating";
      store.updateStatus = status({ canApply: true, reason: null });

      store.openUpdatePrompt();

      expect(store.updatePromptOpen).toBe(true);
      expect(store.updateBlockedReason).toBeNull();
    });

    it("keeps the announcement's reason when there is no status to prefer", () => {
      // A guest, or a check that failed: a stale reason still beats silently offering an install
      // that will be refused.
      const store = useStore();
      store.updateBlockedReason = "detached HEAD";

      store.openUpdatePrompt();

      expect(store.updatePromptOpen).toBe(true);
      expect(store.updateBlockedReason).toBe("detached HEAD");
    });
  });
});
