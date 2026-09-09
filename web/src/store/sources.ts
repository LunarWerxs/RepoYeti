import { ref, type Ref } from "vue";
import { api } from "../api";
import type { BuzzCommunity, BuzzPreflight, FetchAllJob, LoreServer, Repo } from "../types";

/**
 * Scan roots / registered Lore servers / bulk fetch / add-or-clone-repo / drag-reorder /
 * sign-out-everywhere. The five scan-progress refs are owned by the barrel (the `connect()`
 * SSE handler also writes them directly from `scan_*` events), so they're passed in here.
 */
export function useSources(
  repos: Ref<Repo[]>,
  /** Owned by store/runtime-status.ts (it is a daemon setting like any other, synchronised from
   *  /api/status and `settings_changed` there); borrowed here for the optimistic toggle below. */
  loreServersEnabled: Ref<boolean>,
  scanning: Ref<boolean>,
  scanFound: Ref<number>,
  scanNew: Ref<number>,
  scanDone: Ref<boolean>,
  lastScanCancelled: Ref<boolean>,
  scanCancelRequested: Ref<boolean>,
  upsertRepo: (repo: Repo) => void,
) {
  // Scan roots (discovery directories) — lazily loaded when Settings opens.
  const roots = ref<string[]>([]);
  // Registered Lore servers — lazily loaded when Settings / Add-repo opens.
  const servers = ref<LoreServer[]>([]);
  // Experimental Buzz is opt-in and stays false until its owner-only config is loaded.
  const buzzEnabled = ref(false);
  const buzzCommunities = ref<BuzzCommunity[]>([]);
  // ── bulk "fetch all", as a job ────────────────────────────────────────────────
  // It used to be one boolean around one long await: the phone saw a spinner, no idea how many
  // repositories there were or which one was stalling, and no way to stop it (1.0 audit item 24).
  // These mirror the scan's shape: optimistic locally, corrected by the fetch_all_* SSE events,
  // and reconciled against GET /api/repos/fetch-all after a dropped connection.
  const fetchingAll = ref(false);
  /** Which run the counters below belong to, so a late event for a previous one is ignorable. */
  const fetchAllJobId = ref<string | null>(null);
  const fetchAllTotal = ref(0);
  const fetchAllDone = ref(0);
  const fetchAllOk = ref(0);
  const fetchAllFailed = ref(0);
  /** The repository being fetched right now, for the "Fetching <name>…" line. */
  const fetchAllCurrent = ref<string | null>(null);
  /** The owner asked to stop and the daemon has not confirmed yet: the "Stopping…" state. */
  const fetchAllCancelRequested = ref(false);
  /** The last finished run, which is what the summary toast is built from. */
  const fetchAllSummary = ref<FetchAllJob | null>(null);

  // ── scan roots / bulk fetch / sign-out-everywhere ────────────────────────────
  async function loadRoots(): Promise<void> {
    roots.value = await api.roots();
  }
  /** Add a scan root; repos under it stream in live via the `repo_added` SSE event. */
  async function addScanRoot(path: string): Promise<void> {
    const r = await api.addRoot(path);
    roots.value = r.roots;
  }
  /** Remove a scan root; its auto-discovered repos disappear via `repo_removed`. */
  async function removeScanRoot(path: string): Promise<number> {
    const r = await api.removeRoot(path);
    roots.value = r.roots;
    return r.removed;
  }

  /** Start a scan — the whole machine by default, or a single folder via `{ path }`. Progress +
   *  results arrive over the scan_* SSE events; we flip `scanning` on optimistically so the modal
   *  reacts before the first frame. */
  async function startScan(opts?: { path?: string }): Promise<void> {
    scanning.value = true;
    scanDone.value = false;
    lastScanCancelled.value = false;
    scanCancelRequested.value = false;
    scanFound.value = 0;
    scanNew.value = 0;
    try {
      await api.startScan(opts);
    } catch (e) {
      scanning.value = false; // the request itself failed — never entered the running state
      throw e;
    }
  }
  /**
   * Stop the in-flight scan (the modal's X). `scanCancelRequested` flips on optimistically so the
   * UI can show "Stopping…" while it waits for the daemon's `scan_cancelled` SSE event to settle
   * `lastScanCancelled`; if the request itself fails (a disconnected phone, a dropped tunnel), roll
   * it back and rethrow so the caller can toast instead of leaving the control stuck disabled.
   */
  async function cancelScan(): Promise<void> {
    scanCancelRequested.value = true;
    try {
      await api.cancelScan();
    } catch (e) {
      scanCancelRequested.value = false;
      throw e;
    }
  }

  /**
   * Reconcile scan state after an SSE (re)connect. The daemon has no event replay, so a
   * `scan_done`/`scan_cancelled` broadcast fired while this client was offline (a phone that
   * backgrounded, a flaky network) is lost for good — without this, `scanning` stays true forever
   * and the modal spins on a scan that already finished. Only settle the UI when the daemon
   * CONFIRMS the job is gone; a rejected status check leaves everything as-is rather than guessing
   * an unknown server-side job has stopped.
   */
  async function reconcileScan(): Promise<void> {
    if (!scanning.value) return;
    let status: { running: boolean };
    try {
      status = await api.scanStatus();
    } catch {
      return; // unknown — never mark it stopped on a failed check
    }
    if (status.running) return; // still running — leave everything as-is
    scanning.value = false;
    scanDone.value = true;
    lastScanCancelled.value = scanCancelRequested.value;
    scanCancelRequested.value = false;
  }
  // ── lore servers ─────────────────────────────────────────────────────────────
  async function loadServers(): Promise<void> {
    servers.value = await api.servers();
  }
  async function addServer(url: string, name?: string): Promise<LoreServer> {
    const r = await api.addServer(url, name);
    servers.value = r.servers;
    return r.server;
  }
  async function removeServer(id: string): Promise<void> {
    const r = await api.deleteServer(id);
    servers.value = r.servers;
  }
  /** Toggle the Lore-servers section's expanded/collapsed state (optimistic; rolls back). */
  async function setLoreServersEnabled(enabled: boolean): Promise<void> {
    loreServersEnabled.value = enabled;
    try {
      await api.setLoreServersEnabled(enabled);
    } catch (e) {
      loreServersEnabled.value = !enabled; // roll back
      throw e;
    }
  }
  /** Clone a repo from a registered Lore server into a folder under a scan root. */
  async function cloneFromServer(input: { url: string; parentPath: string; name?: string }): Promise<Repo> {
    const repo = await api.cloneFromServer(input);
    upsertRepo(repo);
    return repo;
  }

  // ── Buzz Git compatibility ──────────────────────────────────────────────────
  async function loadBuzzConfig(): Promise<void> {
    const config = await api.buzzConfig();
    buzzEnabled.value = config.enabled;
    buzzCommunities.value = config.communities;
  }
  async function setBuzzEnabled(enabled: boolean): Promise<void> {
    const previous = buzzEnabled.value;
    buzzEnabled.value = enabled;
    try {
      const result = await api.setBuzzEnabled(enabled);
      buzzEnabled.value = result.config.enabled;
      buzzCommunities.value = result.config.communities;
    } catch (error) {
      buzzEnabled.value = previous;
      throw error;
    }
  }
  async function addBuzzCommunity(input: {
    name?: string;
    url: string;
    gitUrl?: string;
  }): Promise<BuzzCommunity> {
    const result = await api.addBuzzCommunity(input);
    buzzEnabled.value = result.config.enabled;
    buzzCommunities.value = result.config.communities;
    return result.community;
  }
  async function removeBuzzCommunity(id: string): Promise<void> {
    const result = await api.deleteBuzzCommunity(id);
    buzzEnabled.value = result.config.enabled;
    buzzCommunities.value = result.config.communities;
  }
  async function runBuzzPreflight(communityId?: string): Promise<BuzzPreflight> {
    return api.buzzPreflight(communityId);
  }

  /** Adopt a run's counters, whether they arrived over SSE or from the status route. */
  function applyFetchAllJob(job: FetchAllJob): void {
    fetchAllJobId.value = job.jobId;
    fetchAllTotal.value = job.total;
    fetchAllDone.value = job.done;
    fetchAllOk.value = job.ok;
    fetchAllFailed.value = job.failed.length;
    fetchAllCurrent.value = job.current;
    fetchingAll.value = job.running;
    if (!job.running) {
      fetchAllSummary.value = job;
      fetchAllCancelRequested.value = false;
    }
  }

  /**
   * Start a fetch of every repo with a remote. Optimistic like startScan: the running state flips
   * on before the request returns so the header reacts on the first frame, and rolls back only if
   * the START itself failed — a sweep that started and then failed reports over SSE.
   */
  async function startFetchAll(): Promise<void> {
    fetchingAll.value = true;
    fetchAllCancelRequested.value = false;
    fetchAllSummary.value = null;
    fetchAllCurrent.value = null;
    fetchAllDone.value = 0;
    fetchAllOk.value = 0;
    fetchAllFailed.value = 0;
    try {
      const r = await api.startFetchAll();
      if (r.job) applyFetchAllJob(r.job);
      // `started: false` means one was already running; its own events drive the counters.
      fetchingAll.value = r.running || r.started;
    } catch (e) {
      fetchingAll.value = false; // the request itself failed: it never entered the running state
      throw e;
    }
  }

  /**
   * Stop the in-flight sweep. `fetchAllCancelRequested` flips on optimistically so the control can
   * say "Stopping…" rather than looking inert while the request is in flight (or, worse, forever,
   * if it never reaches the daemon); rolled back and rethrown if the request itself fails.
   */
  async function cancelFetchAll(): Promise<void> {
    fetchAllCancelRequested.value = true;
    try {
      await api.cancelFetchAll();
    } catch (e) {
      fetchAllCancelRequested.value = false;
      throw e;
    }
  }

  /**
   * Apply one `fetch_all_*` broadcast.
   *
   * Owned here, with the state it drives, so the root store's event table stays a dispatch table
   * rather than becoming a second place these counters are written — which is exactly the drift
   * the runtime-status table (store/runtime-status.ts) was extracted to stop.
   *
   * The progress heartbeat carries a failure COUNT and the terminal event carries the failure
   * LIST; both are handled, and neither is trusted from a run we are not watching.
   */
  function applyFetchAllEvent(name: string, payload: unknown): void {
    if (payload === null || typeof payload !== "object") return;
    const p = payload as {
      jobId?: string;
      total?: number;
      done?: number;
      ok?: number;
      failed?: unknown;
      skipped?: number;
      current?: string | null;
      cancelled?: boolean;
      error?: string;
    };
    if (name === "fetch_all_started") {
      fetchAllJobId.value = p.jobId ?? null;
      fetchAllTotal.value = p.total ?? 0;
      fetchAllDone.value = 0;
      fetchAllOk.value = 0;
      fetchAllFailed.value = 0;
      fetchAllCurrent.value = null;
      fetchAllSummary.value = null;
      fetchingAll.value = true;
      return;
    }
    // A late event for a run this client is not watching must not rewrite the current one's
    // counters. Only possible right after a reconnect, and exactly when it would mislead most.
    if (fetchAllJobId.value && p.jobId && p.jobId !== fetchAllJobId.value) return;
    if (name === "fetch_all_progress") {
      fetchAllCurrent.value = p.current ?? null;
      fetchAllDone.value = p.done ?? fetchAllDone.value;
      fetchAllTotal.value = p.total ?? fetchAllTotal.value;
      fetchAllOk.value = p.ok ?? fetchAllOk.value;
      fetchAllFailed.value = typeof p.failed === "number" ? p.failed : fetchAllFailed.value;
      fetchingAll.value = true;
      return;
    }
    // Terminal: fetch_all_done or fetch_all_cancelled. Both end the run; `cancelled` says which.
    const failed = (Array.isArray(p.failed) ? p.failed : []) as FetchAllJob["failed"];
    const total = p.total ?? fetchAllTotal.value;
    const skipped = p.skipped ?? 0;
    fetchAllSummary.value = {
      jobId: p.jobId ?? fetchAllJobId.value ?? "",
      total,
      ok: p.ok ?? fetchAllOk.value,
      failed,
      skipped,
      cancelled: p.cancelled === true,
      done: total - skipped,
      current: null,
      running: false,
      ...(p.error ? { error: p.error } : {}),
    };
    fetchAllTotal.value = total;
    fetchAllDone.value = total - skipped;
    fetchAllOk.value = p.ok ?? fetchAllOk.value;
    fetchAllFailed.value = failed.length;
    fetchAllCurrent.value = null;
    fetchAllCancelRequested.value = false;
    fetchingAll.value = false;
  }

  /**
   * Reconcile after an SSE (re)connect, the same rule as reconcileScan: only settle on an answer
   * the daemon actually gave. A failed status check changes nothing, because guessing that an
   * unknown server-side job has stopped is how a spinner lies in the other direction.
   */
  async function reconcileFetchAll(): Promise<void> {
    let status: { running: boolean; job: FetchAllJob | null };
    try {
      status = await api.fetchAllStatus();
    } catch {
      return;
    }
    // A run IS in flight: adopt it, whether or not this client knew about it (another tab, or
    // this one before it reloaded).
    if (status.running && status.job) {
      applyFetchAllJob(status.job);
      return;
    }
    // Nothing running, and this client was not watching one: leave everything alone. The daemon
    // keeps the LAST run after it ends, and adopting it here would pop a summary toast for a
    // sweep that finished hours ago every time a phone reconnected.
    if (!fetchingAll.value) return;
    if (status.job) {
      applyFetchAllJob(status.job);
      return;
    }
    fetchingAll.value = false;
    fetchAllCancelRequested.value = false;
  }

  /** Remove every repo entry whose local path no longer exists on disk. The victims drop from
   *  the list live via `repo_removed` SSE (mirrors removeScanRoot). Returns how many were
   *  removed, for the caller to toast. */
  async function cleanupMissingRepos(): Promise<number> {
    const r = await api.cleanupMissingRepos();
    return r.removed;
  }
  async function shutdown(): Promise<void> {
    await api.shutdown();
  }
  /** Sign out on every device (rotates the daemon's signing key). */
  async function logoutAll(): Promise<void> {
    await api.logoutAll();
  }

  async function addRepo(mode: "register" | "create", path: string): Promise<Repo> {
    const repo = mode === "register" ? await api.registerRepo(path) : await api.createRepo(path);
    upsertRepo(repo);
    return repo;
  }

  /** Clone a remote into a folder under a scan root; the new repo also arrives via SSE. */
  async function cloneRepo(input: {
    url: string;
    parentPath: string;
    name?: string;
    identityId?: string | null;
  }): Promise<Repo> {
    const repo = await api.cloneRepo(input);
    upsertRepo(repo);
    return repo;
  }

  /**
   * Persist a drag-to-reorder. First reorder the local `repos` to match so a later
   * rebuild — triggered by any pin/star/hide toggle or live SSE patch — re-derives the
   * order the user just dragged into place, instead of snapping back to the server's
   * pre-drag sort_order. The API call is then best-effort. `orderedIds` is the full set
   * (the section lists plus the hidden tail), so every repo gets a position.
   */
  async function persistRepoOrder(orderedIds: string[]): Promise<void> {
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    repos.value = [...repos.value].sort(
      (a, b) =>
        (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    // Mirror what setRepoOrder() is about to write server-side: every listed repo takes its
    // position, everything else goes back to NULL. Without this the in-memory sortOrder stays at
    // its pre-drag value and the next live-discovered repo is slotted against a stale order.
    for (const repo of repos.value) repo.sortOrder = pos.get(repo.id) ?? null;
    try {
      await api.reorderRepos(orderedIds);
    } catch {
      /* order is a nicety — never block the UI on it */
    }
  }

  /**
   * Drop the drag-persisted order entirely, so every repo falls back to the server's
   * name ordering (and stays there as new ones are discovered). Reloads the list rather than
   * re-sorting locally, so the client order is exactly what a fresh boot would show.
   */
  async function resetRepoOrder(): Promise<void> {
    await api.reorderRepos([]);
    repos.value = await api.listRepos();
  }

  return {
    roots,
    servers,
    buzzEnabled,
    buzzCommunities,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    startScan,
    cancelScan,
    reconcileScan,
    loadServers,
    addServer,
    removeServer,
    setLoreServersEnabled,
    cloneFromServer,
    loadBuzzConfig,
    setBuzzEnabled,
    addBuzzCommunity,
    removeBuzzCommunity,
    runBuzzPreflight,
    fetchingAll,
    fetchAllJobId,
    fetchAllTotal,
    fetchAllDone,
    fetchAllOk,
    fetchAllFailed,
    fetchAllCurrent,
    fetchAllCancelRequested,
    fetchAllSummary,
    startFetchAll,
    cancelFetchAll,
    reconcileFetchAll,
    applyFetchAllEvent,
    cleanupMissingRepos,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
    resetRepoOrder,
  };
}
