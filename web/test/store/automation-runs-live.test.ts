/**
 * Regressions for store/automation-runs.ts's LIVE-round handling around the async edges:
 *   - opening the panel in the same round-trip window a round starts must not let the stale reply
 *     clobber the run the `automation_run_started` already installed (or its `running` flag)
 *   - a FAILED history load is not a loaded history: a later terminal event must not fabricate the
 *     one and only row of a list nobody fetched
 *   - a detail fetch answered with a 5xx is transient, not the terminal "past the row cap" answer
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

type RunsResponse = {
  runs: AutomationRun[];
  active: {
    autoCommit: { running: boolean; cancelling: boolean };
    syncCheck: { running: boolean; cancelling: boolean };
  };
};

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

/** A promise whose resolution is controlled by the test, for the round-trip window. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("automation runs: a round starting during the history load", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("does not let the stale reply clobber a run that started while the request was in flight", async () => {
    const { store, emit } = await connected();

    const pending = deferred<RunsResponse>();
    vi.spyOn(api.automation, "runs").mockReturnValue(pending.promise);

    const loading = store.loadAutomationRuns();

    // The scheduled round starts in the round-trip window: the live run is installed here, but the
    // server already snapshotted its reply - no in-flight row, `running: false`.
    await emit("automation_run_started", {
      runId: "new-1",
      kind: "auto_commit",
      trigger: "timer",
      total: 4,
      startedAt: Date.now(),
    });
    expect(store.automationLiveRuns.auto_commit?.runId).toBe("new-1");

    pending.resolve({
      runs: [fakeRun()],
      active: {
        autoCommit: { running: false, cancelling: false },
        syncCheck: { running: false, cancelling: false },
      },
    });
    await loading;

    // The stale snapshot must not erase the live run nor its `running` flag...
    expect(store.automationLiveRuns.auto_commit?.runId).toBe("new-1");
    expect(store.automationActiveRounds.auto_commit.running).toBe(true);

    // ...otherwise the straggler guard would silently drop this progress event (and the terminal
    // one), leaving the running round invisible and unstoppable.
    await emit("automation_run_progress", {
      runId: "new-1",
      kind: "auto_commit",
      current: "repo-a",
      done: 1,
      blocked: 0,
      total: 4,
    });
    expect(store.automationLiveRuns.auto_commit?.done).toBe(1);
    expect(store.automationLiveRuns.auto_commit?.current).toBe("repo-a");

    await emit("automation_run_done", {
      runId: "new-1",
      kind: "auto_commit",
      trigger: "timer",
      outcome: "completed",
      total: 4,
      done: 4,
      blocked: 0,
      durationMs: 900,
    });
    expect(store.automationActiveRounds.auto_commit.running).toBe(false);
    expect(store.automationRuns.some((run) => run.id === "new-1")).toBe(true);
  });

  it("still adopts an in-flight row when no event arrived during the request", async () => {
    const { store, emit } = await connected();

    vi.spyOn(api.automation, "runs").mockResolvedValue({
      runs: [
        fakeRun({ id: "live-1", kind: "auto_commit", outcome: null, endedAt: null, reposTotal: 6, reposDone: 2 }),
      ],
      active: {
        autoCommit: { running: true, cancelling: false },
        syncCheck: { running: false, cancelling: false },
      },
    });
    await store.loadAutomationRuns();

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
  });
});

describe("automation runs: a failed history load", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("does not fabricate a lone run row out of a history that never loaded", async () => {
    const { store, emit } = await connected();
    vi.spyOn(api.automation, "runs").mockRejectedValue(new Error("offline"));

    await store.loadAutomationRuns();
    expect(store.automationRuns).toHaveLength(0);

    await emit("automation_run_started", {
      runId: "run-x",
      kind: "sync_check",
      trigger: "timer",
      total: 1,
      startedAt: Date.now(),
    });
    await emit("automation_run_done", {
      runId: "run-x",
      kind: "sync_check",
      trigger: "timer",
      outcome: "completed",
      total: 1,
      done: 1,
      blocked: 0,
      durationMs: 10,
    });

    // Prepend only into a list that was actually fetched: otherwise the next terminal event adds
    // the one and only row of a history the panel never loaded, back-computed from durationMs.
    expect(store.automationRuns).toHaveLength(0);
  });

  it("drops a stale live run that would otherwise claim to be running", async () => {
    const { store, emit } = await connected();
    await emit("automation_run_started", {
      runId: "stale-1",
      kind: "auto_commit",
      trigger: "timer",
      total: 2,
      startedAt: Date.now(),
    });
    expect(store.automationLiveRuns.auto_commit?.runId).toBe("stale-1");

    vi.spyOn(api.automation, "runs").mockRejectedValue(new Error("offline"));
    await store.loadAutomationRuns();

    expect(store.automationLiveRuns.auto_commit).toBeNull();
    expect(store.automationActiveRounds.auto_commit.running).toBe(false);
  });
});

describe("automation runs: detail errors", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("rethrows a 5xx detail error instead of reporting the run as past the row cap", async () => {
    const store = useStore();
    vi.spyOn(api.automation, "run").mockRejectedValue(
      new ApiError(503, "service unavailable", { code: "ERROR" }),
    );

    // null is reserved for the 404 NOT_FOUND "past the row cap" answer; a gateway failure is a real
    // fault the pane must be able to tell apart.
    await expect(store.loadAutomationRunDetail("r1")).rejects.toBeInstanceOf(ApiError);
  });
});
