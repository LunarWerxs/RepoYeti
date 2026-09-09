/**
 * Automation run history + live round state (store/automation-runs.ts).
 *
 * Both scheduled loops (auto-commit, sync-check) broadcast the same automation_run_* SSE event
 * family and are told apart only by `kind`, and the two loops can run concurrently — so the rules
 * worth pinning are: live state is kept PER KIND rather than one global, a straggler event from a
 * run a kind is no longer watching is ignored (except `_started`, which always adopts), and a
 * terminal event only ever prepends to the history list when that list was actually loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";

vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  return { ...actual, useEventSource: vi.fn() };
});

import { useEventSource } from "@vueuse/core";
import { api, ApiError } from "@/api";
import { useStore } from "@/store";
import type { AutomationRun } from "@/types";

/** A fake event stream, plus the stub the store's background hydration needs to fail fast. */
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

function fakeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "old-1",
    kind: "auto_commit",
    trigger: "timer",
    startedAt: 1,
    endedAt: 2,
    outcome: "completed",
    reposTotal: 1,
    reposDone: 1,
    reposBlocked: 0,
    error: null,
    ...overrides,
  };
}

describe("automation runs: live progress", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("follows a run from started to progress to done, then clears the live run", async () => {
    const { store, emit } = await connected();

    await emit("automation_run_started", {
      runId: "run-1",
      kind: "auto_commit",
      trigger: "timer",
      total: 5,
      startedAt: Date.now(),
    });
    expect(store.automationLiveRuns.auto_commit).toEqual({
      runId: "run-1",
      done: 0,
      blocked: 0,
      total: 5,
      current: null,
    });
    expect(store.automationActiveRounds.auto_commit.running).toBe(true);

    await emit("automation_run_progress", {
      runId: "run-1",
      kind: "auto_commit",
      current: "repo-a",
      outcome: "committed",
      done: 1,
      blocked: 0,
      total: 5,
    });
    expect(store.automationLiveRuns.auto_commit?.done).toBe(1);
    expect(store.automationLiveRuns.auto_commit?.current).toBe("repo-a");

    await emit("automation_run_done", {
      runId: "run-1",
      kind: "auto_commit",
      trigger: "timer",
      outcome: "completed",
      total: 5,
      done: 5,
      blocked: 0,
      durationMs: 1234,
    });
    expect(store.automationLiveRuns.auto_commit).toBeNull();
    expect(store.automationActiveRounds.auto_commit.running).toBe(false);
  });

  it("keeps the two loops' live runs independent when their events interleave", async () => {
    const { store, emit } = await connected();

    await emit("automation_run_started", {
      runId: "ac-1",
      kind: "auto_commit",
      trigger: "timer",
      total: 3,
      startedAt: Date.now(),
    });
    await emit("automation_run_started", {
      runId: "sc-1",
      kind: "sync_check",
      trigger: "timer",
      total: 4,
      startedAt: Date.now(),
    });
    await emit("automation_run_progress", {
      runId: "ac-1",
      kind: "auto_commit",
      current: "repo-a",
      outcome: "committed",
      done: 1,
      blocked: 0,
      total: 3,
    });
    await emit("automation_run_progress", {
      runId: "sc-1",
      kind: "sync_check",
      current: "repo-z",
      outcome: "synced",
      done: 2,
      blocked: 0,
      total: 4,
    });

    expect(store.automationLiveRuns.auto_commit).toMatchObject({ runId: "ac-1", done: 1, current: "repo-a" });
    expect(store.automationLiveRuns.sync_check).toMatchObject({ runId: "sc-1", done: 2, current: "repo-z" });
    expect(store.automationActiveRounds.auto_commit.running).toBe(true);
    expect(store.automationActiveRounds.sync_check.running).toBe(true);
  });

  it("ignores a straggler terminal event from a run this kind is no longer watching", async () => {
    const { store, emit } = await connected();
    await emit("automation_run_started", {
      runId: "run-2",
      kind: "auto_commit",
      trigger: "timer",
      total: 3,
      startedAt: Date.now(),
    });

    // A stale terminal event for an EARLIER run, delivered after this one started (only possible
    // right after a reconnect, and exactly when it would mislead most).
    await emit("automation_run_done", {
      runId: "run-1",
      kind: "auto_commit",
      trigger: "timer",
      outcome: "completed",
      total: 99,
      done: 99,
      blocked: 0,
      durationMs: 1,
    });

    expect(store.automationLiveRuns.auto_commit?.runId).toBe("run-2");
    expect(store.automationActiveRounds.auto_commit.running).toBe(true);
  });
});

describe("automation runs: history list", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("prepends a terminal run to the history list when it was already loaded", async () => {
    const { store, emit } = await connected();
    vi.spyOn(api.automation, "runs").mockResolvedValue({
      runs: [fakeRun()],
      active: { autoCommit: { running: false, cancelling: false }, syncCheck: { running: false, cancelling: false } },
    });
    await store.loadAutomationRuns();
    expect(store.automationRuns).toHaveLength(1);

    await emit("automation_run_started", {
      runId: "run-3",
      kind: "auto_commit",
      trigger: "timer",
      total: 2,
      startedAt: Date.now(),
    });
    await emit("automation_run_done", {
      runId: "run-3",
      kind: "auto_commit",
      trigger: "timer",
      outcome: "completed",
      total: 2,
      done: 2,
      blocked: 0,
      durationMs: 500,
    });

    expect(store.automationRuns).toHaveLength(2);
    expect(store.automationRuns[0]?.id).toBe("run-3");
  });

  it("does not touch the history list when it was never loaded", async () => {
    const { store, emit } = await connected();
    expect(store.automationRunsReady).toBe(false);

    await emit("automation_run_started", {
      runId: "run-4",
      kind: "sync_check",
      trigger: "manual",
      total: 1,
      startedAt: Date.now(),
    });
    await emit("automation_run_cancelled", {
      runId: "run-4",
      kind: "sync_check",
      trigger: "manual",
      outcome: "cancelled",
      total: 1,
      done: 0,
      blocked: 0,
      durationMs: 10,
    });

    expect(store.automationRuns).toHaveLength(0);
  });
});

describe("automation runs: cancel + detail", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("rolls back the optimistic cancelling flag when the cancel request fails", async () => {
    const store = useStore();
    vi.spyOn(api.automation, "cancel").mockRejectedValue(new Error("offline"));

    await expect(store.cancelAutomationRound("auto_commit")).rejects.toThrow("offline");

    expect(store.automationActiveRounds.auto_commit.cancelling).toBe(false);
  });

  it("returns null instead of throwing when the run is past the row cap", async () => {
    const store = useStore();
    vi.spyOn(api.automation, "run").mockRejectedValue(
      new ApiError(404, "no automation run with that id", { code: "NOT_FOUND" }),
    );

    const result = await store.loadAutomationRunDetail("gone");

    expect(result).toBeNull();
  });
});

describe("automation runs: opening the panel mid-round", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  /** The history call as the daemon answers it while one loop is still going. */
  function loadedMidRound() {
    return vi.spyOn(api.automation, "runs").mockResolvedValue({
      runs: [
        fakeRun({ id: "live-1", kind: "auto_commit", outcome: null, endedAt: null, reposTotal: 6, reposDone: 2 }),
        fakeRun({ id: "old-1" }),
      ],
      active: { autoCommit: { running: true, cancelling: false }, syncCheck: { running: false, cancelling: false } },
    });
  }

  it("adopts a round already in flight, so its progress is not silently dropped", async () => {
    const { store, emit } = await connected();
    loadedMidRound();
    await store.loadAutomationRuns();

    // Without adopting the in-flight row there is no live run to match against, and the straggler
    // guard would throw every one of these away.
    expect(store.automationLiveRuns.auto_commit?.runId).toBe("live-1");
    await emit("automation_run_progress", {
      runId: "live-1",
      kind: "auto_commit",
      current: "widget",
      done: 3,
      blocked: 0,
      total: 6,
    });
    expect(store.automationLiveRuns.auto_commit?.done).toBe(3);
    expect(store.automationLiveRuns.auto_commit?.current).toBe("widget");
  });

  it("settles the row it already has instead of listing the same run twice", async () => {
    const { store, emit } = await connected();
    loadedMidRound();
    await store.loadAutomationRuns();
    expect(store.automationRuns).toHaveLength(2);

    await emit("automation_run_done", {
      runId: "live-1",
      kind: "auto_commit",
      trigger: "timer",
      outcome: "completed",
      total: 6,
      done: 6,
      blocked: 0,
      durationMs: 400,
    });

    // Still two rows. Prepending would have shown the same round twice, one of them stuck on
    // "running" for as long as the panel stayed open.
    expect(store.automationRuns).toHaveLength(2);
    const settled = store.automationRuns.find((r) => r.id === "live-1")!;
    expect(settled.outcome).toBe("completed");
    expect(settled.reposDone).toBe(6);
    // The daemon's own start time survives, rather than being back-computed from durationMs.
    expect(settled.startedAt).toBe(1);
  });
});
