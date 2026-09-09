import { defineStore } from "pinia";
import { ref, reactive, computed, watch, type Ref, type ComputedRef } from "vue";
import { useEventSource } from "@vueuse/core";
import { api, ApiError } from "../api";
import type {
  ActionName,
  ActionResult,
  PendingApproval,
  Repo,
  CollaborationSnapshot,
  UpdateApplyResult,
  UpdateStatus,
} from "../types";
import { useSelfUpdate } from "@/lib/useSelfUpdate";
import { armSelfHeal, disarmSelfHeal } from "@/lib/relay-home";
import { dismissViewerForRepo } from "@/lib/file-viewer";
import { useRepoActions, type StatusKey } from "./repo";
import { useRuntimeStatus, type RuntimeStatusStore } from "./runtime-status";
import { useAi } from "./ai";
import { useGitOps } from "./git-ops";
import { useSources } from "./sources";
import { useIdentities } from "./identities";
import { useAutoCommitIncidents } from "./incidents";
import { useOperationalErrors } from "./errors";
import {
  useSettings,
  type BehindRepo,
  type SyncedRepo,
  type AutoCommittedRepo,
  type AutoCommitBlockedRepo,
} from "./settings";

export type { StatusKey };

export const useStore = defineStore("repoyeti", () => {
  const repos = ref<Repo[]>([]);
  /** Peer working-tree presence, decrypted by the daemon. */
  const collaborationSnapshots = ref<CollaborationSnapshot[]>([]);
  const loading = ref(true);
  const connected = ref(false);
  /**
   * An UNATTENDED auto-update is mid-flight on the daemon (see src/auto-update.ts).
   *
   * Both events were already in the SSE subscription list and neither had a handler, so the
   * payloads arrived and were dropped on the floor. That matters most for exactly the setup this
   * was reported from — auto-update on, watched from a phone — where the daemon can go away for
   * minutes with the dashboard showing nothing at all, then silently reconnect on a new build.
   * `autoUpdateRestarting` stays true until the reconnect clears it: the daemon is on its way down
   * at that point, so the stream drop that follows is expected, not a fault to report.
   */
  const autoUpdateApplying = ref(false);
  const autoUpdateRestarting = ref(false);
  const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate } =
    useSelfUpdate<UpdateStatus, UpdateApplyResult>(api);

  /** repoId → the action currently in flight (drives per-button loading state). */
  const busy = reactive<Record<string, ActionName | undefined>>({});

  /**
   * Monotonic per-repo signal for lazily-mounted History views. Mutations bump only when an
   * operation known to affect commits or refs succeeds, so an open History can refresh without
   * polling and without reacting to every ordinary status/SSE update.
   */
  const historyRevisionByRepo = reactive<Record<string, number>>({});
  function bumpHistoryRevision(repoId: string): void {
    historyRevisionByRepo[repoId] = (historyRevisionByRepo[repoId] ?? 0) + 1;
  }

  /**
   * A repo watcher also sees commits/checkouts made by Codex, a terminal, or another Git client.
   * Its generic state event has no explicit "history changed" bit, so use only fields that can
   * reveal a commit/ref transition. Ignore initial hydration and timestamp/diff-only churn.
   */
  function isHistoryRelevantStatusChange(
    previous: Repo["status"],
    next: Repo["status"],
  ): boolean {
    if (!previous || !next) return false;
    return (
      previous.branch !== next.branch ||
      previous.detached !== next.detached ||
      (previous.headOid ?? null) !== (next.headOid ?? null) ||
      (previous.upstreamOid ?? null) !== (next.upstreamOid ?? null) ||
      (previous.historyRefsHash ?? null) !== (next.historyRefsHash ?? null) ||
      previous.ahead !== next.ahead ||
      previous.behind !== next.behind ||
      next.dirty < previous.dirty
    );
  }

  // Every daemon-owned runtime field, and the one table that says how each is filled from
  // GET /api/status (a snapshot: absent means "reset to the daemon's default") and from the
  // `settings_changed` / `daemon_status` broadcasts (patches: absent means "leave it alone").
  // Kept out of this file entirely so adding a setting is one table entry rather than four
  // coordinated edits in four distant blocks. See store/runtime-status.ts.
  const runtime = useRuntimeStatus();
  const {
    tunnelUrl,
    tunnelActive,
    tunnelConfig,
    relayConfig,
    relayUrl,
    relayAnnounced,
    relayError,
    mode,
    serverVersion,
    diffStatsEnabled,
    changesStatDisplay,
    changesCharsEnabled,
    remoteEditing,
    remoteBrowse,
    diffPatchBytes,
    diffPatchEnabled,
    syncCheckEnabled,
    syncIntervalSecs,
    keepInSync,
    autoCommit,
    autoCommitMode,
    autoCommitIntervalSecs,
    autoCommitAt,
    autoCommitPull,
    autoCommitPush,
    autoCommitAiFallback,
    autoUpdate,
    updateNotify,
    autoScan,
    portableMode,
    hideTrayIcon,
    mcpApprovalGate,
    mcpApprovalTimeoutSecs,
    mcpAutoDeny,
    mcpAutoApprove,
    mcpAutoApproveTimeoutSecs,
    defaultEditor,
    contentSearchMin,
    loreServersEnabled,
  } = runtime;

  // Live scan lifecycle, driven entirely by the scan_* SSE events (see connect()) and by
  // sources.ts's startScan()/cancelScan().
  const scanning = ref(false);
  const scanFound = ref(0); // repos seen so far this scan
  const scanNew = ref(0); // of those, how many were not previously known
  const scanDone = ref(false); // a scan has finished (or was stopped) → show the summary
  const lastScanCancelled = ref(false); // the finished scan ended via the Stop (X) control
  // The phone asked the daemon to stop a scan and is waiting on confirmation — distinct from
  // lastScanCancelled, which means the daemon already CONFIRMED the stop. Drives the "Stopping…"
  // state on the cancel control so it doesn't look inert while the request is in flight (or,
  // worse, forever, if the stop request never reaches the daemon at all).
  const scanCancelRequested = ref(false);
  // The genuinely-new repos this scan turned up, collected from the `repo_added` events it emits.
  // The daemon indexes as it walks, so this is a review list for what already happened — the modal
  // uses it to name every find and to offer removing the ones the owner didn't want.
  const scanNewRepos = ref<Array<{ id: string; name: string; absPath: string }>>([]);
  // True while a scan is running, so `repo_added` knows to record its repos above. Discovery also
  // fires `repo_added` at boot and from watchers; only a scan's finds belong in the review list.
  const collectingScanRepos = ref(false);
  // The Scan modal was reached from "Add a repository", so closing it should hand back rather than
  // dropping the owner on the dashboard with no route to the flow they were in.
  const scanReturnToAdd = ref(false);

  /** Take a repo off the post-scan review list (it was removed, or the owner kept it). */
  function dropScanNewRepo(repoId: string): void {
    scanNewRepos.value = scanNewRepos.value.filter((r) => r.id !== repoId);
  }

  /** Normalise any thrown ApiError into the structured {ok,code,message} the UI toasts. */
  function asResult(e: unknown): ActionResult {
    if (e instanceof ApiError) {
      // A 401 here means the daemon revoked/expired this session mid-flight: every action that
      // flows through asResult only ever runs from an already-authenticated dashboard (AppShell
      // gates loadAll()/the whole UI behind the sign-in screen), so this can't be a pre-auth 401.
      // Flip the gate back on immediately instead of leaving the owner behind a generic toast.
      if (e.status === 401) handleUnauthorized();
      return { ok: false, code: e.code ?? "ERROR", message: e.message };
    }
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }

  const {
    changesByRepo,
    changesLoading,
    changesMeta,
    changesShowAll,
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
    setRefStateHook,
    applyActionStatus,
    upsertRepo,
    queueRepoAdded,
    flushPendingRepoInserts,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    renameRepo,
    removeRepo: removeRepoFromList,
    restoreRemovedRepo,
    setHidden,
    setPinned,
    setStarred,
    setAutoCommit: setRepoAutoCommit,
    clearRepoCache: clearRepoViewCache,
    pruneRepoCache: pruneRepoViewCache,
  } = useRepoActions(repos, busy, asResult, bumpHistoryRevision);

  const {
    aiSettings,
    aiCatalog,
    aiReady,
    aiEnabled,
    aiUsable,
    aiCommitEnabled,
    aiConflictEnabled,
    loadAiSettings,
    loadAiAvailability,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setCommitEnabled,
    setConflictEnabled,
    setStyle,
    setDiffDetail,
    removeProvider,
    keyPools,
    loadKeyPool,
    setKeyPool,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
    listConflicts,
    readConflict,
    resolveConflict,
    applyConflict,
  } = useAi(busy, loadChanges, asResult, bumpHistoryRevision, applyActionStatus);

  const {
    incidents: autoCommitIncidents,
    unacked: autoCommitIncidentsUnacked,
    incidentsReady: autoCommitIncidentsReady,
    incidentsLoading: autoCommitIncidentsLoading,
    loadAutoCommitIncidents,
    ackAutoCommitIncident,
  } = useAutoCommitIncidents();

  const {
    errors: operationalErrors,
    errorsReady: operationalErrorsReady,
    errorsLoading: operationalErrorsLoading,
    loadOperationalErrors,
    setOperationalErrorMuted,
    dismissOperationalError,
  } = useOperationalErrors();

  const {
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
    clearRepoCache: clearGitOpsCache,
    pruneRepoCache: pruneGitOpsCache,
  } = useGitOps(
    loadChanges,
    asResult,
    hasRepo,
    bumpHistoryRevision,
    applyActionStatus,
  );

  // Close the loop the two modules cannot close themselves: repo.ts owns the one funnel every
  // status update passes through, git-ops owns the caches derived from refs, and git-ops is built
  // second because it needs loadChanges. So the hook is wired here, once both exist. Without it a
  // branch checked out or deleted outside RepoYeti left the selector stale until a full page
  // reload (issue #22).
  setRefStateHook(reloadRefCaches);

  /** All large per-repo client caches share the lifecycle of the dashboard card. */
  function clearRepoCaches(repoId: string): void {
    clearRepoViewCache(repoId);
    clearGitOpsCache(repoId);
    delete busy[repoId];
    delete historyRevisionByRepo[repoId];
  }

  function pruneRepoCaches(liveRepoIds: ReadonlySet<string>): void {
    pruneRepoViewCache(liveRepoIds);
    pruneGitOpsCache(liveRepoIds);
    for (const repoId of Object.keys(busy)) {
      if (!liveRepoIds.has(repoId)) delete busy[repoId];
    }
    for (const repoId of Object.keys(historyRevisionByRepo)) {
      if (!liveRepoIds.has(repoId)) delete historyRevisionByRepo[repoId];
    }
  }

  /**
   * Keep the optimistic removal owned by useRepoActions, then release every lazily-loaded view
   * only after the daemon accepts it. A failed removal rolls the card back with its state intact.
   */
  async function removeRepo(repoId: string): Promise<Repo | null> {
    const removed = await removeRepoFromList(repoId);
    clearRepoCaches(repoId);
    return removed;
  }

  const {
    roots,
    servers,
    buzzEnabled,
    buzzCommunities,
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
    cleanupMissingRepos,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
    resetRepoOrder,
  } = useSources(
    repos,
    loreServersEnabled,
    scanning,
    scanFound,
    scanNew,
    scanDone,
    lastScanCancelled,
    scanCancelRequested,
    upsertRepo,
  );

  const {
    identities,
    detectedIdentities,
    dismissedDetectedIdentities,
    detectedIdentitiesLoading,
    detectedIdentitiesReady,
    identityById,
    identitiesRelevant,
    identityUiForced,
    setIdentityUiForced,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
    dismissDetectedIdentity,
    restoreDetectedIdentity,
    restoreDetectedIdentities,
    identityRules,
    identityRulesReady,
    loadIdentityRules,
    setIdentityRules,
    ghAvailable,
    ghAccounts,
    gitCommitIdentity,
    accountsReady,
    accountsLoading,
    switchingAccount,
    activeAccount,
    loadAccounts,
    switchAccount,
    setAccountIdentity,
  } = useIdentities(repos);

  const {
    authReady,
    authEnforced,
    authenticated,
    owner,
    ownerPicture,
    ownerClaimed,
    canContinueLocal,
    localBypass,
    shareViewer,
    loadAuth,
    handleUnauthorized,
    continueLocal,
    setMode,
    setTunnel,
    setRelay,
    logout,
    leaveShare,
    setDiffStats,
    setChangesStatDisplay,
    setChangesChars,
    setRemoteEditing,
    setRemoteBrowse,
    setDiffPatchBytes,
    setDiffPatchEnabled,
    setSyncCheck,
    setSyncInterval,
    setKeepInSync,
    setAutoCommit,
    setAutoUpdate,
    setUpdateNotify,
    setAutoCommitMode,
    setAutoCommitInterval,
    setAutoCommitAt,
    setAutoCommitPull,
    setAutoCommitPush,
    setAutoCommitAiFallback,
    setAutoScan,
    setPortableMode,
    openPortableWindow,
    setHideTrayIcon,
    setMcpApprovalGate,
    setMcpApprovalTimeoutSecs,
    setMcpAutoDeny,
    setMcpAutoApprove,
    setMcpAutoApproveTimeoutSecs,
    editorsCatalog,
    editorsPlatform,
    effectiveEditor,
    editorsLoaded,
    editorsLoading,
    loadEditors,
    setDefaultEditor,
    openInEditor,
    pendingApprovals,
    approvalBusy,
    loadApprovals,
    addPendingApproval,
    removePendingApproval,
    approveCall,
    denyCall,
    syncStatus,
    syncLoading,
    syncActionBusy,
    syncError,
    loadSyncStatus,
    enableSync,
    disableSync,
    pushSync,
    pullSync,
    pushAppearance,
    desktopNotify,
    notifyPermission,
    enableDesktopNotify,
    disableDesktopNotify,
    notifications,
    unreadCount,
    markNotificationsRead,
    dismissNotification,
    clearNotifications,
    scanOpen,
    addRepoOpen,
    updatePromptOpen,
    updateBlockedReason,
    notifyUpdateAvailable,
    clearUpdateNotification,
    pullBehind,
    reconcileBehindNotification,
    notifyBehind,
    notifySynced,
    notifyAutoCommitted,
    notifyAutoCommitBlocked,
    notifyNewProjects,
    notifyAiKeyInvalid,
  } = useSettings({
    mode,
    tunnelActive,
    tunnelUrl,
    tunnelConfig,
    relayConfig,
    relayUrl,
    relayAnnounced,
    relayError,
    diffStatsEnabled,
    changesStatDisplay,
    changesCharsEnabled,
    remoteEditing,
    remoteBrowse,
    diffPatchBytes,
    diffPatchEnabled,
    syncCheckEnabled,
    syncIntervalSecs,
    keepInSync,
    autoCommit,
    autoCommitMode,
    autoCommitIntervalSecs,
    autoCommitAt,
    autoCommitPull,
    autoCommitPush,
    autoCommitAiFallback,
    autoUpdate,
    updateNotify,
    autoScan,
    portableMode,
    hideTrayIcon,
    mcpApprovalGate,
    mcpApprovalTimeoutSecs,
    mcpAutoDeny,
    mcpAutoApprove,
    mcpAutoApproveTimeoutSecs,
    defaultEditor,
    pullRepo: (repoId) => doAction(repoId, "pull"),
  });

  /**
   * Open the update offer from wherever the update was NOTICED — its bell entry, or the Settings
   * version badge. One entry point, because two callers preparing the same dialog is how they
   * start preparing it differently.
   *
   * The blocked reason is re-derived from `/api/updates` (the same status the badge is drawn
   * from) instead of being left at whatever the last `update_available` announcement set. That
   * payload can be hours old: a tree that has been committed since would otherwise open a dialog
   * still refusing to install, and one dirtied since would offer an install that then fails. Only
   * when there is no status at all is the announcement's reason kept — it beats saying nothing.
   */
  function openUpdatePrompt(): void {
    const status = updateStatus.value;
    if (status) updateBlockedReason.value = status.canApply ? null : status.reason;
    updatePromptOpen.value = true;
  }

  /**
   * "Restart to finish" — relaunch the daemon so a manually-installed update takes over (issue #23).
   *
   * The flag is set from the HTTP answer rather than left to the daemon's `auto_update_restarting`
   * broadcast, because the daemon starts going down the moment it answers: that event and the SSE
   * drop race each other, and the one client that must not be left staring at an unchanged badge is
   * the one that just tapped it. The broadcast still does the job for every OTHER connected
   * dashboard. Only a 2xx gets here — a refusal (a git op running, an agent awaiting approval)
   * throws, so a daemon that is staying put never renders as "Restarting…". The reconnect clears
   * the flag (see the `status` watch below).
   */
  async function restartDaemon(): Promise<void> {
    await api.restartDaemon();
    autoUpdateRestarting.value = true;
  }

  /**
   * This browser is holding a share link rather than owning this daemon.
   *
   * Everything a guest can't do is enforced by the daemon (src/share/policy.ts) — these two flags
   * exist so the UI doesn't offer buttons that would only 403. Never treat them as the security
   * boundary; a guest who edits `isGuest` in devtools gets a prettier dashboard and exactly zero
   * extra access.
   */
  const isGuest = computed(() => shareViewer.value !== null);
  /**
   * May this viewer trigger the sync loop (fetch/pull/push/stage/commit/Smart Commit)?
   *
   * True for the owner — the common case, and the reason this is phrased positively: every control
   * gates on `store.canControl`, so a component that forgets the guest case still works for the
   * owner AND stays honest for a guest, rather than the reverse.
   */
  const canControl = computed(() => shareViewer.value === null || shareViewer.value.perm === "control");

  async function loadCollaborations(): Promise<void> {
    if (isGuest.value) {
      collaborationSnapshots.value = [];
      return;
    }
    try {
      collaborationSnapshots.value = (await api.collaborationSnapshots()).snapshots;
    } catch {
      /* the relay is optional presence infrastructure; keep the last good snapshot */
    }
  }

  /**
   * Hydrate the dashboard.
   *
   * Note the `isGuest` branches: everything skipped here is a route the daemon deliberately
   * refuses a share-link guest (identities, AI config, GitHub accounts, cloud sync, MCP approvals,
   * the Identity Firewall, update checks, telemetry — see src/share/policy.ts). Asking anyway
   * isn't merely wasteful, it's a correctness bug: this is one `Promise.all`, so a single 403
   * rejects the whole batch and `repos.value = r` never runs — the guest lands on a dashboard that
   * says "No repositories yet" while /api/repos sits there having returned 200 with their repo.
   * The owner's path below is byte-for-byte what it always was.
   */
  let loadAllInFlight: Promise<void> | null = null;

  // ── snapshot / event ordering (1.0 audit, item 7) ──────────────────────────────────────────
  // loadAll() and the SSE stream start together (AppShell), the daemon has no event cursor, and
  // loadAll() is also the reconnect resync. Between "list requested" and "list installed" a
  // repo-scoped event has nothing correct to apply to: a `repo_removed` filtered the OLD list and
  // the late snapshot put the repo straight back; a `repo_state_changed` for a repo the old list
  // did not have was dropped by patchRepo. Simply connecting after the GET is no better (an event
  // between the GET and the stream opening is lost), so the stream stays open and repo-scoped
  // events that arrive while a snapshot is in flight are HELD and replayed, in order, the moment
  // the snapshot lands (on the failure path too, against whatever list is current). A held
  // status older than what the snapshot installed is not applied (see handleRepoStateChanged).
  let snapshotPending = false;
  const heldEvents: Array<{ name: string; payload: unknown }> = [];
  let liveEventCtx: SseEventCtx | null = null;

  function replayHeldEvents(): void {
    const events = heldEvents.splice(0);
    const ctx = liveEventCtx;
    if (!ctx) return; // disconnected meanwhile: the next connect re-hydrates from scratch anyway
    for (const { name, payload } of events) {
      try {
        dispatchSseEvent(name, payload, ctx);
      } catch {
        /* one malformed held frame must not stop the rest */
      }
    }
  }

  /** The SSE frame gate: hold repo-scoped events while a list snapshot is in flight, dispatch
   *  everything else (and everything, once the snapshot is installed) immediately. */
  function routeSseEvent(name: string, payload: unknown, ctx: SseEventCtx): void {
    if (snapshotPending && REPO_SCOPED_EVENTS.has(name)) {
      heldEvents.push({ name, payload });
      return;
    }
    dispatchSseEvent(name, payload, ctx);
  }

  async function loadAllOnce(): Promise<void> {
    loading.value = true;
    const guest = isGuest.value;
    try {
      // The repository list is the only payload required to paint the dashboard. Previously it
      // shared one Promise.all with every optional integration, so a slow GitHub CLI/cloud-sync
      // probe held the entire app on skeleton rows. Paint as soon as this request succeeds.
      snapshotPending = true;
      try {
        const nextRepos = await api.listRepos();
        repos.value = nextRepos;
        pruneRepoCaches(new Set(nextRepos.map((repo) => repo.id)));
      } finally {
        snapshotPending = false;
        replayHeldEvents();
      }
      loading.value = false;

      // Yield through Vue's queued render before starting the non-critical hydration burst. The
      // loadAll promise still waits for these tasks (useful to callers/tests), but the UI does not.
      await Promise.resolve();
      const background: Promise<unknown>[] = [
        loadStatus(),
        guest ? loadAiAvailability() : loadAiSettings(),
      ];
      if (!guest) {
        background.push(
          api.listIdentities().then((next) => {
            identities.value = next;
          }),
          loadAiCatalog(),
          loadAccounts(), // header account switcher
          loadSyncStatus(), // applies synced appearance
          loadApprovals(), // already-pending MCP approvals
          loadIdentityRules(), // Identity Firewall rules
          // Collaboration snapshots have no polling fallback — they are pure SSE, on purpose (the
          // event replaced a 2.5s HTTP poll). That makes them the one slice of state a dropped
          // frame strands permanently: this used to be fetched ONLY at the first connect(), so a
          // phone that backgrounded through a `collaboration_snapshots_changed` came back showing a
          // collaborator who had long since gone. loadAll() is also the reconnect resync, so
          // hydrating here is what makes the reconnect actually whole.
          loadCollaborations(),
        );
      } else {
        identities.value = [];
      }
      await Promise.allSettled(background);
    } finally {
      loading.value = false;
      if (!isGuest.value) void checkForUpdate(); // owner-only: /api/updates
    }
  }

  /**
   * Coalesce startup/header reloads. Double-clicking refresh while a slow optional integration is
   * still hydrating must not launch a second copy of every account/configuration request.
   */
  function loadAll(): Promise<void> {
    if (loadAllInFlight) return loadAllInFlight;
    const request = loadAllOnce();
    loadAllInFlight = request;
    void request.finally(() => {
      if (loadAllInFlight === request) loadAllInFlight = null;
    }).catch(() => undefined);
    return request;
  }

  /** Fetch runtime status (access mode + the remote-access tunnel URL, if any). Best-effort.
   *  Every field it installs, and what an absent one means, is in store/runtime-status.ts. */
  async function loadStatus(): Promise<void> {
    try {
      runtime.applySnapshot(await api.status(), { notifyAiKeyInvalid });
    } catch {
      /* status is optional — leave whatever we have */
    }
  }

  // ── live updates (SSE) ──────────────────────────────────────────────────────
  let closeEventSource: (() => void) | null = null;
  let stopEventWatches: Array<() => void> = [];

  function connect(): void {
    // AppShell can be remounted during auth/navigation transitions. One Pinia store outlives
    // those component instances, so connecting twice must not leave duplicate EventSources and
    // permanent Vue watchers processing every event twice.
    if (closeEventSource) return;
    void loadCollaborations();
    const { status, event, data, close } = useEventSource(
      "/api/events",
      [
        "hello",
        "ping",
        "repo_state_changed",
        "repo_added",
        "repo_removed",
        "repo_renamed",
        "repo_identity_changed",
        "identity_rules_changed",
        "repo_account_changed",
        "repo_hidden_changed",
        "repo_pinned_changed",
        "repo_starred_changed",
        "repo_auto_commit_changed",
        "repo_behind",
        "repo_synced",
        "repo_auto_committed",
        "repo_auto_commit_blocked",
        "daemon_status",
        "settings_changed",
        "scan_started",
        "scan_progress",
        "scan_done",
        "scan_cancelled",
        "fetch_all_started",
        "fetch_all_progress",
        "fetch_all_done",
        "fetch_all_cancelled",
        "update_available",
        "approval_pending",
        "approval_resolved",
        "collaboration_snapshots_changed",
        "ai_key_invalid",
        "auto_update_applying",
        "auto_update_restarting",
      ],
      { autoReconnect: { retries: -1, delay: 2500 } },
    );
    closeEventSource = close;
    // Whether THIS connection has ever reached OPEN before, so the very first connect (already
    // covered by the caller's own loadAll()) doesn't trigger a redundant resync — only a genuine
    // reconnect after a drop does.
    let hasConnectedOnce = false;
    // The full per-event-type handling lives in the SSE_EVENT_HANDLERS table (module scope,
    // below the store) — one named function per arm, dispatched by event name. `eventCtx`
    // bundles every ref/action a handler might need; it's rebuilt per connect() (reconnects
    // are rare, and every field is a stable ref/function reference either way).
    const eventCtx: SseEventCtx = {
      getRepoStatus,
      hasRepo,
      patchRepo,
      queueRepoAdded,
      flushPendingRepoInserts,
      identityRules,
      notifyUpdateAvailable,
      reconcileBehindNotification,
      notifyBehind,
      notifySynced,
      notifyAutoCommitted,
      notifyAutoCommitBlocked,
      notifyNewProjects,
      notifyAiKeyInvalid,
      addPendingApproval,
      removePendingApproval,
      loadEditors,
      loadSyncStatus,
      checkForUpdate,
      repos,
      collaborationSnapshots,
      autoUpdateApplying,
      autoUpdateRestarting,
      runtime,
      editorsLoaded,
      applyFetchAllEvent,
      scanning,
      scanFound,
      scanNew,
      scanDone,
      lastScanCancelled,
      scanCancelRequested,
      scanNewRepos,
      collectingScanRepos,
      isGuest,
      clearRepoCaches,
      bumpHistoryRevision,
      isHistoryRelevantStatusChange,
    };
    liveEventCtx = eventCtx;
    stopEventWatches = [
      watch(
        status,
        (s) => {
          const isOpen = s === "OPEN";
          // The daemon has no event replay/Last-Event-ID, so anything broadcast while this
          // client was offline (a phone backgrounding and returning, a flaky network) is lost
          // for good unless something re-hydrates from scratch on reconnect.
          if (isOpen && hasConnectedOnce && !connected.value) {
            // Whatever update was in flight has landed (or failed and left the old build running);
            // either way the daemon answering now is the authority, and loadAll refetches it.
            autoUpdateApplying.value = false;
            autoUpdateRestarting.value = false;
            void loadAll();
            // The daemon has no event replay: a scan_done/scan_cancelled broadcast fired while
            // this client was offline is gone for good. Ask directly rather than trust the stale
            // `scanning` flag — reconcileScan no-ops unless it was left true.
            void reconcileScan();
            // Same reasoning for the bulk fetch: a phone that backgrounded mid-sweep missed both
            // the heartbeats and the terminal event, and unlike the scan the daemon can also tell
            // it what the run actually did.
            void reconcileFetchAll();
          }
          connected.value = isOpen;
          if (isOpen) hasConnectedOnce = true;
          // PWA self-heal (see lib/relay-home.ts): a stream that stays dead on a rotating
          // quick-tunnel origin usually means the tunnel restarted onto a new hostname — ask
          // the relay where the daemon went and follow it, instead of reconnecting forever
          // into a hostname that no longer exists.
          if (isOpen) disarmSelfHeal();
          else armSelfHeal();
        },
        { immediate: true },
      ),
      watch(data, (raw) => {
        if (!raw || !event.value) return;
        try {
          routeSseEvent(event.value, JSON.parse(raw), eventCtx);
        } catch {
          /* ignore malformed frame */
        }
      }),
    ];
  }

  function disconnect(): void {
    for (const stop of stopEventWatches.splice(0)) stop();
    closeEventSource?.();
    closeEventSource = null;
    connected.value = false;
    liveEventCtx = null;
    heldEvents.length = 0; // nothing to replay them into; the next connect re-hydrates
  }

  return {
    repos,
    collaborationSnapshots,
    loadCollaborations,
    identities,
    identitiesRelevant,
    identityUiForced,
    setIdentityUiForced,
    detectedIdentities,
    dismissedDetectedIdentities,
    detectedIdentitiesLoading,
    detectedIdentitiesReady,
    loading,
    connected,
    updateStatus,
    updateChecking,
    updateApplying,
    autoUpdateApplying,
    autoUpdateRestarting,
    checkForUpdate,
    applyUpdate,
    busy,
    historyRevisionByRepo,
    bumpHistoryRevision,
    changesByRepo,
    changesLoading,
    changesMeta,
    changesShowAll,
    loadChanges,
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
    roots,
    servers,
    loreServersEnabled,
    buzzEnabled,
    buzzCommunities,
    fetchingAll,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    scanOpen,
    addRepoOpen,
    scanning,
    scanFound,
    scanNew,
    scanDone,
    lastScanCancelled,
    scanCancelRequested,
    scanNewRepos,
    scanReturnToAdd,
    dropScanNewRepo,
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
    cleanupMissingRepos,
    shutdown,
    logoutAll,
    aiSettings,
    aiCatalog,
    aiReady,
    aiEnabled,
    aiUsable,
    aiCommitEnabled,
    aiConflictEnabled,
    loadAiSettings,
    loadAiAvailability,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setCommitEnabled,
    setConflictEnabled,
    setStyle,
    setDiffDetail,
    removeProvider,
    keyPools,
    loadKeyPool,
    setKeyPool,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
    listConflicts,
    readConflict,
    resolveConflict,
    applyConflict,
    autoCommitIncidents,
    autoCommitIncidentsUnacked,
    autoCommitIncidentsReady,
    autoCommitIncidentsLoading,
    loadAutoCommitIncidents,
    ackAutoCommitIncident,
    operationalErrors,
    operationalErrorsReady,
    operationalErrorsLoading,
    loadOperationalErrors,
    setOperationalErrorMuted,
    dismissOperationalError,
    authReady,
    authEnforced,
    authenticated,
    owner,
    ownerPicture,
    shareViewer,
    isGuest,
    canControl,
    mode,
    ownerClaimed,
    canContinueLocal,
    localBypass,
    continueLocal,
    serverVersion,
    setMode,
    setTunnel,
    setRelay,
    identityById,
    tunnelUrl,
    tunnelActive,
    tunnelConfig,
    relayConfig,
    relayUrl,
    relayAnnounced,
    relayError,
    diffStatsEnabled,
    changesStatDisplay,
    changesCharsEnabled,
    contentSearchMin,
    setDiffStats,
    setChangesStatDisplay,
    setChangesChars,
    remoteEditing,
    remoteBrowse,
    setRemoteEditing,
    setRemoteBrowse,
    diffPatchBytes,
    setDiffPatchBytes,
    diffPatchEnabled,
    setDiffPatchEnabled,
    syncCheckEnabled,
    syncIntervalSecs,
    keepInSync,
    setSyncCheck,
    setSyncInterval,
    setKeepInSync,
    autoCommit,
    autoCommitMode,
    autoCommitIntervalSecs,
    autoCommitAt,
    autoCommitPull,
    autoCommitPush,
    autoCommitAiFallback,
    autoUpdate,
    updateNotify,
    setAutoCommit,
    setAutoUpdate,
    setUpdateNotify,
    setAutoCommitMode,
    setAutoCommitInterval,
    setAutoCommitAt,
    setAutoCommitPull,
    setAutoCommitPush,
    setAutoCommitAiFallback,
    setRepoAutoCommit,
    autoScan,
    setAutoScan,
    portableMode,
    setPortableMode,
    openPortableWindow,
    hideTrayIcon,
    setHideTrayIcon,
    mcpApprovalGate,
    mcpApprovalTimeoutSecs,
    mcpAutoDeny,
    mcpAutoApprove,
    mcpAutoApproveTimeoutSecs,
    setMcpApprovalGate,
    setMcpApprovalTimeoutSecs,
    setMcpAutoDeny,
    setMcpAutoApprove,
    setMcpAutoApproveTimeoutSecs,
    defaultEditor,
    editorsCatalog,
    editorsPlatform,
    effectiveEditor,
    editorsLoaded,
    editorsLoading,
    loadEditors,
    setDefaultEditor,
    openInEditor,
    pendingApprovals,
    approvalBusy,
    loadApprovals,
    approveCall,
    denyCall,
    syncStatus,
    syncLoading,
    syncActionBusy,
    syncError,
    loadSyncStatus,
    enableSync,
    disableSync,
    pushSync,
    pullSync,
    pushAppearance,
    notifications,
    unreadCount,
    markNotificationsRead,
    dismissNotification,
    clearNotifications,
    updatePromptOpen,
    updateBlockedReason,
    openUpdatePrompt,
    restartDaemon,
    notifyUpdateAvailable,
    clearUpdateNotification,
    pullBehind,
    desktopNotify,
    notifyPermission,
    enableDesktopNotify,
    disableDesktopNotify,
    loadStatus,
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
    renameRepo,
    removeRepo,
    restoreRemovedRepo,
    setHidden,
    setPinned,
    setStarred,
    loadAuth,
    logout,
    leaveShare,
    loadAll,
    connect,
    disconnect,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    addRepo,
    persistRepoOrder,
    resetRepoOrder,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
    dismissDetectedIdentity,
    restoreDetectedIdentity,
    restoreDetectedIdentities,
    identityRules,
    identityRulesReady,
    loadIdentityRules,
    setIdentityRules,
    cloneRepo,
    // GitHub (gh) accounts
    ghAvailable,
    ghAccounts,
    gitCommitIdentity,
    accountsReady,
    accountsLoading,
    switchingAccount,
    activeAccount,
    loadAccounts,
    switchAccount,
    setAccountIdentity,
  };
});

// ─── SSE event dispatch ────────────────────────────────────────────────────────
//
// The daemon's /api/events stream (connect(), above) used to decide what each event type does
// in one 250-line if/else-if chain, closing directly over every ref and action the store
// exposes. That made the whole thing one function as far as any complexity check is concerned,
// no matter how the branches inside it were named. Below is the same logic, unchanged, as one
// module-level named function per event — genuinely dedented, not closures nested inside
// connect() — plus the bundle of refs/actions they need (SseEventCtx) built once per connect()
// call and threaded through explicitly instead of captured.

/** Everything an SSE event handler might touch. Built once in connect() (see above) from that
 *  closure's live refs/actions and passed to every handler below — a plain data bundle, not a
 *  live subscription, so this typing exists purely to keep each handler's own footprint honest. */
type SseEventCtx = Pick<
  ReturnType<typeof useRepoActions>,
  "getRepoStatus" | "hasRepo" | "patchRepo" | "queueRepoAdded" | "flushPendingRepoInserts"
> &
  Pick<ReturnType<typeof useIdentities>, "identityRules"> &
  Pick<
    ReturnType<typeof useSettings>,
    | "notifyUpdateAvailable"
    | "reconcileBehindNotification"
    | "notifyBehind"
    | "notifySynced"
    | "notifyAutoCommitted"
    | "notifyAutoCommitBlocked"
    | "notifyNewProjects"
    | "notifyAiKeyInvalid"
    | "addPendingApproval"
    | "removePendingApproval"
    | "loadEditors"
    | "loadSyncStatus"
  > &
  Pick<ReturnType<typeof useSelfUpdate>, "checkForUpdate"> & {
    repos: Ref<Repo[]>;
    collaborationSnapshots: Ref<CollaborationSnapshot[]>;
    autoUpdateApplying: Ref<boolean>;
    autoUpdateRestarting: Ref<boolean>;
    /** The daemon-owned runtime fields and their one synchroniser (store/runtime-status.ts).
     *  Handlers ask IT to apply a patch rather than each reaching into forty refs. */
    runtime: RuntimeStatusStore;
    /** Still here because handleSettingsChanged has to tell it whether a refresh is worth it. */
    editorsLoaded: Ref<boolean>;
    /** The fetch-all job's counters live with the rest of its state in store/sources.ts; this is
     *  the one entry point the event table needs into them. */
    applyFetchAllEvent: (name: string, payload: unknown) => void;
    scanning: Ref<boolean>;
    scanFound: Ref<number>;
    scanNew: Ref<number>;
    scanDone: Ref<boolean>;
    lastScanCancelled: Ref<boolean>;
    scanCancelRequested: Ref<boolean>;
    scanNewRepos: Ref<Array<{ id: string; name: string; absPath: string }>>;
    collectingScanRepos: Ref<boolean>;
    isGuest: ComputedRef<boolean>;
    clearRepoCaches: (repoId: string) => void;
    bumpHistoryRevision: (repoId: string) => void;
    isHistoryRelevantStatusChange: (previous: Repo["status"], next: Repo["status"]) => boolean;
  };

function handleRepoStateChanged(payload: any, ctx: SseEventCtx): void {
  const previousStatus = ctx.getRepoStatus(payload.id);
  const nextStatus = (payload.status as Repo["status"] | undefined) ?? null;
  // Never move a card backwards. A frame held during a list snapshot (see routeSseEvent), or one
  // that simply arrived late, can describe an OLDER read than the status already installed;
  // `updatedAt` is the daemon's own read time, so an older one is stale by definition.
  if (
    nextStatus &&
    previousStatus &&
    typeof nextStatus.updatedAt === "number" &&
    typeof previousStatus.updatedAt === "number" &&
    nextStatus.updatedAt < previousStatus.updatedAt
  ) {
    return;
  }
  ctx.patchRepo(payload.id, { status: nextStatus });
  if (ctx.isHistoryRelevantStatusChange(previousStatus, nextStatus)) {
    ctx.bumpHistoryRevision(payload.id);
  }
  // Behind notifications are snapshots of a condition whose source of truth is the live
  // repo status. Every pull/fetch/refresh reaches this event, even if it did not start
  // from the notification, so keep its count current and retire it at zero. A failed
  // status read reports zero as a fallback; do not treat that unknown state as resolved.
  if (payload.status && !payload.status.error && typeof payload.status.behind === "number") {
    ctx.reconcileBehindNotification(payload.id, payload.status.behind);
  }
}

// Background discovery found a repo after boot — slot it in (or refresh in place). A
// scan fires this once per repo it finds, so new repos are buffered and merged in one
// batch per animation frame instead of splicing (and recomputing every dependent list)
// once per event — see queueRepoAdded/flushPendingRepoInserts in store/repo.ts.
function handleRepoAdded(payload: any, ctx: SseEventCtx): void {
  const repo = payload.repo as Repo | undefined;
  if (!repo?.id) return;
  const isNew = !ctx.hasRepo(repo.id);
  ctx.queueRepoAdded(repo);
  // Only a running scan's finds go on the review list, and only ones we didn't have.
  if (isNew && ctx.collectingScanRepos.value) {
    ctx.scanNewRepos.value.push({ id: repo.id, name: repo.name, absPath: repo.absPath });
  }
}

// A scan root was removed, the owner removed this repo, or — on an all-repos share link —
// they hid it and it left this viewer's scope (src/share/events.ts translates the hide
// into exactly this event). Drop the card live, and take the file viewer with it if it
// was open on that repo: the drawer would otherwise sit there looking live while every
// call it makes 404s against a repo this session can no longer reach.
function handleRepoRemoved(payload: any, ctx: SseEventCtx): void {
  if (!payload.id) return;
  ctx.repos.value = ctx.repos.value.filter((r) => r.id !== payload.id);
  ctx.clearRepoCaches(payload.id);
  ctx.reconcileBehindNotification(payload.id, 0);
  dismissViewerForRepo(payload.id);
}

function handleRepoRenamed(payload: any, ctx: SseEventCtx): void {
  // Renamed on another device — adopt the new label live.
  ctx.patchRepo(payload.id, { displayName: payload.displayName ?? null });
}

function handleRepoIdentityChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, { identityId: payload.identityId });
}

function handleIdentityRulesChanged(payload: any, ctx: SseEventCtx): void {
  // Another tab/device edited the rules — adopt the fresh list live.
  if (Array.isArray(payload.rules)) ctx.identityRules.value = payload.rules;
}

function handleRepoAccountChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, {
    syncAccountHost: payload.syncAccountHost ?? null,
    syncAccountLogin: payload.syncAccountLogin ?? null,
  });
}

function handleRepoHiddenChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, { hidden: !!payload.hidden });
}

function handleRepoPinnedChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, { pinned: !!payload.pinned });
}

function handleRepoStarredChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, { starred: !!payload.starred });
}

function handleRepoAutoCommitChanged(payload: any, ctx: SseEventCtx): void {
  ctx.patchRepo(payload.id, { autoCommit: !!payload.autoCommit });
}

function handleRepoBehind(payload: any, ctx: SseEventCtx): void {
  // The background sync check found repos with new remote commits → warn (toast +
  // opt-in OS notification). The amber card state arrives separately via repo_state_changed.
  ctx.notifyBehind((payload.repos as BehindRepo[] | undefined) ?? []);
}

function handleRepoSynced(payload: any, ctx: SseEventCtx): void {
  // "Keep in sync" auto-pulled these — quiet confirmation (the cards already updated).
  const synced = (payload.repos as SyncedRepo[] | undefined) ?? [];
  for (const repo of synced) {
    if (repo.pulled > 0) ctx.bumpHistoryRevision(repo.id);
  }
  ctx.notifySynced(synced);
}

function handleRepoAutoCommitted(payload: any, ctx: SseEventCtx): void {
  // The auto-commit timer committed (and maybe synced) these — quiet success toast.
  const committed = (payload.repos as AutoCommittedRepo[] | undefined) ?? [];
  for (const repo of committed) {
    if (repo.commits > 0) ctx.bumpHistoryRevision(repo.id);
  }
  ctx.notifyAutoCommitted(committed);
}

function handleRepoAutoCommitBlocked(payload: any, ctx: SseEventCtx): void {
  // The auto-commit timer skipped these (conflict / mid-operation / failed sync) → warn.
  ctx.notifyAutoCommitBlocked((payload.repos as AutoCommitBlockedRepo[] | undefined) ?? []);
}

function handleUpdateAvailable(payload: any, ctx: SseEventCtx): void {
  // The scheduled check found a newer build. This NEVER installs anything on its own
  // (that's the separate, opt-in `autoUpdate`) — it surfaces the offer and lets the
  // owner decide, which is the whole point of the notify/apply split.
  ctx.notifyUpdateAvailable({
    canApply: payload.canApply !== false,
    reason: typeof payload.reason === "string" ? payload.reason : null,
  });
  // Re-read /api/updates so the Settings version badge learns about this too. It is drawn
  // from `updateStatus`, which is filled once at boot (loadAllOnce) and never again — so
  // an announcement that arrived while the dashboard was open used to leave the bell
  // offering an update the Version row still said did not exist. Owner-only, same gate as
  // the boot check; single-flight, and the daemon caches the answer for 5 minutes.
  if (!ctx.isGuest.value) void ctx.checkForUpdate();
}

function handleAutoUpdateApplying(_payload: any, ctx: SseEventCtx): void {
  ctx.autoUpdateApplying.value = true;
}

function handleAutoUpdateRestarting(_payload: any, ctx: SseEventCtx): void {
  ctx.autoUpdateApplying.value = false;
  ctx.autoUpdateRestarting.value = true;
}

/**
 * `daemon_status` and `settings_changed` are both PATCHES, and which fields each carries — plus
 * what a value has to look like to be believed — lives in store/runtime-status.ts's one table.
 * These used to be seven functions here, each re-stating a type check the snapshot path stated
 * differently a hundred lines away.
 */
function handleDaemonStatus(payload: unknown, ctx: SseEventCtx): void {
  ctx.runtime.applyDaemonStatus(payload);
}

function handleFetchAll(payload: unknown, eventName: string, ctx: SseEventCtx): void {
  ctx.applyFetchAllEvent(eventName, payload);
}

function handleSettingsChanged(payload: unknown, ctx: SseEventCtx): void {
  ctx.runtime.applySettingsChanged(payload, {
    loadSyncStatus: ctx.loadSyncStatus,
    loadEditors: ctx.loadEditors,
    editorsLoaded: ctx.editorsLoaded,
  });
}

function handleApprovalPending(payload: any, ctx: SseEventCtx): void {
  // A headless agent's mutating MCP call is now awaiting owner approve/deny.
  ctx.addPendingApproval(payload as PendingApproval);
}

function handleApprovalResolved(payload: any, ctx: SseEventCtx): void {
  // Approved/denied/timed out — elsewhere (another tab) or by the auto-deny/approve timer.
  ctx.removePendingApproval(payload.id);
}

function handleCollaborationSnapshotsChanged(payload: any, ctx: SseEventCtx): void {
  // Snapshot arrival and expiry are daemon events. This replaces a 2.5s HTTP poll in
  // every open tab while still removing a peer promptly when its heartbeat expires.
  if (Array.isArray(payload.snapshots))
    ctx.collaborationSnapshots.value = payload.snapshots as CollaborationSnapshot[];
}

function handleAiKeyInvalid(payload: any, ctx: SseEventCtx): void {
  // The startup key-liveness check found a configured AI provider's key was rejected.
  ctx.notifyAiKeyInvalid(
    typeof payload.label === "string" && payload.label ? payload.label : String(payload.provider ?? ""),
  );
}

function handleScanStarted(_payload: any, ctx: SseEventCtx): void {
  // A rescan began (from the modal, or another device) — reset the live counters.
  ctx.scanning.value = true;
  ctx.scanDone.value = false;
  ctx.lastScanCancelled.value = false;
  ctx.scanCancelRequested.value = false;
  ctx.scanFound.value = 0;
  ctx.scanNew.value = 0;
  ctx.scanNewRepos.value = [];
  ctx.collectingScanRepos.value = true;
}

function handleScanProgress(payload: any, ctx: SseEventCtx): void {
  if (typeof payload.found === "number") ctx.scanFound.value = payload.found;
  if (typeof payload.added === "number") ctx.scanNew.value = payload.added;
}

function handleScanFinished(payload: any, eventName: string, ctx: SseEventCtx): void {
  // Force in whatever `repo_added` events are still sitting in the insert buffer — the
  // scan can finish between animation frames, and the summary/review list below reads
  // straight off `repos.value`/`scanNewRepos`, which must already reflect every find.
  ctx.flushPendingRepoInserts();
  ctx.scanning.value = false;
  ctx.scanDone.value = true;
  ctx.collectingScanRepos.value = false;
  ctx.lastScanCancelled.value = eventName === "scan_cancelled";
  // The daemon confirmed the stop (or the scan simply finished on its own) — any outstanding
  // "phone asked, still waiting" state is resolved either way.
  ctx.scanCancelRequested.value = false;
  if (typeof payload.found === "number") ctx.scanFound.value = payload.found;
  if (typeof payload.added === "number") ctx.scanNew.value = payload.added;
  // Surface genuinely-new projects even if the scan was stopped early.
  if (typeof payload.added === "number") ctx.notifyNewProjects(payload.added);
}

const SSE_EVENT_HANDLERS: Record<string, (payload: any, ctx: SseEventCtx) => void> = {
  repo_state_changed: handleRepoStateChanged,
  repo_added: handleRepoAdded,
  repo_removed: handleRepoRemoved,
  repo_renamed: handleRepoRenamed,
  repo_identity_changed: handleRepoIdentityChanged,
  identity_rules_changed: handleIdentityRulesChanged,
  repo_account_changed: handleRepoAccountChanged,
  repo_hidden_changed: handleRepoHiddenChanged,
  repo_pinned_changed: handleRepoPinnedChanged,
  repo_starred_changed: handleRepoStarredChanged,
  repo_auto_commit_changed: handleRepoAutoCommitChanged,
  repo_behind: handleRepoBehind,
  repo_synced: handleRepoSynced,
  repo_auto_committed: handleRepoAutoCommitted,
  repo_auto_commit_blocked: handleRepoAutoCommitBlocked,
  update_available: handleUpdateAvailable,
  auto_update_applying: handleAutoUpdateApplying,
  auto_update_restarting: handleAutoUpdateRestarting,
  daemon_status: handleDaemonStatus,
  settings_changed: handleSettingsChanged,
  approval_pending: handleApprovalPending,
  approval_resolved: handleApprovalResolved,
  collaboration_snapshots_changed: handleCollaborationSnapshotsChanged,
  ai_key_invalid: handleAiKeyInvalid,
  scan_started: handleScanStarted,
  scan_progress: handleScanProgress,
};

/** Events whose effect depends on which repos the list currently holds. These are the ones the
 *  store holds back while a list snapshot is in flight (routeSseEvent); notifications, settings,
 *  approvals, scans and daemon status are applied live regardless. */
const REPO_SCOPED_EVENTS = new Set([
  "repo_state_changed",
  "repo_added",
  "repo_removed",
  "repo_renamed",
  "repo_identity_changed",
  "repo_account_changed",
  "repo_hidden_changed",
  "repo_pinned_changed",
  "repo_starred_changed",
  "repo_auto_commit_changed",
]);

/** Dispatch one parsed SSE frame to its handler by event name. `scan_done`/`scan_cancelled`
 *  share one handler (it tells them apart from the name it's given), so it's not in the table. */
function dispatchSseEvent(eventName: string, payload: any, ctx: SseEventCtx): void {
  if (eventName === "scan_done" || eventName === "scan_cancelled") {
    handleScanFinished(payload, eventName, ctx);
    return;
  }
  // All four fetch_all_* events go to one applier, which needs the name to tell a heartbeat from
  // a terminal event (see store/sources.ts).
  if (eventName.startsWith("fetch_all_")) {
    handleFetchAll(payload, eventName, ctx);
    return;
  }
  const handler = SSE_EVENT_HANDLERS[eventName];
  if (handler) handler(payload, ctx);
}
