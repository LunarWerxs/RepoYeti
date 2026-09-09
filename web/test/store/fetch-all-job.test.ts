/**
 * "Fetch all" as a job the dashboard can watch and stop (1.0 audit, item 24).
 *
 * The rules worth pinning are the ones a hand-written spinner gets wrong: a heartbeat carries a
 * failure COUNT while the terminal event carries the LIST, a late event from a previous run must
 * not rewrite the current one's counters, and reconnect reconciliation must never resurrect a
 * finished run for a client that was not watching it — the daemon keeps the last run forever, so
 * adopting it on every reconnect would toast a summary for a sweep that ended hours ago.
 */
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

/** A fake event stream, plus the stubs the store's background hydration needs to fail fast. */
function fakeStream() {
  const streamStatus = ref<"OPEN" | "CONNECTING" | "CLOSED">("CLOSED");
  const event = ref<string | null>(null);
  const data = ref<string | null>(null);
  vi.mocked(useEventSource).mockReturnValue({
    status: streamStatus,
    event,
    data,
    error: ref(null),
    close: vi.fn(),
    open: vi.fn(),
  } as unknown as ReturnType<typeof useEventSource>);
  vi.spyOn(api, "collaborationSnapshots").mockResolvedValue({ snapshots: [] });
  let seq = 0;
  const emit = async (name: string, payload: Record<string, unknown>): Promise<void> => {
    event.value = name;
    // Unique every time, so the store's watch(data) fires even for identical frames.
    data.value = JSON.stringify({ ...payload, _seq: ++seq });
    await nextTick();
  };
  return { streamStatus, emit };
}

async function connected() {
  const { streamStatus, emit } = fakeStream();
  const store = useStore();
  store.connect();
  streamStatus.value = "OPEN";
  await nextTick();
  return { store, streamStatus, emit };
}

describe("fetch-all: the live counters", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("follows a run from start to summary", async () => {
    const { store, emit } = await connected();

    await emit("fetch_all_started", { jobId: "run-1", total: 3 });
    expect(store.fetchingAll).toBe(true);
    expect(store.fetchAllTotal).toBe(3);
    expect(store.fetchAllSummary).toBeNull();

    await emit("fetch_all_progress", { jobId: "run-1", current: "alpha", done: 1, total: 3, ok: 1, failed: 0 });
    expect(store.fetchAllCurrent).toBe("alpha");
    expect(store.fetchAllDone).toBe(1);
    expect(store.fetchAllOk).toBe(1);

    await emit("fetch_all_done", {
      jobId: "run-1",
      total: 3,
      ok: 2,
      failed: [{ id: "b", name: "beta", code: "ERROR" }],
      skipped: 0,
      cancelled: false,
    });
    expect(store.fetchingAll).toBe(false);
    expect(store.fetchAllCurrent).toBeNull();
    expect(store.fetchAllSummary?.ok).toBe(2);
    // The heartbeat's `failed` is a count and the terminal event's is a list. Both land in the
    // right place, which is the whole reason they are handled separately.
    expect(store.fetchAllFailed).toBe(1);
    expect(store.fetchAllSummary?.failed).toHaveLength(1);
  });

  it("marks a stopped run as cancelled rather than failed", async () => {
    const { store, emit } = await connected();
    await emit("fetch_all_started", { jobId: "run-2", total: 9 });
    await emit("fetch_all_cancelled", { jobId: "run-2", total: 9, ok: 2, failed: [], skipped: 7, cancelled: true });

    expect(store.fetchingAll).toBe(false);
    expect(store.fetchAllSummary?.cancelled).toBe(true);
    expect(store.fetchAllSummary?.skipped).toBe(7);
    expect(store.fetchAllCancelRequested).toBe(false);
  });

  it("carries the reason when a run ended by throwing", async () => {
    const { store, emit } = await connected();
    await emit("fetch_all_started", { jobId: "run-3", total: 2 });
    await emit("fetch_all_done", {
      jobId: "run-3",
      total: 2,
      ok: 0,
      failed: [],
      skipped: 2,
      cancelled: false,
      error: "the network went away",
    });
    expect(store.fetchAllSummary?.error).toBe("the network went away");
  });

  it("ignores an event from a run it is not watching", async () => {
    const { store, emit } = await connected();
    await emit("fetch_all_started", { jobId: "run-4", total: 5 });
    await emit("fetch_all_progress", { jobId: "run-4", current: "alpha", done: 1, total: 5, ok: 1, failed: 0 });

    // A straggler from the PREVIOUS run, delivered after this one started (only possible right
    // after a reconnect, and exactly when it would mislead most).
    await emit("fetch_all_done", { jobId: "run-3", total: 99, ok: 99, failed: [], skipped: 0, cancelled: false });

    expect(store.fetchingAll).toBe(true);
    expect(store.fetchAllTotal).toBe(5);
    expect(store.fetchAllSummary).toBeNull();
  });
});

describe("fetch-all: reconnect reconciliation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("adopts a run that is still going, even one this client never saw start", async () => {
    const store = useStore();
    vi.spyOn(api, "fetchAllStatus").mockResolvedValue({
      ok: true,
      running: true,
      job: {
        jobId: "run-5",
        total: 8,
        ok: 3,
        failed: [],
        skipped: 0,
        cancelled: false,
        done: 3,
        current: "gamma",
        running: true,
      },
    });

    await store.reconcileFetchAll();

    expect(store.fetchingAll).toBe(true);
    expect(store.fetchAllCurrent).toBe("gamma");
    expect(store.fetchAllDone).toBe(3);
  });

  it("settles a run this client was watching when the daemon says it has ended", async () => {
    const store = useStore();
    store.fetchingAll = true;
    store.fetchAllCancelRequested = true;
    vi.spyOn(api, "fetchAllStatus").mockResolvedValue({
      ok: true,
      running: false,
      job: {
        jobId: "run-6",
        total: 4,
        ok: 4,
        failed: [],
        skipped: 0,
        cancelled: false,
        done: 4,
        current: null,
        running: false,
      },
    });

    await store.reconcileFetchAll();

    expect(store.fetchingAll).toBe(false);
    expect(store.fetchAllSummary?.ok).toBe(4);
    expect(store.fetchAllCancelRequested).toBe(false);
  });

  it("does not resurrect a finished run for a client that was not watching one", async () => {
    const store = useStore();
    expect(store.fetchingAll).toBe(false);
    vi.spyOn(api, "fetchAllStatus").mockResolvedValue({
      ok: true,
      running: false,
      job: {
        jobId: "run-7",
        total: 12,
        ok: 12,
        failed: [],
        skipped: 0,
        cancelled: false,
        done: 12,
        current: null,
        running: false,
      },
    });

    await store.reconcileFetchAll();

    // The daemon keeps the last run after it ends. Adopting it here would pop a summary toast for
    // a sweep that finished hours ago, on every reconnect, forever.
    expect(store.fetchAllSummary).toBeNull();
    expect(store.fetchingAll).toBe(false);
  });

  it("changes nothing when the status check itself fails", async () => {
    const store = useStore();
    store.fetchingAll = true;
    vi.spyOn(api, "fetchAllStatus").mockRejectedValue(new Error("offline"));

    await store.reconcileFetchAll();

    // Never guess that an unknown server-side job has stopped.
    expect(store.fetchingAll).toBe(true);
  });
});

describe("fetch-all: starting and stopping", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("flips to running optimistically and rolls back only if the start itself failed", async () => {
    const store = useStore();
    vi.spyOn(api, "startFetchAll").mockRejectedValue(new Error("daemon is not reachable"));
    await expect(store.startFetchAll()).rejects.toThrow("daemon is not reachable");
    expect(store.fetchingAll).toBe(false);
  });

  it("adopts the counters the start response already carries", async () => {
    const store = useStore();
    vi.spyOn(api, "startFetchAll").mockResolvedValue({
      ok: true,
      started: true,
      running: true,
      job: {
        jobId: "run-8",
        total: 6,
        ok: 0,
        failed: [],
        skipped: 0,
        cancelled: false,
        done: 0,
        current: null,
        running: true,
      },
    });
    await store.startFetchAll();
    expect(store.fetchingAll).toBe(true);
    expect(store.fetchAllTotal).toBe(6);
  });

  it("shows Stopping… optimistically and rolls back if the request fails", async () => {
    const store = useStore();
    vi.spyOn(api, "cancelFetchAll").mockRejectedValue(new Error("offline"));
    await expect(store.cancelFetchAll()).rejects.toThrow("offline");
    // Otherwise the control sits disabled on "Stopping…" forever, on a request the daemon never
    // received.
    expect(store.fetchAllCancelRequested).toBe(false);
  });
});
