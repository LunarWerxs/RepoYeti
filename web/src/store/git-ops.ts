import { reactive } from "vue";
import { api } from "../api";
import type { ActionResult, BranchList, LogResult, StashList, TagList } from "../types";

/** Branches / history / stash / tags / remotes / discard — lazily loaded per repo when the
 *  relevant card section opens. `loadChanges` and `asResult` are shared with the rest of the
 *  store (passed in) so a stash/discard refreshes the same changed-file tree and errors are
 *  normalised the same way everywhere. */
export function useGitOps(
  loadChanges: (repoId: string) => Promise<void>,
  asResult: (e: unknown) => ActionResult,
) {
  // ── branches / history / stash (lazily loaded per repo when a section opens) ──
  const branchesByRepo = reactive<Record<string, BranchList>>({});
  const logByRepo = reactive<Record<string, LogResult>>({});
  const stashesByRepo = reactive<Record<string, StashList>>({});
  const tagsByRepo = reactive<Record<string, TagList>>({});
  /** repoId → a secondary git op in flight (branch switch / stash / discard …), for spinners
   *  and to disable the relevant control. Distinct from `busy` (the primary fetch/pull/push). */
  const gitOpBusy = reactive<Record<string, string | undefined>>({});

  async function loadBranches(repoId: string): Promise<void> {
    try {
      branchesByRepo[repoId] = await api.branches(repoId);
    } catch (e) {
      branchesByRepo[repoId] = { ...asResult(e), current: null, detached: false, branches: [] };
    }
  }

  async function switchBranch(repoId: string, branch: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "checkout";
    try {
      const r = await api.checkout(repoId, branch);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function createBranch(repoId: string, name: string, switchTo = true): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.createBranch(repoId, name, switchTo);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function deleteBranch(repoId: string, name: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.deleteBranch(repoId, name);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  /** Load (or append, when `skip`>0) the commit log for a repo. `refs` picks the branch scope
   *  the graph view walks (head/local/all); switching it reloads from skip 0 (replace, not append). */
  async function loadLog(
    repoId: string,
    limit = 50,
    skip = 0,
    refs?: "head" | "local" | "all",
  ): Promise<void> {
    try {
      const res = await api.log(repoId, limit, skip, refs);
      if (skip > 0 && logByRepo[repoId]) {
        logByRepo[repoId] = {
          ...res,
          commits: [...logByRepo[repoId]!.commits, ...res.commits],
        };
      } else {
        logByRepo[repoId] = res;
      }
    } catch (e) {
      // A paginated "load more" (skip>0) failure must NOT wipe the commits already on screen — a
      // flaky network request would otherwise blank the whole history. Keep what's shown; the user
      // can retry. Only surface the error/empty state on a first-page load.
      if (skip > 0 && logByRepo[repoId]?.commits.length) return;
      logByRepo[repoId] = { ...asResult(e), commits: [], hasMore: false };
    }
  }

  async function loadStashes(repoId: string): Promise<void> {
    try {
      stashesByRepo[repoId] = await api.stashes(repoId);
    } catch (e) {
      stashesByRepo[repoId] = { ...asResult(e), stashes: [] };
    }
  }

  async function stashSave(repoId: string, message?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashSave(repoId, message);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function stashPop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashPop(repoId, index);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function stashDrop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashDrop(repoId, index);
      await loadStashes(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  /** Discard one changed file's working-tree changes (destructive — the card confirms first). */
  async function discardFile(repoId: string, path: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "discard";
    try {
      const r = await api.discard(repoId, path);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "discarded" };
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  // ── remotes / tags ───────────────────────────────────────────────────────────
  async function loadTags(repoId: string): Promise<void> {
    try {
      tagsByRepo[repoId] = await api.tags(repoId);
    } catch (e) {
      tagsByRepo[repoId] = { ...asResult(e), tags: [] };
    }
  }
  async function createTag(
    repoId: string,
    input: { name: string; message?: string; push?: boolean },
  ): Promise<ActionResult> {
    gitOpBusy[repoId] = "tag";
    try {
      const r = await api.createTag(repoId, input);
      await loadTags(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }
  async function setRemote(repoId: string, url: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      return await api.setRemote(repoId, url, name);
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }
  async function removeRemote(repoId: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      return await api.removeRemote(repoId, name);
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  return {
    branchesByRepo,
    logByRepo,
    stashesByRepo,
    gitOpBusy,
    loadBranches,
    switchBranch,
    createBranch,
    deleteBranch,
    loadLog,
    loadStashes,
    tagsByRepo,
    loadTags,
    createTag,
    setRemote,
    removeRemote,
    stashSave,
    stashPop,
    stashDrop,
    discardFile,
  };
}
