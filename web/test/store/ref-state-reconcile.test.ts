// Issue #22: the branch selector kept showing a branch that had been checked out, updated or
// deleted OUTSIDE RepoYeti, and only a full page reload cleared it.
//
// The status read was always correct — Refresh really did return `branch: "main"`. What was
// missing is that nothing invalidated the CACHED branch list, which is what the selector renders.
// So these tests are about the reconciliation, not about the status read: after any update that
// moves the repo's refs, an already-loaded branch list must be re-fetched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@vueuse/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vueuse/core")>();
  return { ...actual, useEventSource: vi.fn() };
});

import { api } from "@/api";
import { useStore } from "@/store";
import type { Repo } from "@/types";

const ok = { ok: true, code: "OK" } as const;

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
    status: status(),
    updatedAt: 1,
  };
}

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
    updatedAt: 1,
    ...overrides,
  };
}

const branchList = (current: string, names: string[]) => ({
  ...ok,
  current,
  detached: false,
  branches: names.map((name) => ({ name, upstream: null, ahead: 0, behind: 0, gone: false, head: name === current })),
});

describe("ref-state reconciliation (issue #22)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("re-reads the branch list when Refresh reports a different branch", async () => {
    const store = useStore();
    store.repos.push(repo());
    const branches = vi
      .spyOn(api, "branches")
      .mockResolvedValueOnce(branchList("feature/test", ["feature/test", "main"]))
      .mockResolvedValueOnce(branchList("main", ["main"]));

    // The card is expanded, so the branch list is cached and on screen.
    await store.loadBranches("repo-1");
    expect(store.branchesByRepo["repo-1"]?.current).toBe("feature/test");

    // Someone checks out main in a terminal, deletes the old branch, and the owner hits Refresh.
    vi.spyOn(api, "refresh").mockResolvedValue({
      ...repo(),
      status: status({ branch: "main", historyRefsHash: "refs-2" }),
    } as Repo);
    await store.doAction("repo-1", "refresh");
    await vi.waitFor(() => expect(branches).toHaveBeenCalledTimes(2));

    // Before the fix this still said feature/test, and listed a branch that no longer exists.
    expect(store.branchesByRepo["repo-1"]?.current).toBe("main");
    expect(store.branchesByRepo["repo-1"]?.branches.map((b) => b.name)).toEqual(["main"]);
  });

  it("re-reads when only the REF SET changed, with the current branch untouched", async () => {
    const store = useStore();
    store.repos.push(repo());
    const branches = vi
      .spyOn(api, "branches")
      .mockResolvedValueOnce(branchList("feature/test", ["feature/test", "stale"]))
      .mockResolvedValueOnce(branchList("feature/test", ["feature/test"]));

    await store.loadBranches("repo-1");

    // A branch deleted elsewhere leaves `branch` identical — only historyRefsHash moves. A
    // branch-only comparison misses this exact case, which is half of what the issue reported.
    vi.spyOn(api, "refresh").mockResolvedValue({
      ...repo(),
      status: status({ historyRefsHash: "refs-2" }),
    } as Repo);
    await store.doAction("repo-1", "refresh");
    await vi.waitFor(() => expect(branches).toHaveBeenCalledTimes(2));

    expect(store.branchesByRepo["repo-1"]?.branches.map((b) => b.name)).toEqual(["feature/test"]);
  });

  it("does NOT re-read when nothing about the refs moved", async () => {
    const store = useStore();
    store.repos.push(repo());
    const branches = vi.spyOn(api, "branches").mockResolvedValue(branchList("feature/test", ["feature/test"]));

    await store.loadBranches("repo-1");
    expect(branches).toHaveBeenCalledTimes(1);

    // Only the dirty count changed — an edit, not a ref move. Re-reading here would put a
    // `for-each-ref` on the git read gate on every keystroke-driven watcher tick.
    vi.spyOn(api, "refresh").mockResolvedValue({
      ...repo(),
      status: status({ dirty: 7 }),
    } as Repo);
    await store.doAction("repo-1", "refresh");

    expect(branches).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch a branch list for a repo whose card was never opened", async () => {
    const store = useStore();
    store.repos.push(repo());
    const branches = vi.spyOn(api, "branches").mockResolvedValue(branchList("main", ["main"]));

    // Nothing cached: the collapsed card has no list on screen, so reconciling one would be work
    // for a view nobody is looking at — and it is the git read gate that pays for it.
    vi.spyOn(api, "refresh").mockResolvedValue({
      ...repo(),
      status: status({ branch: "main", historyRefsHash: "refs-2" }),
    } as Repo);
    await store.doAction("repo-1", "refresh");

    expect(branches).not.toHaveBeenCalled();
    expect(store.branchesByRepo["repo-1"]).toBeUndefined();
  });
});
