// Regression coverage for the cloud-sync store (web/src/store/settings-cloud-sync.ts): a manual
// pull/push must not echo the just-applied remote appearance straight back out, while a genuine
// owner theme change still pushes (debounced). One store per file — the composable installs a
// module-level watcher on the shared theme singleton that never stops, so a per-test store would
// leave its watcher behind and inflate the push counts.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import type { SyncStatus } from "@/api";
import { useTheme } from "@/lib/theme";

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

/** Let Vue's pre-flush watchers run (they are scheduled on a microtask). */
async function flushWatchers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("cloud-sync store — no echo of a just-applied remote appearance", () => {
  let store: ReturnType<typeof useStore>;

  beforeAll(() => {
    setActivePinia(createPinia());
    store = useStore();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    // Reset to a known theme, then drop any debounce the reset itself armed — each test starts
    // with no push in flight.
    useTheme().setTheme("dark");
    await flushWatchers();
    vi.clearAllTimers();
    store.syncStatus = syncStatus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not push back after pullSync applies a different remote theme", async () => {
    vi.spyOn(api, "syncPull").mockResolvedValue(
      syncStatus({ version: 2, appearance: { theme: "light" } }),
    );
    const setSyncSpy = vi.spyOn(api, "setSync").mockResolvedValue(syncStatus({ version: 3 }));

    await store.pullSync();
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    expect(useTheme().mode.value).toBe("light");
    expect(setSyncSpy).not.toHaveBeenCalled();
  });

  it("does not push back after pushSync returns a different appearance", async () => {
    vi.spyOn(api, "syncPush").mockResolvedValue(
      syncStatus({ version: 2, appearance: { theme: "light" } }),
    );
    const setSyncSpy = vi.spyOn(api, "setSync").mockResolvedValue(syncStatus({ version: 3 }));

    await store.pushSync();
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    expect(useTheme().mode.value).toBe("light");
    expect(setSyncSpy).not.toHaveBeenCalled();
  });

  it("still pushes a genuine owner theme change while enabled+connected", async () => {
    const setSyncSpy = vi.spyOn(api, "setSync").mockResolvedValue(syncStatus({ version: 2 }));

    useTheme().setTheme("light");
    await flushWatchers();
    expect(setSyncSpy).not.toHaveBeenCalled(); // debounced, not immediate
    await vi.advanceTimersByTimeAsync(1000);

    expect(setSyncSpy).toHaveBeenCalledOnce();
  });

  it("still pushes an owner theme change made after a pushed-back remote appearance", async () => {
    vi.spyOn(api, "syncPull").mockResolvedValue(
      syncStatus({ version: 2, appearance: { theme: "light" } }),
    );
    await store.pullSync();
    await flushWatchers();
    vi.clearAllTimers();

    const setSyncSpy = vi.spyOn(api, "setSync").mockResolvedValue(syncStatus({ version: 3 }));
    useTheme().setTheme("dark");
    await flushWatchers();
    await vi.advanceTimersByTimeAsync(1000);

    expect(setSyncSpy).toHaveBeenCalledOnce();
  });
});
