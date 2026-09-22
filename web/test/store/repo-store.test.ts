import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { api } from "@/api";
import { useRepoActions } from "@/store/repo";
import type { ActionName, ActionResult, Repo } from "@/types";

function repo(id: string, over: Partial<Repo> = {}): Repo {
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
    ...over,
  };
}

function harness(initial: Repo[] = []) {
  const repos = ref<Repo[]>(initial);
  const busy: Record<string, ActionName | undefined> = {};
  const asResult = (e: unknown): ActionResult => ({ ok: false, code: "ERROR", message: String(e) });
  const actions = useRepoActions(repos, busy, asResult);
  return { repos, busy, ...actions };
}

// The card renders `displayName || name` (RepoSafeLabel / RepoCardHeader), so every list-facing
// operation — filter, A–Z sort — has to key on that same label or the UI contradicts itself.
describe("repo-store: display label drives filter and sort", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("filters on the displayed label, not the folder basename (F006)", () => {
    const h = harness([repo("alpha", { displayName: "Zebra" }), repo("beta")]);
    h.filterQuery.value = "zebra";
    expect(h.filteredRepos.value.map((r) => r.id)).toEqual(["alpha"]);
  });

  it("still filters on the folder name when no label is set", () => {
    const h = harness([repo("alpha", { displayName: null }), repo("beta")]);
    h.filterQuery.value = "alpha";
    expect(h.filteredRepos.value.map((r) => r.id)).toEqual(["alpha"]);
  });

  it("sorts A–Z by the displayed label, not the folder basename (F008)", () => {
    const h = harness([
      repo("alpha", { displayName: "Zebra" }),
      repo("beta", { displayName: "Apple" }),
    ]);
    h.setSortMode("name");
    expect(h.visibleRepos.value.map((r) => r.id)).toEqual(["beta", "alpha"]);
  });
});

// removeRepo is optimistic; a rejected request used to push the card back at the END of the
// list, which is only where it belongs under the daemon's own order — under a name/recent sort
// or a saved drag order the card jumped position on a failed removal.
describe("repo-store: removeRepo rollback restores the original position (F007)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("re-inserts the card at the index it occupied", async () => {
    const h = harness([repo("a"), repo("b"), repo("c")]);
    vi.spyOn(api, "removeRepo").mockRejectedValue(new Error("offline"));

    await expect(h.removeRepo("b")).rejects.toThrow("offline");

    expect(h.repos.value.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the list untouched when a removal succeeds", async () => {
    const h = harness([repo("a"), repo("b"), repo("c")]);
    vi.spyOn(api, "removeRepo").mockResolvedValue({ ok: true, removed: { id: "b", name: "b", absPath: "D:/b" } });

    await h.removeRepo("b");

    expect(h.repos.value.map((r) => r.id)).toEqual(["a", "c"]);
  });
});
