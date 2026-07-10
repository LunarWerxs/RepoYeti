import { ref, reactive, computed, watch, type Ref } from "vue";
import { api } from "../api";
import type { ActionName, ActionResult, ChangedFile, Repo } from "../types";

/** Sync-status filter keys (multi-select; OR semantics). */
export type StatusKey = "dirty" | "ahead" | "behind" | "clean" | "error";

/**
 * Repo-list filters/sections plus the per-repo card actions (fetch/pull/push/refresh,
 * commit, changed-file tree, identity/account assignment, hide/pin/star). Shares `repos`
 * and `busy` with the rest of the store (passed in) so patches stay reactive everywhere.
 */
export function useRepoActions(
  repos: Ref<Repo[]>,
  busy: Record<string, ActionName | undefined>,
  asResult: (e: unknown) => ActionResult,
) {
  /** repoId → changed-file list (for the expandable tree view), lazily loaded. */
  const changesByRepo = reactive<Record<string, ChangedFile[]>>({});
  const changesLoading = reactive<Record<string, boolean>>({});
  /** repoId → { total, truncated } when the server capped an oversized changed-file list
   *  (MAX_CHANGED_FILES); drives the "showing N of M" notice. Absent = not truncated. */
  const changesMeta = reactive<Record<string, { total: number; truncated: boolean }>>({});

  // ── list filters (display-only; drag-reorder is disabled while a filter is active) ──
  const filterQuery = ref("");
  // undefined = all · null = "no identity" · string = a specific identity id
  const filterIdentity = ref<string | null | undefined>(undefined);
  // multi-select: an empty set means "any status"; multiple selected = OR (e.g. ahead OR behind).
  const filterStatuses = ref<StatusKey[]>([]);
  // Hidden repos are excluded from every view unless this is on (a deprecated-repo opt-out,
  // not a "filter" — drag-reorder still works over the visible set when it's off).
  const showHidden = ref(false);
  const hasHidden = computed(() => repos.value.some((r) => r.hidden));
  /** The repos any non-search view starts from: hidden ones dropped unless showHidden. */
  const visibleRepos = computed(() =>
    showHidden.value ? repos.value : repos.value.filter((r) => !r.hidden),
  );
  const filtersActive = computed(
    () =>
      !!filterQuery.value.trim() ||
      filterIdentity.value !== undefined ||
      filterStatuses.value.length > 0,
  );
  // ── dashboard sections (display-only buckets, precedence: pinned > starred > rest) ──
  // A repo lands in exactly one section so it never renders twice; the card can still
  // show both badges. Each preserves the global sort_order via `visibleRepos`.
  const pinnedRepos = computed(() => visibleRepos.value.filter((r) => r.pinned));
  const starredRepos = computed(() => visibleRepos.value.filter((r) => r.starred && !r.pinned));
  const otherRepos = computed(() => visibleRepos.value.filter((r) => !r.pinned && !r.starred));
  function matchesStatus(r: Repo, key: StatusKey): boolean {
    const st = r.status;
    switch (key) {
      case "dirty":
        return !!st && st.dirty > 0;
      case "ahead":
        return !!st && st.ahead > 0;
      case "behind":
        return !!st && st.behind > 0;
      case "error":
        return !!st?.error;
      case "clean":
        return !!st && !st.error && st.dirty === 0 && st.ahead === 0 && st.behind === 0;
    }
  }
  function toggleStatus(key: StatusKey): void {
    const i = filterStatuses.value.indexOf(key);
    if (i >= 0) filterStatuses.value.splice(i, 1);
    else filterStatuses.value.push(key);
  }
  const filteredRepos = computed(() => {
    const q = filterQuery.value.trim().toLowerCase();
    const statuses = filterStatuses.value;
    return visibleRepos.value.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (filterIdentity.value !== undefined) {
        const bad =
          filterIdentity.value === null ? !!r.identityId : r.identityId !== filterIdentity.value;
        if (bad) return false;
      }
      // OR across selected statuses; empty = match anything.
      if (statuses.length && !statuses.some((s) => matchesStatus(r, s))) return false;
      return true;
    });
  });
  function clearFilters(): void {
    filterQuery.value = "";
    filterIdentity.value = undefined;
    filterStatuses.value = [];
  }

  // ── Conflict Concierge triage card ────────────────────────────────────────────
  // State-driven (not event-driven): derived straight from each repo's live status, so it
  // survives reloads and clears itself the instant a repo's conflict/mid-op condition does —
  // no toast/SSE bookkeeping to go stale. The daemon computes `conflicted`/`gitOperation`
  // additively in RepoStatus (src/read/status.ts), reusing the exact same detection the
  // auto-commit safety gate uses (src/git.ts currentGitOperation).
  const needsAttentionRepos = computed(() =>
    repos.value.filter((r) => !!r.status && (!!r.status.conflicted || !!r.status.gitOperation)),
  );
  // Dismissed for THIS session only (per repo id) — cleared on reload, and re-added automatically
  // the moment a dismissed repo's condition clears then reappears (dismissedIds isn't pruned
  // proactively; the card's visible list already re-filters live conflicted repos each render,
  // so a repo that leaves and re-enters the attention set shows again because dismissal only
  // suppresses a still-ongoing one — see dismissAttention()).
  const dismissedAttentionIds = ref<Set<string>>(new Set());
  const visibleAttentionRepos = computed(() =>
    needsAttentionRepos.value.filter((r) => !dismissedAttentionIds.value.has(r.id)),
  );
  /** Dismiss one repo's triage row for the rest of this session. If it clears and a NEW
   *  conflict/mid-op starts later, the id is re-derived fresh next status read, so the card
   *  un-suppresses itself automatically the same way it would on a first sighting — nothing to
   *  reset by hand on the daemon side. We DO still forget the dismissal once the underlying
   *  condition clears, so a stale id can't accidentally hide a brand-new future conflict. */
  function dismissAttention(repoId: string): void {
    dismissedAttentionIds.value.add(repoId);
  }
  watch(needsAttentionRepos, (current) => {
    if (dismissedAttentionIds.value.size === 0) return;
    const stillNeeds = new Set(current.map((r) => r.id));
    for (const id of [...dismissedAttentionIds.value]) {
      if (!stillNeeds.has(id)) dismissedAttentionIds.value.delete(id);
    }
  });

  function patchRepo(id: string, patch: Partial<Repo>): void {
    const r = repos.value.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  // (commit is separate — it needs a message — see `commit()` below)
  async function doAction(
    repoId: string,
    name: "fetch" | "pull" | "push" | "refresh",
  ): Promise<ActionResult> {
    busy[repoId] = name;
    try {
      if (name === "refresh") {
        const repo = await api.refresh(repoId);
        patchRepo(repoId, { status: repo.status });
        return { ok: true, code: "OK", message: "refreshed" };
      }
      return await api[name](repoId);
    } catch (e) {
      return asResult(e);
    } finally {
      busy[repoId] = undefined;
    }
  }

  async function loadChanges(repoId: string): Promise<void> {
    if (changesLoading[repoId]) return; // don't stack concurrent reads for the same repo
    changesLoading[repoId] = true;
    try {
      const res = await api.changes(repoId);
      changesByRepo[repoId] = res.files ?? [];
      if (res.truncated) changesMeta[repoId] = { total: res.total ?? res.files.length, truncated: true };
      else delete changesMeta[repoId];
    } catch {
      changesByRepo[repoId] = [];
      delete changesMeta[repoId];
    } finally {
      changesLoading[repoId] = false;
    }
  }

  async function commit(repoId: string, message: string, amend = false): Promise<ActionResult> {
    busy[repoId] = "commit";
    try {
      return await api.commit(repoId, message, amend);
    } catch (e) {
      return asResult(e);
    } finally {
      busy[repoId] = undefined;
    }
  }

  // Per-file staging: commit ONLY `paths` (the rest stay pending), so the changes tree must be
  // reloaded afterward to drop the committed files (unlike a full commit, which empties the tree
  // and hides the section). The SSE status push refreshes the dirty count; this refreshes the list.
  async function commitSelected(repoId: string, message: string, paths: string[]): Promise<ActionResult> {
    busy[repoId] = "commit";
    try {
      return await api.commitSelected(repoId, message, paths);
    } catch (e) {
      return asResult(e);
    } finally {
      // ALWAYS refresh the changed-file list — not just on success. On a PLAN_STALE failure (a
      // selected file vanished out-of-band) this re-syncs the tree so RepoCard's prune watch drops
      // the now-stale path from the selection, instead of leaving it checked in a retry loop.
      await loadChanges(repoId);
      busy[repoId] = undefined;
    }
  }

  async function assignIdentity(repoId: string, identityId: string | null): Promise<void> {
    patchRepo(repoId, { identityId }); // optimistic
    await api.assignIdentity(repoId, identityId);
  }

  /** Pin (or clear) the GitHub account a repo syncs as. Optimistic; the repo_account_changed SSE
   *  echo keeps every device in step. */
  async function assignRepoAccount(repoId: string, host: string | null, login: string | null): Promise<void> {
    patchRepo(repoId, {
      syncAccountHost: login ? host || "github.com" : null,
      syncAccountLogin: login,
    }); // optimistic
    await api.assignRepoAccount(repoId, host, login);
  }

  /** Hide/unhide a repo from the dashboard (optimistic; rolls back on failure). */
  async function setHidden(repoId: string, hidden: boolean): Promise<void> {
    patchRepo(repoId, { hidden }); // optimistic
    try {
      await api.setHidden(repoId, hidden);
    } catch (e) {
      patchRepo(repoId, { hidden: !hidden }); // roll back
      throw e;
    }
  }

  /** Pin/unpin a repo into the "Pinned" section (optimistic; rolls back on failure). */
  async function setPinned(repoId: string, pinned: boolean): Promise<void> {
    patchRepo(repoId, { pinned }); // optimistic
    try {
      await api.setPinned(repoId, pinned);
    } catch (e) {
      patchRepo(repoId, { pinned: !pinned }); // roll back
      throw e;
    }
  }

  /** Star/unstar a repo into the "Starred" section (optimistic; rolls back on failure). */
  async function setStarred(repoId: string, starred: boolean): Promise<void> {
    patchRepo(repoId, { starred }); // optimistic
    try {
      await api.setStarred(repoId, starred);
    } catch (e) {
      patchRepo(repoId, { starred: !starred }); // roll back
      throw e;
    }
  }

  /** Opt a repo in/out of the auto-commit timer (optimistic; rolls back on failure). */
  async function setAutoCommit(repoId: string, autoCommit: boolean): Promise<void> {
    patchRepo(repoId, { autoCommit }); // optimistic
    try {
      await api.setRepoAutoCommit(repoId, autoCommit);
    } catch (e) {
      patchRepo(repoId, { autoCommit: !autoCommit }); // roll back
      throw e;
    }
  }

  return {
    changesByRepo,
    changesLoading,
    changesMeta,
    loadChanges,
    filterQuery,
    filterIdentity,
    filterStatuses,
    toggleStatus,
    filtersActive,
    filteredRepos,
    clearFilters,
    showHidden,
    hasHidden,
    visibleRepos,
    pinnedRepos,
    starredRepos,
    otherRepos,
    needsAttentionRepos,
    visibleAttentionRepos,
    dismissAttention,
    patchRepo,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    setHidden,
    setPinned,
    setStarred,
    setAutoCommit,
  };
}
