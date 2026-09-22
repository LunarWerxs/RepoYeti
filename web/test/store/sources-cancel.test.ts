/**
 * Cancelling a scan / a fetch-all from the UI.
 *
 * The daemon's cancel answers `{ ok, cancelled }`, where `cancelled: false` means there was no job
 * to stop — so no `scan_cancelled` / `fetch_all_cancelled` terminal event is coming. A client whose
 * `scanning` / `fetchingAll` was stale (e.g. the terminal frame was lost) would otherwise sit on
 * "Stopping…" forever with the control disabled and nothing able to settle it. These pin both
 * directions: settle locally when the daemon says nothing was running, keep waiting when it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { api } from "@/api";
import { useStore } from "@/store";

describe("sources: cancelling a scan", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("settles the modal locally when the daemon had no scan to cancel", async () => {
    const store = useStore();
    store.scanning = true;
    store.scanDone = false;
    vi.spyOn(api, "cancelScan").mockResolvedValue({ ok: true, cancelled: false });

    await store.cancelScan();

    // No scan_cancelled event will arrive — leaving "Stopping…" here would be forever.
    expect(store.scanning).toBe(false);
    expect(store.scanDone).toBe(true);
    expect(store.scanCancelRequested).toBe(false);
  });

  it("keeps waiting for the terminal event when the daemon did stop a scan", async () => {
    const store = useStore();
    store.scanning = true;
    vi.spyOn(api, "cancelScan").mockResolvedValue({ ok: true, cancelled: true });

    await store.cancelScan();

    // The scan_cancelled broadcast settles lastScanCancelled; until then this stays optimistic.
    expect(store.scanning).toBe(true);
    expect(store.scanCancelRequested).toBe(true);
  });

  it("rolls the optimistic state back when the request itself fails", async () => {
    const store = useStore();
    store.scanning = true;
    vi.spyOn(api, "cancelScan").mockRejectedValue(new Error("offline"));

    await expect(store.cancelScan()).rejects.toThrow("offline");

    expect(store.scanCancelRequested).toBe(false);
    expect(store.scanning).toBe(true);
  });
});

describe("sources: cancelling a fetch-all", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("settles the control locally when the daemon had no sweep to cancel", async () => {
    const store = useStore();
    store.fetchingAll = true;
    vi.spyOn(api, "cancelFetchAll").mockResolvedValue({ ok: true, cancelled: false });

    await store.cancelFetchAll();

    expect(store.fetchingAll).toBe(false);
    expect(store.fetchAllCancelRequested).toBe(false);
  });

  it("keeps waiting for the terminal event when the daemon did stop a sweep", async () => {
    const store = useStore();
    store.fetchingAll = true;
    vi.spyOn(api, "cancelFetchAll").mockResolvedValue({ ok: true, cancelled: true });

    await store.cancelFetchAll();

    expect(store.fetchingAll).toBe(true);
    expect(store.fetchAllCancelRequested).toBe(true);
  });

  it("rolls the optimistic state back when the request itself fails", async () => {
    const store = useStore();
    store.fetchingAll = true;
    vi.spyOn(api, "cancelFetchAll").mockRejectedValue(new Error("offline"));

    await expect(store.cancelFetchAll()).rejects.toThrow("offline");

    expect(store.fetchAllCancelRequested).toBe(false);
    expect(store.fetchingAll).toBe(true);
  });
});
