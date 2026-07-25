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
import type { Repo, SmartCommitResult } from "@/types";

const ok = { ok: true, code: "OK" } as const;
const failed = { ok: false, code: "ERROR", message: "failed" } as const;

function repo(id = "repo-1"): Repo {
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
    status: null,
    updatedAt: 1,
  };
}

function repoStatus(
  overrides: Partial<NonNullable<Repo["status"]>> = {},
): NonNullable<Repo["status"]> {
  return {
    branch: "main",
    detached: false,
    headOid: "a".repeat(40),
    dirty: 2,
    ahead: 0,
    behind: 0,
    remote: "origin",
    error: null,
    fetchedAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

function branchList() {
  return {
    ...ok,
    current: "main",
    detached: false,
    branches: [],
  };
}

describe("store history revision invalidation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("bumps only successful commit and selected-commit mutations", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(api, "changes").mockResolvedValue({ files: [] });
    vi.spyOn(api, "commit").mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);
    vi.spyOn(api, "commitSelected").mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);

    await store.commit("repo-1", "first");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);
    await store.commit("repo-1", "failed");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);

    await store.commitSelected("repo-1", "selected", ["a.ts"]);
    expect(store.historyRevisionByRepo["repo-1"]).toBe(2);
    await store.commitSelected("repo-1", "failed selected", ["a.ts"]);
    expect(store.historyRevisionByRepo["repo-1"]).toBe(2);
  });

  it("bumps successful fetch and pull, but not other actions or failures", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(api, "fetch").mockResolvedValue(ok);
    vi.spyOn(api, "pull").mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);
    vi.spyOn(api, "push").mockResolvedValue(ok);
    vi.spyOn(api, "refresh").mockResolvedValue(repo());

    await store.doAction("repo-1", "fetch");
    await store.doAction("repo-1", "pull");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(2);

    await store.doAction("repo-1", "pull");
    await store.doAction("repo-1", "push");
    await store.doAction("repo-1", "refresh");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(2);
  });

  it("bumps successful branch topology changes and ignores rejected ones", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(api, "branches").mockResolvedValue(branchList());
    vi.spyOn(api, "checkout").mockResolvedValue(ok);
    vi.spyOn(api, "createBranch").mockResolvedValue(ok);
    vi.spyOn(api, "deleteBranch").mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);

    await store.switchBranch("repo-1", "feature");
    await store.createBranch("repo-1", "new-branch", false);
    await store.deleteBranch("repo-1", "old-branch");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(3);

    await store.deleteBranch("repo-1", "protected");
    expect(store.historyRevisionByRepo["repo-1"]).toBe(3);
  });

  it("bumps successful tag creation because History includes tag-reachable commits", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(api, "tags").mockResolvedValue({ ...ok, tags: [] });
    vi.spyOn(api, "createTag").mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);

    await store.createTag("repo-1", { name: "v1.0.0" });
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);

    await store.createTag("repo-1", { name: "v1.0.1" });
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);
  });

  it("bumps a partially successful smart commit, but not a skipped or wholly failed plan", async () => {
    const store = useStore();
    store.repos.push(repo());
    vi.spyOn(api, "changes").mockResolvedValue({ files: [] });
    const smart = vi.spyOn(api, "smartCommit");
    smart
      .mockResolvedValueOnce({
        ok: false,
        code: "ERROR",
        message: "second group failed",
        repoId: "repo-1",
        committed: [
          { ok: true, code: "OK", subject: "first" },
          { ok: false, code: "ERROR", subject: "second" },
        ],
      } as SmartCommitResult)
      .mockResolvedValueOnce({
        ok: true,
        code: "OK",
        message: "nothing made",
        repoId: "repo-1",
        committed: [
          { ok: true, code: "OK", subject: "empty", message: "skipped (no changes)" },
        ],
      } as SmartCommitResult)
      .mockResolvedValueOnce({
        ok: false,
        code: "ERROR",
        message: "failed",
        repoId: "repo-1",
        committed: [{ ok: false, code: "ERROR", subject: "first" }],
      } as SmartCommitResult);

    await store.smartCommit("repo-1", [{ message: "plan", paths: ["a.ts"] }]);
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);
    await store.smartCommit("repo-1", [{ message: "skip", paths: ["b.ts"] }]);
    await store.smartCommit("repo-1", [{ message: "fail", paths: ["c.ts"] }]);
    expect(store.historyRevisionByRepo["repo-1"]).toBe(1);
  });

  it("releases a repo's revision signal with its other cached state", async () => {
    const store = useStore();
    store.repos.push(repo());
    store.bumpHistoryRevision("repo-1");
    vi.spyOn(api, "removeRepo").mockResolvedValue(ok);

    await store.removeRepo("repo-1");

    expect(store.historyRevisionByRepo["repo-1"]).toBeUndefined();
  });

  it("bumps focused sync SSEs with real work and ignores generic state updates", async () => {
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
    store.repos.push(
      repo("pulled"),
      repo("committed"),
      repo("idle"),
      repo("external"),
    );
    store.repos.find((item) => item.id === "external")!.status = repoStatus();
    store.connect();

    event.value = "repo_state_changed";
    data.value = JSON.stringify({ id: "external", status: repoStatus({ updatedAt: 2 }) });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBeUndefined();

    // A force-push or fetch can replace the upstream ref without changing the ahead/behind
    // counts. History walks remote refs, so the object identity itself must invalidate it.
    data.value = JSON.stringify({
      id: "external",
      status: repoStatus({ upstreamOid: "c".repeat(40), updatedAt: 3 }),
    });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBe(1);

    // A terminal/IDE can commit and push before the debounced watcher reads status. Branch,
    // dirty, ahead, and behind then all look unchanged; the resolved HEAD object is the signal.
    data.value = JSON.stringify({
      id: "external",
      status: repoStatus({
        headOid: "b".repeat(40),
        upstreamOid: "c".repeat(40),
        updatedAt: 4,
      }),
    });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBe(2);

    // A tag, non-upstream remote ref, or symbolic decoration can change while HEAD and the
    // current upstream remain identical. The server's opaque ref-store digest carries that.
    data.value = JSON.stringify({
      id: "external",
      status: repoStatus({
        headOid: "b".repeat(40),
        upstreamOid: "c".repeat(40),
        historyRefsHash: "d".repeat(64),
        updatedAt: 5,
      }),
    });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBe(3);

    data.value = JSON.stringify({
      id: "external",
      status: repoStatus({
        headOid: "b".repeat(40),
        upstreamOid: "c".repeat(40),
        historyRefsHash: "d".repeat(64),
        dirty: 0,
        updatedAt: 6,
      }),
    });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBe(4);

    data.value = JSON.stringify({
      id: "external",
      status: repoStatus({
        branch: "feature",
        headOid: "b".repeat(40),
        upstreamOid: "c".repeat(40),
        historyRefsHash: "d".repeat(64),
        dirty: 0,
        updatedAt: 7,
      }),
    });
    await nextTick();
    expect(store.historyRevisionByRepo.external).toBe(5);

    event.value = "repo_synced";
    data.value = JSON.stringify({
      repos: [
        { id: "pulled", name: "pulled", pulled: 2 },
        { id: "idle", name: "idle", pulled: 0 },
      ],
    });
    await nextTick();
    expect(store.historyRevisionByRepo.pulled).toBe(1);
    expect(store.historyRevisionByRepo.idle).toBeUndefined();

    event.value = "repo_auto_committed";
    data.value = JSON.stringify({
      repos: [
        { id: "committed", name: "committed", commits: 3, pulled: false, pushed: false },
        { id: "idle", name: "idle", commits: 0, pulled: true, pushed: false },
      ],
    });
    await nextTick();
    expect(store.historyRevisionByRepo.committed).toBe(1);
    expect(store.historyRevisionByRepo.idle).toBeUndefined();
  });
});
