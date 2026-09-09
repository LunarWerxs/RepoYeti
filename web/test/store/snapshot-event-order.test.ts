/**
 * Snapshot / SSE ordering (1.0 audit, item 7).
 *
 * loadAll() and the event stream start together, the daemon has no event cursor, and loadAll()
 * is also the reconnect resync. Between "list requested" and "list installed" a repo-scoped event
 * used to be applied to the OLD list: a `repo_removed` filtered it and the late snapshot put the
 * repo straight back; a `repo_state_changed` for a repo the old list did not have was dropped.
 * The store now holds repo-scoped events while a snapshot is in flight and replays them, in order,
 * the moment the snapshot lands, skipping a held status that is older than what the snapshot
 * already installed. These tests drive that with a deferred `listRepos` and a fake event stream.
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
import type { Repo } from "@/types";

function status(overrides: Partial<NonNullable<Repo["status"]>> = {}): NonNullable<Repo["status"]> {
  return {
    branch: "feature/test",
    detached: false,
    headOid: "a".repeat(40),
    historyRefsHash: "refs-1",
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: "origin",
    error: null,
    fetchedAt: null,
    updatedAt: 10,
    ...overrides,
  };
}

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    name: id,
    displayName: null,
    absPath: `D:/${id}`,
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
    status: status(),
    updatedAt: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake event stream plus the offline stubs loadAll()'s background burst needs to fail fast. */
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
  });
  vi.spyOn(api, "collaborationSnapshots").mockResolvedValue({ snapshots: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline in test");
    }),
  );
  let seq = 0;
  // A unique payload string every time, so the store's `watch(data)` fires even for two
  // otherwise-identical frames.
  const emit = async (name: string, payload: Record<string, unknown>): Promise<void> => {
    event.value = name;
    data.value = JSON.stringify({ ...payload, _seq: ++seq });
    await nextTick();
  };
  return { streamStatus, emit };
}

describe("snapshot / SSE ordering (audit item 7)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a repo_removed that arrives while the list snapshot is in flight is not resurrected by the late snapshot", async () => {
    const { streamStatus, emit } = fakeStream();
    const list = deferred<Repo[]>();
    vi.spyOn(api, "listRepos").mockReturnValueOnce(list.promise);
    const store = useStore();
    store.connect();
    streamStatus.value = "OPEN";
    await nextTick();

    const load = store.loadAll();
    await emit("repo_removed", { id: "repo-1" }); // the owner removed it while the GET was in flight
    list.resolve([repo("repo-1"), repo("repo-2")]); // the GET answered from BEFORE the removal
    await load;

    // Before the fix: the removal filtered an empty list, then the snapshot installed repo-1 again.
    expect(store.repos.map((r) => r.id)).toEqual(["repo-2"]);
  });

  it("a status that arrives during the snapshot for a repo the old list lacked is applied once the snapshot lands", async () => {
    const { streamStatus, emit } = fakeStream();
    const list = deferred<Repo[]>();
    vi.spyOn(api, "listRepos").mockReturnValueOnce(list.promise);
    const store = useStore();
    store.connect();
    streamStatus.value = "OPEN";
    await nextTick();

    const load = store.loadAll();
    await emit("repo_state_changed", { id: "repo-1", status: status({ branch: "main", updatedAt: 20 }) });
    list.resolve([repo("repo-1", { status: status({ branch: "feature/test", updatedAt: 10 }) })]);
    await load;

    // Before the fix: patchRepo found no repo-1 and dropped the newer status; the card showed the
    // snapshot's older branch until another matching event happened to arrive.
    expect(store.repos[0]?.status?.branch).toBe("main");
    expect(store.repos[0]?.status?.updatedAt).toBe(20);
  });

  it("a held status OLDER than the snapshot's is not replayed over it", async () => {
    const { streamStatus, emit } = fakeStream();
    const list = deferred<Repo[]>();
    vi.spyOn(api, "listRepos").mockReturnValueOnce(list.promise);
    const store = useStore();
    store.connect();
    streamStatus.value = "OPEN";
    await nextTick();

    const load = store.loadAll();
    await emit("repo_state_changed", { id: "repo-1", status: status({ branch: "stale", updatedAt: 5 }) });
    list.resolve([repo("repo-1", { status: status({ branch: "main", updatedAt: 10 }) })]);
    await load;

    expect(store.repos[0]?.status?.branch).toBe("main");
  });

  it("once the snapshot is installed, events apply immediately; an out-of-order older status is still ignored", async () => {
    const { streamStatus, emit } = fakeStream();
    vi.spyOn(api, "listRepos").mockResolvedValueOnce([repo("repo-1", { status: status({ updatedAt: 10 }) })]);
    const store = useStore();
    store.connect();
    streamStatus.value = "OPEN";
    await nextTick();
    await store.loadAll();

    await emit("repo_state_changed", { id: "repo-1", status: status({ branch: "live", updatedAt: 30 }) });
    expect(store.repos[0]?.status?.branch).toBe("live");
    await emit("repo_state_changed", { id: "repo-1", status: status({ branch: "late", updatedAt: 20 }) });
    expect(store.repos[0]?.status?.branch).toBe("live");
    await emit("repo_removed", { id: "repo-1" });
    expect(store.repos).toHaveLength(0);
  });

  it("the reconnect resync goes through the same gate", async () => {
    const { streamStatus, emit } = fakeStream();
    const list = deferred<Repo[]>();
    vi.spyOn(api, "listRepos")
      .mockResolvedValueOnce([repo("repo-1")]) // the first, explicit hydration
      .mockReturnValueOnce(list.promise); // the resync a reconnect triggers
    const store = useStore();
    store.connect();
    streamStatus.value = "OPEN";
    await nextTick();
    await store.loadAll();
    expect(store.repos.map((r) => r.id)).toEqual(["repo-1"]);

    streamStatus.value = "CLOSED"; // the phone backgrounded
    await nextTick();
    streamStatus.value = "OPEN"; // back: the store resyncs on its own
    await nextTick();
    await vi.waitFor(() => expect(api.listRepos).toHaveBeenCalledTimes(2));

    await emit("repo_removed", { id: "repo-1" }); // arrives while the resync's GET is in flight
    list.resolve([repo("repo-1")]); // the stale answer
    await vi.waitFor(() => expect(store.repos).toHaveLength(0));
  });
});
