// Focused coverage for the debounced multi-pref cloud-sync auto-push added to
// web/src/store/settings.ts (the `pushPrefsTimer` watcher over all PREF_KEYS refs). Mirrors the
// existing theme/appearance watcher's guards (enabled + connected + not loading) and 800ms debounce.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import type { SyncStatus } from "@/api";

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

describe("settings store — debounced cloud-sync pref auto-push", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pushes once, debounced 800ms, after a single pref change while enabled+connected", async () => {
    const store = useStore();
    store.syncStatus = syncStatus();
    const pushSpy = vi.spyOn(api, "syncPush").mockResolvedValue(syncStatus({ version: 2 }));

    store.diffStatsEnabled = true;
    await vi.advanceTimersByTimeAsync(799);
    expect(pushSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(pushSpy).toHaveBeenCalledOnce();
  });

  it("coalesces rapid changes across MULTIPLE prefs into a single push (debounce resets per change)", async () => {
    const store = useStore();
    store.syncStatus = syncStatus();
    const pushSpy = vi.spyOn(api, "syncPush").mockResolvedValue(syncStatus({ version: 2 }));

    store.diffStatsEnabled = true;
    await vi.advanceTimersByTimeAsync(400);
    store.autoScan = true;
    await vi.advanceTimersByTimeAsync(400);
    store.autoCommitIntervalSecs = 1234;
    await vi.advanceTimersByTimeAsync(400);
    // Still within 800ms of the last change — no push yet.
    expect(pushSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(pushSpy).toHaveBeenCalledOnce(); // one push for all three changes
  });

  it("does NOT push when sync is disabled", async () => {
    const store = useStore();
    store.syncStatus = syncStatus({ enabled: false });
    const pushSpy = vi.spyOn(api, "syncPush");

    store.remoteEditing = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("does NOT push when sync is enabled but not connected (signed out)", async () => {
    const store = useStore();
    store.syncStatus = syncStatus({ connected: false });
    const pushSpy = vi.spyOn(api, "syncPush");

    store.keepInSync = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("is silent/best-effort on failure — never throws out of the watcher, never busy-flags Sync Now", async () => {
    const store = useStore();
    store.syncStatus = syncStatus();
    vi.spyOn(api, "syncPush").mockRejectedValue(new Error("network blip"));

    store.autoCommitPull = false;
    await vi.advanceTimersByTimeAsync(1000);

    // The failure must not surface as syncError or flip the manual-push busy flag.
    expect(store.syncActionBusy).toBe(false);
  });

  it("adopts the returned status (e.g. bumped version) on a successful auto-push", async () => {
    const store = useStore();
    store.syncStatus = syncStatus({ version: 5 });
    vi.spyOn(api, "syncPush").mockResolvedValue(syncStatus({ version: 6 }));

    store.diffPatchEnabled = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.syncStatus.version).toBe(6);
  });
});
