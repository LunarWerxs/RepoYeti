import { ref, reactive, computed, watch, type Ref } from "vue";
import { api } from "../api";
import type { ActionName, ActionResult, ChangedFile, Repo } from "../types";

/** Sync-status filter keys (multi-select; OR semantics). */
export type StatusKey = "dirty" | "ahead" | "behind" | "clean" | "error";

/** Display-only list ordering. "manual" is today's drag-persisted `sort_order` from the
 *  daemon (the backward-compatible default); "name" and "recent" re-sort purely client-side
 *  and never touch `sort_order`, so switching back to "manual" always restores the owner's
 *  last drag arrangement. */
export type SortMode = "manual" | "name" | "recent";
export const MAX_RETAINED_CHANGE_REPOS = 12;

// Client-only display preference (like desktopNotify); no daemon/API involvement, so
// switching sort mode can never disturb the drag-persisted `sort_order` column.
const SORT_MODE_KEY = "repoyeti.sortMode";
function loadSortModePref(): SortMode {
  try {
    const v = localStorage.getItem(SORT_MODE_KEY);
    if (v === "manual" || v === "name" || v === "recent") return v;
  } catch {
    /* private mode / storage disabled: fall through to the default */
  }
  return "manual";
}
function saveSortModePref(mode: SortMode): void {
  try {
    localStorage.setItem(SORT_MODE_KEY, mode);
  } catch {
    /* private mode / storage disabled; the in-memory ref still drives this session */
  }
}

/** A repo's drag-persisted position, with a pre-`sortOrder` daemon's missing field read as "none". */
function rank(repo: Repo): number | null {
  return typeof repo.sortOrder === "number" ? repo.sortOrder : null;
}

/**
 * Repo-list filters/sections plus the per-repo card actions (fetch/pull/push/refresh,
 * commit, changed-file tree, identity/account assignment, hide/pin/star). Shares `repos`
 * and `busy` with the rest of the store (passed in) so patches stay reactive everywhere.
 */
export function useRepoActions(
  repos: Ref<Repo[]>,
  busy: Record<string, ActionName | undefined>,
  asResult: (e: unknown) => ActionResult,
  onHistoryChanged: (repoId: string) => void = () => {},
) {
  // ── display sort mode (client-only; never touches the daemon's drag-persisted order) ──
  const sortMode = ref<SortMode>(loadSortModePref());
  function setSortMode(mode: SortMode): void {
    sortMode.value = mode;
    saveSortModePref(mode);
  }
  function sortRepos(list: Repo[]): Repo[] {
    switch (sortMode.value) {
      case "name":
        return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      case "recent":
        return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      default:
        return list; // "manual": today's server-derived order, untouched
    }
  }
  /** repoId → changed-file list (for the expandable tree view), lazily loaded. */
  const changesByRepo = reactive<Record<string, ChangedFile[]>>({});
  const changesLoading = reactive<Record<string, boolean>>({});
  /** repoId → { total, truncated } when the server capped an oversized changed-file list
   *  (MAX_CHANGED_FILES); drives the "showing N of M" notice. Absent = not truncated. */
  const changesMeta = reactive<Record<string, { total: number; truncated: boolean }>>({});
  // Only ACTIVE reads occupy this map. Clearing a repo deletes its token, so a late response is
  // ignored without retaining one generation counter forever for every repo ever encountered.
  const changesRequests = new Map<string, symbol>();
  const changesCacheLru = new Map<string, true>();

  function touchChangesCache(repoId: string): void {
    changesCacheLru.delete(repoId);
    changesCacheLru.set(repoId, true);
    while (changesCacheLru.size > MAX_RETAINED_CHANGE_REPOS) {
      const oldest = changesCacheLru.keys().next().value as string | undefined;
      if (!oldest) break;
      changesCacheLru.delete(oldest);
      changesRequests.delete(oldest);
      delete changesByRepo[oldest];
      delete changesLoading[oldest];
      delete changesMeta[oldest];
    }
  }

  // Status hydration and live SSE can patch thousands of repos in quick succession. A linear
  // `find()` for every patch made that O(n²) on a large scan. The array is replaced on full
  // reloads (detected by identity); ordinary updates preserve Repo object identity, so this small
  // lookup stays correct without a deep watcher over every status field.
  let lookupSource: Repo[] | null = null;
  const repoLookup = new Map<string, Repo>();

  // ── batched insertion for freshly discovered repos ────────────────────────────────────
  // A "scan whole computer" run fires a `repo_added` SSE event per repo it finds — hundreds in a
  // burst. Splicing each one into `repos.value` immediately re-triggers every dependent computed
  // (visibleRepos, filteredRepos, pinned/starred/other) once per repo, so a scan's client-side
  // work scaled O(n²) and the tab janked mid-scan. New repos are buffered here and flushed as one
  // sorted merge + one array replace per animation frame, so a whole burst costs one recompute.
  // Refreshes of repos ALREADY live stay immediate (the `Object.assign` path below) — those were
  // already O(1) and never caused the jank, only first-time inserts did.
  const pendingInserts = new Map<string, Repo>(); // id → raw SSE repo; a repeated id just overwrites
  let flushHandle: number | null = null;
  let flushIsTimer = false;

  function findRepo(repoId: string): Repo | undefined {
    // A repo can be sitting in the insert buffer, not yet spliced into `repos.value` — look there
    // first so a patch that lands between "discovered" and "flushed" (e.g. a fast-following status
    // update for the same id) still applies instead of silently no-op'ing.
    const pending = pendingInserts.get(repoId);
    if (pending) return pending;
    if (lookupSource !== repos.value) {
      lookupSource = repos.value;
      repoLookup.clear();
      for (const repo of repos.value) repoLookup.set(repo.id, repo);
    }
    const cached = repoLookup.get(repoId);
    if (cached) return cached;
    const found = repos.value.find((repo) => repo.id === repoId);
    if (found) repoLookup.set(repoId, found);
    return found;
  }

  /** Insert or refresh a repo from a deliberate, one-off local action (register/create/clone/
   *  restore) — always immediate, never buffered, so the card the owner just triggered appears
   *  the instant the call returns. Bulk discovery goes through `queueRepoAdded` instead. */
  function upsertRepo(next: Repo): void {
    if (lookupSource !== repos.value) {
      lookupSource = repos.value;
      repoLookup.clear();
      for (const repo of repos.value) repoLookup.set(repo.id, repo);
    }
    const current = repoLookup.get(next.id);
    if (current) {
      Object.assign(current, next);
      return;
    }
    // Rare race: a scan's burst already buffered this same id (not yet flushed) when a manual
    // action for it lands too — fold the newer data in and promote it to live now instead of
    // leaving a duplicate for the next flush to (correctly, but needlessly slowly) resolve.
    const pending = pendingInserts.get(next.id);
    if (pending) {
      Object.assign(pending, next);
      pendingInserts.delete(next.id);
      insertLive(pending);
      return;
    }
    insertLive(next);
  }

  /** Splice a repo into `repos.value` at its server-ordered position. `next` is a RAW object;
   *  splicing it into a deep-reactive array stores the raw value in the proxy's target, and only
   *  reading it BACK out yields the reactive proxy the rendered list actually depends on. Caching
   *  the raw reference in `repoLookup` would make a later patchRepo() Object.assign land straight
   *  on the target, bypassing the proxy's set trap — so cache what the array yields, not what we
   *  handed it. Position shifts on a later splice, but each cached value is the same proxy
   *  object, so the lookup stays valid regardless. */
  function insertLive(next: Repo): void {
    const index = serverOrderIndex(next);
    repos.value.splice(index, 0, next);
    repoLookup.set(next.id, repos.value[index]!);
  }

  /**
   * getRepos()'s `ORDER BY (sort_order IS NULL) ASC, sort_order ASC, is_submodule ASC,
   * name COLLATE NOCASE ASC`, expressed for one pair. Kept in lockstep with src/db.ts so a
   * repo that streams in mid-session lands exactly where a reload would place it.
   */
  function compareServerOrder(a: Repo, b: Repo): number {
    // A daemon older than this field sends no `sortOrder` at all. Treating that `undefined` as
    // "has a position" would file every repo into the dragged bucket, so normalise it away first.
    const ra = rank(a);
    const rb = rank(b);
    if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (a.isSubmodule !== b.isSubmodule) return a.isSubmodule ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }

  /** First index whose repo sorts after `next`; the array length when it belongs last. */
  function serverOrderIndex(next: Repo): number {
    const list = repos.value;
    for (let i = 0; i < list.length; i++) {
      if (compareServerOrder(next, list[i]!) < 0) return i;
    }
    return list.length;
  }

  /**
   * Buffer a repo discovered via the live `repo_added` SSE event — used only by that one call
   * site (the store's event stream), never by a manual add/clone/restore, which stay immediate
   * via `upsertRepo` above. A "scan whole computer" run fires this once per repo it finds, so
   * refreshing an already-live repo still applies right away (cheap, O(1), was never the
   * problem); only a genuinely new repo goes on the buffer, flushed in one batch below.
   */
  function queueRepoAdded(next: Repo): void {
    if (lookupSource !== repos.value) {
      lookupSource = repos.value;
      repoLookup.clear();
      for (const repo of repos.value) repoLookup.set(repo.id, repo);
    }
    const current = repoLookup.get(next.id);
    if (current) {
      Object.assign(current, next);
      return;
    }
    const pending = pendingInserts.get(next.id);
    if (pending) Object.assign(pending, next);
    else pendingInserts.set(next.id, next);
    scheduleFlush();
  }

  function scheduleFlush(): void {
    if (flushHandle !== null) return;
    if (typeof requestAnimationFrame === "function") {
      flushHandle = requestAnimationFrame(flushPendingInserts);
      flushIsTimer = false;
    } else {
      // No rAF (SSR / a test env without a polyfill) — a short timer still coalesces a burst
      // instead of firing a flush per event.
      flushHandle = setTimeout(flushPendingInserts, 16) as unknown as number;
      flushIsTimer = true;
    }
  }

  /** Merge every buffered repo into `repos.value` in one pass — a single sorted merge instead of
   *  N splices, so a whole burst of `repo_added` events recomputes dependent state exactly once. */
  function flushPendingInserts(): void {
    flushHandle = null;
    if (pendingInserts.size === 0) return;
    // `repos.value` can have been wholesale-replaced since these were buffered (a fresh reload, a
    // manual-order reset, an identity switch) — that replacement is authoritative for whatever it
    // already carries, so drop any buffered repo it already has rather than merging a stale copy
    // on top of it (which would duplicate the card). This is what keeps the buffer from leaking
    // stale data across a store reset instead of an ordinary flush.
    const liveIds = new Set(repos.value.map((r) => r.id));
    const toInsert: Repo[] = [];
    for (const [id, repo] of pendingInserts) {
      if (!liveIds.has(id)) toInsert.push(repo);
    }
    pendingInserts.clear();
    if (toInsert.length === 0) return;
    // Stable sort with the exact comparator the old per-event path used, then a linear merge —
    // together equivalent to inserting each one at its `serverOrderIndex` in arrival order, just
    // without the O(n) rescan per repo.
    toInsert.sort(compareServerOrder);
    const list = repos.value;
    const merged: Repo[] = [];
    let i = 0;
    let j = 0;
    while (i < list.length && j < toInsert.length) {
      if (compareServerOrder(toInsert[j]!, list[i]!) < 0) merged.push(toInsert[j++]!);
      else merged.push(list[i++]!);
    }
    while (i < list.length) merged.push(list[i++]!);
    while (j < toInsert.length) merged.push(toInsert[j++]!);
    repos.value = merged; // one reactive replace; repoLookup rebuilds lazily next access
  }

  /** Force any buffered inserts in right now. Call this when a scan ends so the last burst of
   *  `repo_added` events isn't left waiting on the next animation frame after the UI already
   *  reports the scan as done (also handy for tests, which don't want to await a real rAF). */
  function flushPendingRepoInserts(): void {
    if (flushHandle !== null) {
      if (flushIsTimer) clearTimeout(flushHandle);
      else cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
    flushPendingInserts();
  }

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
  /** Any repo carries a drag-persisted position, so the list is pinned to a saved arrangement
   *  and every newly discovered repo is forced below it. Gates the "Reset to A–Z" menu entry. */
  const hasManualOrder = computed(() => repos.value.some((r) => rank(r) !== null));
  /** The repos any non-search view starts from: hidden ones dropped unless showHidden, then
   *  re-ordered per the display sort mode (a no-op pass-through in "manual" mode). */
  const visibleRepos = computed(() =>
    sortRepos(showHidden.value ? repos.value : repos.value.filter((r) => !r.hidden)),
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
    const r = findRepo(id);
    if (r) Object.assign(r, patch);
  }
  const getRepoStatus = (repoId: string): Repo["status"] => findRepo(repoId)?.status ?? null;
  const hasRepo = (repoId: string): boolean => findRepo(repoId) !== undefined;

  // ── actions ─────────────────────────────────────────────────────────────────
  // (commit is separate — it needs a message — see `commit()` below)
  async function doAction(
    repoId: string,
    name: "fetch" | "pull" | "push" | "refresh",
  ): Promise<ActionResult> {
    if (busy[repoId]) return { ok: false, code: "BUSY", message: "Another action is already running for this repo." };
    busy[repoId] = name;
    try {
      if (name === "refresh") {
        const repo = await api.refresh(repoId);
        patchRepo(repoId, { status: repo.status });
        return { ok: true, code: "OK", message: "refreshed" };
      }
      const result = await api[name](repoId);
      if (result.ok && (name === "fetch" || name === "pull")) onHistoryChanged(repoId);
      return result;
    } catch (e) {
      return asResult(e);
    } finally {
      delete busy[repoId];
    }
  }

  async function loadChanges(repoId: string): Promise<void> {
    if (!findRepo(repoId)) return;
    if (changesLoading[repoId]) return; // don't stack concurrent reads for the same repo
    const request = Symbol(repoId);
    changesRequests.set(repoId, request);
    changesLoading[repoId] = true;
    try {
      const res = await api.changes(repoId);
      if (changesRequests.get(repoId) !== request || !findRepo(repoId)) return;
      changesByRepo[repoId] = res.files ?? [];
      if (res.truncated) changesMeta[repoId] = { total: res.total ?? res.files.length, truncated: true };
      else delete changesMeta[repoId];
      touchChangesCache(repoId);
    } catch {
      if (changesRequests.get(repoId) !== request || !findRepo(repoId)) return;
      changesByRepo[repoId] = [];
      delete changesMeta[repoId];
      touchChangesCache(repoId);
    } finally {
      if (changesRequests.get(repoId) === request) {
        changesRequests.delete(repoId);
        delete changesLoading[repoId];
      }
    }
  }

  async function commit(repoId: string, message: string, amend = false): Promise<ActionResult> {
    if (busy[repoId]) return { ok: false, code: "BUSY", message: "Another action is already running for this repo." };
    busy[repoId] = "commit";
    try {
      const result = await api.commit(repoId, message, amend);
      if (result.ok) onHistoryChanged(repoId);
      return result;
    } catch (e) {
      return asResult(e);
    } finally {
      delete busy[repoId];
    }
  }

  // Per-file staging: commit ONLY `paths` (the rest stay pending), so the changes tree must be
  // reloaded afterward to drop the committed files (unlike a full commit, which empties the tree
  // and hides the section). The SSE status push refreshes the dirty count; this refreshes the list.
  async function commitSelected(repoId: string, message: string, paths: string[]): Promise<ActionResult> {
    if (busy[repoId]) return { ok: false, code: "BUSY", message: "Another action is already running for this repo." };
    busy[repoId] = "commit";
    try {
      const result = await api.commitSelected(repoId, message, paths);
      if (result.ok) onHistoryChanged(repoId);
      return result;
    } catch (e) {
      return asResult(e);
    } finally {
      // ALWAYS refresh the changed-file list — not just on success. On a PLAN_STALE failure (a
      // selected file vanished out-of-band) this re-syncs the tree so RepoCard's prune watch drops
      // the now-stale path from the selection, instead of leaving it checked in a retry loop.
      await loadChanges(repoId);
      delete busy[repoId];
    }
  }

  /** Assign (or clear) a repo's identity (optimistic; rolls back on failure). */
  async function assignIdentity(repoId: string, identityId: string | null): Promise<void> {
    const prev = findRepo(repoId)?.identityId ?? null;
    patchRepo(repoId, { identityId }); // optimistic
    try {
      await api.assignIdentity(repoId, identityId);
    } catch (e) {
      patchRepo(repoId, { identityId: prev }); // roll back
      throw e;
    }
  }

  /** Pin (or clear) the GitHub account a repo syncs as (optimistic; rolls back on failure). The
   *  repo_account_changed SSE echo keeps every device in step on success. */
  async function assignRepoAccount(repoId: string, host: string | null, login: string | null): Promise<void> {
    const found = findRepo(repoId);
    const prevHost = found?.syncAccountHost ?? null;
    const prevLogin = found?.syncAccountLogin ?? null;
    patchRepo(repoId, {
      syncAccountHost: login ? host || "github.com" : null,
      syncAccountLogin: login,
    }); // optimistic
    try {
      await api.assignRepoAccount(repoId, host, login);
    } catch (e) {
      patchRepo(repoId, { syncAccountHost: prevHost, syncAccountLogin: prevLogin }); // roll back
      throw e;
    }
  }

  /** Set/clear a repo's display label (optimistic; rolls back on failure). Never touches the
   *  folder on disk — `repo.name` stays the real basename. */
  async function renameRepo(repoId: string, displayName: string | null): Promise<void> {
    const prev = findRepo(repoId)?.displayName ?? null;
    const next = displayName?.trim() ? displayName.trim() : null;
    patchRepo(repoId, { displayName: next }); // optimistic
    try {
      await api.renameRepo(repoId, next);
    } catch (e) {
      patchRepo(repoId, { displayName: prev }); // roll back
      throw e;
    }
  }

  /**
   * Remove a repo from RepoYeti's index. Index-only: the folder and its git history are never
   * touched. Drops the card immediately; the daemon's `repo_removed` SSE echo keeps other
   * devices in step. Returns the removed repo so the caller can offer an Undo.
   */
  async function removeRepo(repoId: string): Promise<Repo | null> {
    const removed = findRepo(repoId) ?? null;
    repos.value = repos.value.filter((r) => r.id !== repoId); // optimistic
    try {
      await api.removeRepo(repoId);
      return removed;
    } catch (e) {
      if (removed) repos.value.push(removed); // roll back
      throw e;
    }
  }

  /** Undo a removal: drop the tombstone and re-index the path if it's still on disk. */
  async function restoreRemovedRepo(absPath: string): Promise<void> {
    const r = await api.restoreIgnoredPath(absPath);
    if (r.repo) upsertRepo(r.repo);
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

  /** Release changed-file state when a repository is removed or leaves a shared scope. */
  function clearRepoCache(repoId: string): void {
    changesCacheLru.delete(repoId);
    changesRequests.delete(repoId);
    repoLookup.delete(repoId);
    // A repo can be removed (another device, a scan root going away) while it's still sitting in
    // the insert buffer, never having reached `repos.value` — drop it here too, or the next flush
    // would resurrect a card that was just removed.
    pendingInserts.delete(repoId);
    delete changesByRepo[repoId];
    delete changesLoading[repoId];
    delete changesMeta[repoId];
    delete busy[repoId];
  }

  /** Drop stale cache keys after a full list refresh (covers removals missed while SSE was down). */
  function pruneRepoCache(liveRepoIds: ReadonlySet<string>): void {
    const cachedIds = new Set([
      ...Object.keys(changesByRepo),
      ...Object.keys(changesLoading),
      ...Object.keys(changesMeta),
      ...changesRequests.keys(),
      ...changesCacheLru.keys(),
    ]);
    for (const repoId of cachedIds) {
      if (!liveRepoIds.has(repoId)) clearRepoCache(repoId);
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
    hasManualOrder,
    sortMode,
    setSortMode,
    visibleRepos,
    pinnedRepos,
    starredRepos,
    otherRepos,
    needsAttentionRepos,
    visibleAttentionRepos,
    dismissAttention,
    getRepoStatus,
    hasRepo,
    patchRepo,
    upsertRepo,
    queueRepoAdded,
    flushPendingRepoInserts,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    renameRepo,
    removeRepo,
    restoreRemovedRepo,
    setHidden,
    setPinned,
    setStarred,
    setAutoCommit,
    clearRepoCache,
    pruneRepoCache,
  };
}
