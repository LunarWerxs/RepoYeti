import { reactive } from "vue";
import { api } from "../api";
import type {
  ActionResult,
  BranchList,
  IncomingResult,
  LogAuthorFilter,
  LogResult,
  RepoStatus,
  StashList,
  TagList,
} from "../types";

/**
 * History rows are deliberately retained in memory because the graph needs the preceding rows to
 * lay out lanes. Keep that useful window bounded: an all-day History tab should not accumulate an
 * unbounded reactive array (and tens of thousands of DOM nodes) just because its sentinel stayed
 * visible. Five hundred commits is ten normal pages and still a generous interactive window.
 */
export const MAX_RETAINED_LOG_COMMITS = 500;
export const MAX_RETAINED_GIT_REPO_CACHES = 12;

/** Branches / history / stash / tags / remotes / discard — lazily loaded per repo when the
 *  relevant card section opens. `loadChanges` and `asResult` are shared with the rest of the
 *  store (passed in) so a stash/discard refreshes the same changed-file tree and errors are
 *  normalised the same way everywhere. */
export function useGitOps(
  loadChanges: (repoId: string) => Promise<void>,
  asResult: (e: unknown) => ActionResult,
  isRepoLive: (repoId: string) => boolean,
  onHistoryChanged: (repoId: string) => void = () => {},
  /** Reconcile the repo's status from a mutating action's own response — see repo.ts. */
  applyActionStatus: (repoId: string, result: { status?: RepoStatus | null }) => void = () => {},
) {
  // ── branches / history / stash (lazily loaded per repo when a section opens) ──
  const branchesByRepo = reactive<Record<string, BranchList>>({});
  const logByRepo = reactive<Record<string, LogResult>>({});
  const stashesByRepo = reactive<Record<string, StashList>>({});
  const tagsByRepo = reactive<Record<string, TagList>>({});
  /** repoId → the last Preview Pull result, and whether one is in flight. */
  const incomingByRepo = reactive<Record<string, IncomingResult>>({});
  const incomingLoading = reactive<Record<string, boolean>>({});
  /** repoId → a secondary git op in flight (branch switch / stash / discard …), for spinners
   *  and to disable the relevant control. Distinct from `busy` (the primary fetch/pull/push). */
  const gitOpBusy = reactive<Record<string, string | undefined>>({});
  const repoCacheLru = new Map<string, true>();

  function hasRepoCache(repoId: string): boolean {
    return (
      Object.hasOwn(branchesByRepo, repoId) ||
      Object.hasOwn(logByRepo, repoId) ||
      Object.hasOwn(stashesByRepo, repoId) ||
      Object.hasOwn(tagsByRepo, repoId) ||
      Object.hasOwn(incomingByRepo, repoId)
    );
  }

  function touchRepoCache(repoId: string): void {
    repoCacheLru.delete(repoId);
    repoCacheLru.set(repoId, true);
    while (repoCacheLru.size > MAX_RETAINED_GIT_REPO_CACHES) {
      const oldest = repoCacheLru.keys().next().value as string | undefined;
      if (!oldest) break;
      clearRepoCache(oldest);
    }
  }

  // Latest-request tokens make late responses harmless (repo removed, scope changed, refresh
  // superseded) without keeping one generation counter forever for every removed repo. Entries
  // exist only while a read is active and disappear on settle/clear.
  type ReadKind = "branches" | "log" | "incoming" | "stashes" | "tags";
  const activeReads = new Map<string, Map<ReadKind, symbol>>();
  function beginRead(repoId: string, kind: ReadKind): symbol {
    const token = Symbol(`${kind}:${repoId}`);
    const reads = activeReads.get(repoId) ?? new Map<ReadKind, symbol>();
    reads.set(kind, token);
    activeReads.set(repoId, reads);
    return token;
  }
  function isCurrentRead(repoId: string, kind: ReadKind, token: symbol): boolean {
    return isRepoLive(repoId) && activeReads.get(repoId)?.get(kind) === token;
  }
  function finishRead(repoId: string, kind: ReadKind, token: symbol): void {
    const reads = activeReads.get(repoId);
    if (reads?.get(kind) !== token) return;
    reads.delete(kind);
    if (reads.size === 0) activeReads.delete(repoId);
    if (isRepoLive(repoId) && hasRepoCache(repoId)) touchRepoCache(repoId);
  }

  async function loadBranches(repoId: string): Promise<void> {
    if (!isRepoLive(repoId)) return;
    const request = beginRead(repoId, "branches");
    try {
      const result = await api.branches(repoId);
      if (isCurrentRead(repoId, "branches", request)) branchesByRepo[repoId] = result;
    } catch (e) {
      if (isCurrentRead(repoId, "branches", request)) {
        branchesByRepo[repoId] = { ...asResult(e), current: null, detached: false, branches: [] };
      }
    } finally {
      finishRead(repoId, "branches", request);
    }
  }

  /**
   * The repo's refs moved, so anything derived from them is stale. Re-read the caches that are
   * ALREADY loaded and leave the rest alone: these lists are lazily fetched when a card's section
   * opens, and fetching for a repo nobody has expanded would put load on the git read gate for a
   * list no one is looking at.
   *
   * Fixes issue #22 — a branch checked out, updated or deleted OUTSIDE RepoYeti left the branch
   * selector showing the old branch and offering branches that no longer exist, and only a full
   * page reload cleared it. Wired to every status update through repo.ts's patchRepo, so the
   * manual Refresh button, an action's own response and the SSE frame all reconcile identically.
   */
  function reloadRefCaches(repoId: string): void {
    if (!isRepoLive(repoId)) return;
    if (Object.hasOwn(branchesByRepo, repoId)) void loadBranches(repoId);
    if (Object.hasOwn(tagsByRepo, repoId)) void loadTags(repoId);
  }

  async function switchBranch(repoId: string, branch: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "checkout";
    try {
      const r = await api.checkout(repoId, branch);
      applyActionStatus(repoId, r);
      await loadBranches(repoId);
      if (r.ok) onHistoryChanged(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  async function createBranch(repoId: string, name: string, switchTo = true): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.createBranch(repoId, name, switchTo);
      applyActionStatus(repoId, r);
      await loadBranches(repoId);
      if (r.ok) onHistoryChanged(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  async function deleteBranch(repoId: string, name: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.deleteBranch(repoId, name);
      applyActionStatus(repoId, r);
      await loadBranches(repoId);
      if (r.ok) onHistoryChanged(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Load (or append, when `skip`>0) the commit log for a repo. `refs` picks the branch scope
   *  the graph view walks (head/local/all); switching it reloads from skip 0 (replace, not append). */
  async function loadLog(
    repoId: string,
    limit = 50,
    skip = 0,
    refs?: "head" | "local" | "all",
    author?: LogAuthorFilter,
  ): Promise<void> {
    if (!isRepoLive(repoId)) return;
    const request = beginRead(repoId, "log");
    try {
      const requestedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
      const targetLimit = Math.min(requestedLimit, MAX_RETAINED_LOG_COMMITS);
      const offset = Number.isFinite(skip) ? Math.max(0, Math.floor(skip)) : 0;
      // The daemon shares the same 500-row cap, so every retained refresh is one `git log`
      // process/ref snapshot. Keep the old complete rows published while that request is pending.
      const res = author
        ? await api.log(repoId, targetLimit, offset, refs, author)
        : await api.log(repoId, targetLimit, offset, refs);
      if (!isCurrentRead(repoId, "log", request)) return;

      if (offset > 0 && logByRepo[repoId]) {
        const commits = [...logByRepo[repoId]!.commits, ...res.commits];
        const retained = commits.slice(0, MAX_RETAINED_LOG_COMMITS);
        logByRepo[repoId] = {
          ...res,
          commits: retained,
          // Once the retained window is full, stop the intersection sentinel. Continuing with
          // skip=retained.length would request the same page forever after the slice above.
          hasMore: res.hasMore && retained.length < MAX_RETAINED_LOG_COMMITS,
        };
      } else {
        const commits = res.commits.slice(0, MAX_RETAINED_LOG_COMMITS);
        logByRepo[repoId] = {
          ...res,
          commits,
          hasMore: res.hasMore && commits.length < MAX_RETAINED_LOG_COMMITS,
        };
      }
    } catch (e) {
      if (!isCurrentRead(repoId, "log", request)) return;
      // A paginated "load more" (skip>0) failure must NOT wipe the commits already on screen — a
      // flaky network request would otherwise blank the whole history. Keep what's shown; the user
      // can retry. Only surface the error/empty state on a first-page load.
      const offset = Number.isFinite(skip) ? Math.max(0, Math.floor(skip)) : 0;
      if (offset > 0 && logByRepo[repoId]?.commits.length) return;
      logByRepo[repoId] = { ...asResult(e), commits: [], hasMore: false };
    } finally {
      finishRead(repoId, "log", request);
    }
  }

  /**
   * Load "what would a pull do?" for the Preview Pull dialog. Fetches first by default so the
   * preview reflects the remote as of NOW, not as of the last background sync (a stale answer
   * would read as "nothing incoming", which is the one wrong answer that matters here).
   * Deliberately not cached: a preview you opened five minutes ago is not a preview.
   */
  async function loadIncoming(repoId: string, fetchFirst = true): Promise<void> {
    if (!isRepoLive(repoId)) return;
    const request = beginRead(repoId, "incoming");
    incomingLoading[repoId] = true;
    try {
      const result = await api.incoming(repoId, fetchFirst);
      if (isCurrentRead(repoId, "incoming", request)) incomingByRepo[repoId] = result;
    } catch (e) {
      if (isCurrentRead(repoId, "incoming", request)) {
        incomingByRepo[repoId] = {
          ...asResult(e),
          upstream: "",
          noUpstream: false,
          ahead: 0,
          behind: 0,
          relation: "unknown",
          pullDisposition: "unknown",
          checkedAt: Date.now(),
          snapshot: null,
          commits: [],
          commitsTruncated: false,
          files: [],
          filesTruncated: false,
          stat: { filesChanged: 0, addedLines: 0, removedLines: 0 },
          conflicts: [],
          conflictCheck: false,
          fastForward: false,
        };
      }
    } finally {
      if (isCurrentRead(repoId, "incoming", request)) delete incomingLoading[repoId];
      finishRead(repoId, "incoming", request);
    }
  }

  async function loadStashes(repoId: string): Promise<void> {
    if (!isRepoLive(repoId)) return;
    const request = beginRead(repoId, "stashes");
    try {
      const result = await api.stashes(repoId);
      if (isCurrentRead(repoId, "stashes", request)) stashesByRepo[repoId] = result;
    } catch (e) {
      if (isCurrentRead(repoId, "stashes", request)) {
        stashesByRepo[repoId] = { ...asResult(e), stashes: [] };
      }
    } finally {
      finishRead(repoId, "stashes", request);
    }
  }

  async function stashSave(repoId: string, message?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashSave(repoId, message);
      applyActionStatus(repoId, r);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  async function stashPop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashPop(repoId, index);
      applyActionStatus(repoId, r);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  async function stashDrop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashDrop(repoId, index);
      applyActionStatus(repoId, r);
      await loadStashes(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Discard one changed file's working-tree changes (destructive — the card confirms first). */
  async function discardFile(repoId: string, path: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "discard";
    try {
      const r = await api.discard(repoId, path);
      applyActionStatus(repoId, r);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "discarded" };
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Delete one file from disk and stage the deletion (destructive — the card confirms first).
   *  Distinct from discardFile, which restores a file to its committed state. */
  async function deleteFile(repoId: string, path: string, recursive = false): Promise<ActionResult> {
    gitOpBusy[repoId] = "delete";
    try {
      const r = await api.deleteFile(repoId, path, recursive);
      applyActionStatus(repoId, r);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "deleted" };
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Stage one changed file's working-tree change into the index (non-destructive; doesn't
   *  commit — the changes-tree per-file "Stage" action, GitHub-Desktop-style). */
  async function stageFile(repoId: string, path: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "stage";
    try {
      const r = await api.stage(repoId, path);
      applyActionStatus(repoId, r);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "staged" };
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Move a changed file into another folder (the changes-tree drag-and-drop). */
  async function moveFile(repoId: string, from: string, toDir: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "move";
    try {
      const r = await api.moveFile(repoId, from, toDir);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "moved" };
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Append a path to the repo's .gitignore (the "Add to .gitignore" row action). Idempotent — an
   *  already-ignored path comes back ok with alreadyIgnored=true. `stillTracked` means the line was
   *  written but git keeps tracking the path, so it changes nothing until the path is untracked. */
  async function addToGitignore(
    repoId: string,
    path: string,
  ): Promise<ActionResult & { alreadyIgnored?: boolean; stillTracked?: boolean }> {
    gitOpBusy[repoId] = "gitignore";
    try {
      const r = await api.addToGitignore(repoId, path);
      applyActionStatus(repoId, r);
      await loadChanges(repoId);
      return {
        ok: r.ok,
        code: r.code,
        message: r.message ?? "ignored",
        alreadyIgnored: r.alreadyIgnored,
        stillTracked: r.stillTracked,
      };
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  // ── remotes / tags ───────────────────────────────────────────────────────────
  async function loadTags(repoId: string): Promise<void> {
    if (!isRepoLive(repoId)) return;
    const request = beginRead(repoId, "tags");
    try {
      const result = await api.tags(repoId);
      if (isCurrentRead(repoId, "tags", request)) tagsByRepo[repoId] = result;
    } catch (e) {
      if (isCurrentRead(repoId, "tags", request)) {
        tagsByRepo[repoId] = { ...asResult(e), tags: [] };
      }
    } finally {
      finishRead(repoId, "tags", request);
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
      if (r.ok) onHistoryChanged(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }
  async function setRemote(repoId: string, url: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      const r = await api.setRemote(repoId, url, name);
      applyActionStatus(repoId, r);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }
  async function removeRemote(repoId: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      const r = await api.removeRemote(repoId, name);
      applyActionStatus(repoId, r);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      delete gitOpBusy[repoId];
    }
  }

  /** Release every lazily-loaded Git view for a repo that left the dashboard. */
  function clearRepoCache(repoId: string): void {
    repoCacheLru.delete(repoId);
    activeReads.delete(repoId);
    delete branchesByRepo[repoId];
    delete logByRepo[repoId];
    delete stashesByRepo[repoId];
    delete tagsByRepo[repoId];
    delete incomingByRepo[repoId];
    delete incomingLoading[repoId];
    delete gitOpBusy[repoId];
  }

  /** Drop stale cache keys after a full list refresh (covers removals missed while SSE was down). */
  function pruneRepoCache(liveRepoIds: ReadonlySet<string>): void {
    const cachedIds = new Set([
      ...Object.keys(branchesByRepo),
      ...Object.keys(logByRepo),
      ...Object.keys(stashesByRepo),
      ...Object.keys(tagsByRepo),
      ...Object.keys(incomingByRepo),
      ...Object.keys(incomingLoading),
      ...Object.keys(gitOpBusy),
      ...activeReads.keys(),
      ...repoCacheLru.keys(),
    ]);
    for (const repoId of cachedIds) {
      if (!liveRepoIds.has(repoId)) clearRepoCache(repoId);
    }
  }

  return {
    branchesByRepo,
    logByRepo,
    stashesByRepo,
    gitOpBusy,
    loadBranches,
    reloadRefCaches,
    switchBranch,
    createBranch,
    deleteBranch,
    loadLog,
    loadStashes,
    tagsByRepo,
    loadTags,
    incomingByRepo,
    incomingLoading,
    loadIncoming,
    createTag,
    setRemote,
    removeRemote,
    stashSave,
    stashPop,
    stashDrop,
    discardFile,
    deleteFile,
    stageFile,
    moveFile,
    addToGitignore,
    clearRepoCache,
    pruneRepoCache,
  };
}
