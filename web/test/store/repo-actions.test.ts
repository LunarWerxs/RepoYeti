import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import { api } from "@/api";
import { useRepoActions } from "@/store/repo";
import type { ActionName, ActionResult, Repo, RepoStatus } from "@/types";

function repo(id = "repo-1", over: Partial<Repo> = {}): Repo {
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

function status(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    branch: "main",
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: "origin",
    error: null,
    fetchedAt: 1,
    ...over,
  };
}

/** The composable under test, wired the way the store barrel wires it. */
function harness(initial: Repo[] = []) {
  const repos = ref<Repo[]>(initial);
  const busy: Record<string, ActionName | undefined> = {};
  const asResult = (e: unknown): ActionResult => ({ ok: false, code: "ERROR", message: String(e) });
  const actions = useRepoActions(repos, busy, asResult);
  return { repos, busy, ...actions };
}

// doAction/commit/commitSelected used to set `busy[repoId]` with no re-entrancy check at all —
// unlike loadChanges, which already guards on `changesLoading[repoId]`. A second click (or a
// double-fire from a flaky UI event) could stack two in-flight requests for the same repo.
describe("doAction/commit/commitSelected: re-entrancy guard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("refuses a second action while one is already in flight for the same repo", async () => {
    const h = harness([repo()]);
    let resolveFirst!: (v: ActionResult) => void;
    vi.spyOn(api, "fetch").mockReturnValue(
      new Promise<ActionResult>((res) => {
        resolveFirst = res;
      }),
    );
    vi.spyOn(api, "pull");

    const first = h.doAction("repo-1", "fetch");
    expect(h.busy["repo-1"]).toBe("fetch");

    const second = await h.doAction("repo-1", "pull");
    expect(second).toEqual({ ok: false, code: "BUSY", message: expect.any(String) });
    expect(api.pull).not.toHaveBeenCalled(); // the second call never reached the API

    resolveFirst({ ok: true, code: "OK", message: "ok" });
    await first;
    expect(h.busy["repo-1"]).toBeUndefined(); // released once the first call settles
  });

  it("does not block a different repo's action", async () => {
    const h = harness([repo("repo-1"), repo("repo-2")]);
    vi.spyOn(api, "fetch").mockReturnValue(new Promise<ActionResult>(() => {})); // never resolves
    vi.spyOn(api, "pull").mockResolvedValue({ ok: true, code: "OK", message: "ok" });

    void h.doAction("repo-1", "fetch");
    const other = await h.doAction("repo-2", "pull");
    expect(other.ok).toBe(true);
  });

  it("guards commit and commitSelected the same way", async () => {
    const h = harness([repo()]);
    h.busy["repo-1"] = "fetch"; // some other action already running
    vi.spyOn(api, "commit");
    vi.spyOn(api, "commitSelected");

    const commitResult = await h.commit("repo-1", "msg");
    const selectedResult = await h.commitSelected("repo-1", "msg", ["a.ts"]);

    expect(commitResult.code).toBe("BUSY");
    expect(selectedResult.code).toBe("BUSY");
    expect(api.commit).not.toHaveBeenCalled();
    expect(api.commitSelected).not.toHaveBeenCalled();
  });
});

// assignIdentity/assignRepoAccount patched optimistically with no try/catch at all — the only
// setters in this file that didn't roll back a failed request, unlike setHidden/setPinned/setStarred.
describe("assignIdentity / assignRepoAccount: rollback on failure", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rolls back identityId when the request fails", async () => {
    const h = harness([repo("repo-1", { identityId: "old" })]);
    vi.spyOn(api, "assignIdentity").mockRejectedValue(new Error("boom"));

    await expect(h.assignIdentity("repo-1", "new")).rejects.toThrow("boom");
    expect(h.repos.value[0]?.identityId).toBe("old");
  });

  it("keeps the optimistic identityId when the request succeeds", async () => {
    const h = harness([repo("repo-1", { identityId: "old" })]);
    vi.spyOn(api, "assignIdentity").mockResolvedValue(repo("repo-1", { identityId: "new" }));

    await h.assignIdentity("repo-1", "new");
    expect(h.repos.value[0]?.identityId).toBe("new");
  });

  it("rolls back the GitHub account fields when the request fails", async () => {
    const h = harness([
      repo("repo-1", { syncAccountHost: "github.com", syncAccountLogin: "old" }),
    ]);
    vi.spyOn(api, "assignRepoAccount").mockRejectedValue(new Error("boom"));

    await expect(h.assignRepoAccount("repo-1", "github.com", "new")).rejects.toThrow("boom");
    expect(h.repos.value[0]?.syncAccountHost).toBe("github.com");
    expect(h.repos.value[0]?.syncAccountLogin).toBe("old");
  });

  it("keeps the optimistic account fields when the request succeeds", async () => {
    const h = harness([repo("repo-1", { syncAccountHost: null, syncAccountLogin: null })]);
    vi.spyOn(api, "assignRepoAccount").mockResolvedValue(
      repo("repo-1", { syncAccountHost: "github.com", syncAccountLogin: "new" }),
    );

    await h.assignRepoAccount("repo-1", "github.com", "new");
    expect(h.repos.value[0]?.syncAccountHost).toBe("github.com");
    expect(h.repos.value[0]?.syncAccountLogin).toBe("new");
  });
});

// Issue #17. doAction used to leave push/pull/fetch waiting on an SSE repo_state_changed frame
// to learn their own result, which left the Push button green until a manual Refresh — the one
// action that already patched from its own response. doAction now calls applyActionStatus(repoId,
// result) after every mutating call, so the initiator reconciles from its own http response.
describe("doAction: reconciles status from the action's own response (#17)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("patches status from the result, with no SSE event involved", async () => {
    const h = harness([repo("repo-1", { status: status({ ahead: 1 }) })]);
    vi.spyOn(api, "push").mockResolvedValue({
      ok: true,
      code: "OK",
      message: "pushed",
      status: status({ ahead: 0 }),
    });

    const result = await h.doAction("repo-1", "push");

    expect(result.ok).toBe(true);
    expect(h.repos.value[0]?.status?.ahead).toBe(0);
  });

  it("leaves the existing status untouched when the result carries no status key", async () => {
    const seeded = status({ ahead: 1 });
    const h = harness([repo("repo-1", { status: seeded })]);
    vi.spyOn(api, "push").mockResolvedValue({ ok: true, code: "OK", message: "pushed" });

    await h.doAction("repo-1", "push");

    // untouched — applyActionStatus early-returns on result.status === undefined. toEqual, not
    // toBe: repos.value[0] is a reactive proxy wrapping `seeded`, not the same object reference.
    expect(h.repos.value[0]?.status).toEqual(seeded);
    expect(h.repos.value[0]?.status?.ahead).toBe(1);
  });
});
