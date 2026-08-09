import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useEventSource } from "@vueuse/core";
import { api, ApiError, type AccessMode, type TunnelStatus, type RelayStatus } from "../api";
import type {
  ActionName,
  ActionResult,
  ChangesStatDisplay,
  PendingApproval,
  Repo,
  CollaborationSnapshot,
  UpdateApplyResult,
  UpdateStatus,
} from "../types";
import { useSelfUpdate } from "@/lib/useSelfUpdate";
import { dismissViewerForRepo } from "@/lib/file-viewer";
import { useRepoActions, type StatusKey } from "./repo";
import { useAi } from "./ai";
import { useGitOps } from "./git-ops";
import { useSources } from "./sources";
import { useIdentities } from "./identities";
import {
  useSettings,
  type BehindRepo,
  type SyncedRepo,
  type AutoCommittedRepo,
  type AutoCommitBlockedRepo,
} from "./settings";

export type { StatusKey };

let appOpenedPulsed = false;

export const useStore = defineStore("repoyeti", () => {
  const repos = ref<Repo[]>([]);
  /** Peer working-tree presence, decrypted by the daemon. */
  const collaborationSnapshots = ref<CollaborationSnapshot[]>([]);
  const loading = ref(true);
  const connected = ref(false);
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

  // Public cloudflared tunnel URL (null until one exists) + whether a tunnel is up.
  // Surfaced in the connection panel so the owner can open RepoYeti on their phone.
  const tunnelUrl = ref<string | null>(null);
  const tunnelActive = ref(false);
  // Redacted named-tunnel config (stable hostname + token-presence flags; never the token).
  // From /api/status, kept live via the `settings_changed` SSE event. Drives the Settings
  // "Stable address" editor.
  const tunnelConfig = ref<TunnelStatus>({
    hostname: null,
    hasToken: false,
    tokenFromEnv: false,
    named: false,
  });
  // Redacted relay config (opt-in flag, base URL, public id; never the keypair) plus the permanent
  // forwarding URL it yields and whether the daemon's address is actually registered there. Drives
  // the Settings "Permanent link" row. Same sourcing as tunnelConfig: /api/status, then SSE.
  const relayConfig = ref<RelayStatus>({
    // Match the daemon's effective default before /api/status finishes loading. Starting this at
    // false made the Settings panel briefly—and sometimes permanently—select the temporary
    // Cloudflare address when it mounted during startup, even though the daemon was hosted-relay on.
    enabled: true,
    url: null,
    id: null,
    defaultUrl: "https://app.repoyeti.com",
  });
  const relayUrl = ref<string | null>(null);
  const relayAnnounced = ref(false);
  const relayError = ref<string | null>(null);
  // Access mode + local/remote auth state (see /api/auth/status).
  const mode = ref<AccessMode>("local");

  // Owner setting: show added/removed line + char counts per file and per repo. Sourced
  // from /api/status and kept live via the `settings_changed` SSE event. Off by default.
  const diffStatsEnabled = ref(false);
  // Work-tree appearance. Daemon settings (not localStorage) so they follow the owner across
  // devices like diffStatsEnabled does — the defaults here match config.ts's absent-key ones.
  const changesStatDisplay = ref<ChangesStatDisplay>("numbers");
  const changesCharsEnabled = ref(true);
  // Owner setting: allow editing/saving files over the remote tunnel (local edits always on).
  const remoteEditing = ref(true);
  // Owner setting: changed files larger than this (bytes, either side) open as a compact
  // patch in the viewer's Diff tab instead of a side-by-side load. From /api/status, kept
  // live via `settings_changed`; 512 KB until status loads.
  const diffPatchBytes = ref(512 * 1024);
  // Owner setting: whether large files may use the compact patch at all (false = always
  // side-by-side). From /api/status, kept live via `settings_changed`; on until status loads.
  const diffPatchEnabled = ref(true);
  // Owner setting: run a periodic background fetch so the dashboard can warn when a repo falls
  // behind its remote. From /api/status, kept live via `settings_changed`; off until status loads.
  const syncCheckEnabled = ref(false);
  // How often that background check runs, in seconds. From /api/status; 300 until status loads.
  const syncIntervalSecs = ref(300);
  // Owner setting: after the check, auto fast-forward repos that can safely take new commits.
  // From /api/status, kept live via `settings_changed`; off until status loads (opt-in).
  const keepInSync = ref(false);
  // Owner settings: the auto-commit timer (opt-in globally here + per-repo on each card). From
  // /api/status, kept live via `settings_changed`. Off + built-in defaults until status loads.
  const autoCommit = ref(false);
  const autoCommitMode = ref<"interval" | "daily">("interval");
  const autoCommitIntervalSecs = ref(900);
  const autoCommitAt = ref("18:00");
  const autoCommitPull = ref(true);
  const autoCommitPush = ref(true);
  const autoCommitAiFallback = ref<"skip" | "basic">("skip");
  // Owner setting: silently auto-update + restart the app on a schedule (opt-in). From /api/status,
  // kept live via `settings_changed`; off until status loads.
  const autoUpdate = ref(false);
  // Owner setting: announce an available update (a bell entry + a prompt offering to install).
  // ON by default — it only tells you; installing still takes a click, or the opt-in `autoUpdate`
  // above. From /api/status, kept live via `settings_changed`.
  const updateNotify = ref(true);
  // Owner setting: sweep the whole machine for repos on every app start. From /api/status,
  // kept live via `settings_changed`; off until status loads (opt-in) — see AppShell.vue's
  // scheduleIdle(() => autoScan && startScan()) on mount.
  const autoScan = ref(false);
  // Owner setting: open the app UI in a chromeless Chromium app window instead of a browser
  // tab. From /api/status, kept live via `settings_changed`; off until status loads. The
  // desktop launcher/tray follows the same preference (read off runtime.json, not this).
  const portableMode = ref(false);
  // Owner setting: hide the system-tray notification-area icon. From /api/status, kept live via
  // `settings_changed`; off until status loads. The daemon keeps running in the background either
  // way — the desktop launcher/tray follows the same preference (read off runtime.json, not this).
  const hideTrayIcon = ref(false);
  // ⭐ Agent Safety Rail: whether mutating MCP tool calls are gated behind owner approve/deny.
  // From /api/status, kept live via `settings_changed`; on until status loads (safe default).
  const mcpApprovalGate = ref(true);
  // Auto-deny timeout for a pending approval, in seconds. From /api/status; 120 until loaded.
  const mcpApprovalTimeoutSecs = ref(120);
  // Whether a pending approval auto-denies at its timeout (default ON) / auto-approves at its own
  // timeout (default OFF). From /api/status, kept live via `settings_changed`.
  const mcpAutoDeny = ref(true);
  const mcpAutoApprove = ref(false);
  const mcpAutoApproveTimeoutSecs = ref(120);
  // Owner setting: default "Open with…" external editor id (null = auto-pick the first installed).
  // From /api/status, kept live via `settings_changed`. The catalogue + availability come from a
  // separate GET /api/editors (loaded lazily by the file viewer / Settings).
  const defaultEditor = ref<string | null>(null);

  // Min query length before the changed-files "search content" toggle greps. Server-owned
  // (from /api/status) so the UI gate never drifts from the daemon's; 3 until status loads.
  const contentSearchMin = ref(3);

  // Live scan lifecycle, driven entirely by the scan_* SSE events (see connect()) and by
  // sources.ts's startScan()/cancelScan().
  const scanning = ref(false);
  const scanFound = ref(0); // repos seen so far this scan
  const scanNew = ref(0); // of those, how many were not previously known
  const scanDone = ref(false); // a scan has finished (or was stopped) → show the summary
  const lastScanCancelled = ref(false); // the finished scan ended via the Stop (X) control
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
    genCommitMessage,
    genCommitPlan,
    smartCommit,
    listConflicts,
    readConflict,
    resolveConflict,
    applyConflict,
  } = useAi(busy, loadChanges, asResult, bumpHistoryRevision);

  const {
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
    clearRepoCache: clearGitOpsCache,
    pruneRepoCache: pruneGitOpsCache,
  } = useGitOps(
    loadChanges,
    asResult,
    hasRepo,
    bumpHistoryRevision,
  );

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
    loreServersEnabled,
    buzzEnabled,
    buzzCommunities,
    fetchingAll,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    startScan,
    cancelScan,
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
    fetchAll,
    cleanupMissingRepos,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
    resetRepoOrder,
  } = useSources(
    repos,
    scanning,
    scanFound,
    scanNew,
    scanDone,
    lastScanCancelled,
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

  async function loadAllOnce(): Promise<void> {
    loading.value = true;
    const guest = isGuest.value;
    try {
      // The repository list is the only payload required to paint the dashboard. Previously it
      // shared one Promise.all with every optional integration, so a slow GitHub CLI/cloud-sync
      // probe held the entire app on skeleton rows. Paint as soon as this request succeeds.
      const nextRepos = await api.listRepos();
      repos.value = nextRepos;
      pruneRepoCaches(new Set(nextRepos.map((repo) => repo.id)));
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
        );
      } else {
        identities.value = [];
      }
      await Promise.allSettled(background);
    } finally {
      loading.value = false;
      if (!appOpenedPulsed && !isGuest.value) {
        appOpenedPulsed = true;
        void recordPulse("app_opened"); // owner-only telemetry; a guest is 403'd on /api/pulse
      }
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

  async function recordPulse(event: string, properties?: Record<string, unknown>): Promise<void> {
    try {
      await api.recordPulse(event, properties);
    } catch {
      /* pulse is non-critical */
    }
  }

  /** Fetch runtime status (access mode + the remote-access tunnel URL, if any). Best-effort. */
  async function loadStatus(): Promise<void> {
    try {
      const s = await api.status();
      mode.value = s.mode;
      tunnelActive.value = s.tunnelActive;
      tunnelUrl.value = s.tunnelUrl;
      if (s.tunnel) tunnelConfig.value = s.tunnel;
      if (s.relay) relayConfig.value = s.relay;
      relayUrl.value = s.relayUrl ?? null;
      relayAnnounced.value = s.relayAnnounced === true;
      relayError.value = s.relayError ?? null;
      diffStatsEnabled.value = s.diffStats;
      changesStatDisplay.value = s.changesStatDisplay ?? "numbers";
      changesCharsEnabled.value = s.changesChars ?? true;
      remoteEditing.value = s.remoteEditing;
      diffPatchBytes.value = s.diffPatchBytes ?? 512 * 1024;
      diffPatchEnabled.value = s.diffPatchEnabled ?? true;
      syncCheckEnabled.value = s.syncCheck ?? false;
      syncIntervalSecs.value = s.syncIntervalSecs ?? 300;
      keepInSync.value = s.keepInSync ?? false;
      autoCommit.value = s.autoCommit ?? false;
      autoCommitMode.value = s.autoCommitMode ?? "interval";
      autoCommitIntervalSecs.value = s.autoCommitIntervalSecs ?? 900;
      autoCommitAt.value = s.autoCommitAt ?? "18:00";
      autoCommitPull.value = s.autoCommitPull ?? true;
      autoCommitPush.value = s.autoCommitPush ?? true;
      autoCommitAiFallback.value = s.autoCommitAiFallback ?? "skip";
      autoUpdate.value = s.autoUpdate ?? false;
      updateNotify.value = s.updateNotify ?? true;
      autoScan.value = s.autoScan ?? false;
      loreServersEnabled.value = s.loreServersEnabled ?? true;
      portableMode.value = s.portableMode ?? false;
      hideTrayIcon.value = s.hideTrayIcon ?? false;
      mcpApprovalGate.value = s.mcpApprovalGate ?? true;
      mcpApprovalTimeoutSecs.value = s.mcpApprovalTimeoutSecs ?? 120;
      mcpAutoDeny.value = s.mcpAutoDeny ?? true;
      mcpAutoApprove.value = s.mcpAutoApprove ?? false;
      mcpAutoApproveTimeoutSecs.value = s.mcpAutoApproveTimeoutSecs ?? 120;
      defaultEditor.value = s.defaultEditor ?? null;
      contentSearchMin.value = s.minContentSearch ?? 3;
      // Dead AI keys the daemon found at boot — surface them now (deduped per session in
      // notifyAiKeyInvalid), so a dashboard opened AFTER boot still sees them, not only one that
      // was connected for the one-shot SSE broadcast.
      for (const k of s.aiKeyInvalid ?? []) notifyAiKeyInvalid(k.label);
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
    stopEventWatches = [
      watch(
        status,
        (s) => {
          const isOpen = s === "OPEN";
          // The daemon has no event replay/Last-Event-ID, so anything broadcast while this
          // client was offline (a phone backgrounding and returning, a flaky network) is lost
          // for good unless something re-hydrates from scratch on reconnect.
          if (isOpen && hasConnectedOnce && !connected.value) void loadAll();
          connected.value = isOpen;
          if (isOpen) hasConnectedOnce = true;
        },
        { immediate: true },
      ),
      watch(data, (raw) => {
      if (!raw || !event.value) return;
      try {
        const payload = JSON.parse(raw);
        if (event.value === "repo_state_changed") {
          const previousStatus = getRepoStatus(payload.id);
          const nextStatus = (payload.status as Repo["status"] | undefined) ?? null;
          patchRepo(payload.id, { status: nextStatus });
          if (isHistoryRelevantStatusChange(previousStatus, nextStatus)) {
            bumpHistoryRevision(payload.id);
          }
          // Behind notifications are snapshots of a condition whose source of truth is the live
          // repo status. Every pull/fetch/refresh reaches this event, even if it did not start
          // from the notification, so keep its count current and retire it at zero. A failed
          // status read reports zero as a fallback; do not treat that unknown state as resolved.
          if (
            payload.status &&
            !payload.status.error &&
            typeof payload.status.behind === "number"
          ) {
            reconcileBehindNotification(payload.id, payload.status.behind);
          }
        } else if (event.value === "repo_added") {
          // Background discovery found a repo after boot — slot it in (or refresh in place). A
          // scan fires this once per repo it finds, so new repos are buffered and merged in one
          // batch per animation frame instead of splicing (and recomputing every dependent list)
          // once per event — see queueRepoAdded/flushPendingRepoInserts in store/repo.ts.
          const repo = payload.repo as Repo | undefined;
          if (repo?.id) {
            const isNew = !hasRepo(repo.id);
            queueRepoAdded(repo);
            // Only a running scan's finds go on the review list, and only ones we didn't have.
            if (isNew && collectingScanRepos.value) {
              scanNewRepos.value.push({ id: repo.id, name: repo.name, absPath: repo.absPath });
            }
          }
        } else if (event.value === "repo_removed") {
          // A scan root was removed, the owner removed this repo, or — on an all-repos share link —
          // they hid it and it left this viewer's scope (src/share/events.ts translates the hide
          // into exactly this event). Drop the card live, and take the file viewer with it if it
          // was open on that repo: the drawer would otherwise sit there looking live while every
          // call it makes 404s against a repo this session can no longer reach.
          if (payload.id) {
            repos.value = repos.value.filter((r) => r.id !== payload.id);
            clearRepoCaches(payload.id);
            reconcileBehindNotification(payload.id, 0);
            dismissViewerForRepo(payload.id);
          }
        } else if (event.value === "repo_renamed") {
          // Renamed on another device — adopt the new label live.
          patchRepo(payload.id, { displayName: payload.displayName ?? null });
        } else if (event.value === "repo_identity_changed")
          patchRepo(payload.id, { identityId: payload.identityId });
        else if (event.value === "identity_rules_changed") {
          // Another tab/device edited the rules — adopt the fresh list live.
          if (Array.isArray(payload.rules)) identityRules.value = payload.rules;
        } else if (event.value === "repo_account_changed")
          patchRepo(payload.id, {
            syncAccountHost: payload.syncAccountHost ?? null,
            syncAccountLogin: payload.syncAccountLogin ?? null,
          });
        else if (event.value === "repo_hidden_changed")
          patchRepo(payload.id, { hidden: !!payload.hidden });
        else if (event.value === "repo_pinned_changed")
          patchRepo(payload.id, { pinned: !!payload.pinned });
        else if (event.value === "repo_starred_changed")
          patchRepo(payload.id, { starred: !!payload.starred });
        else if (event.value === "repo_auto_commit_changed")
          patchRepo(payload.id, { autoCommit: !!payload.autoCommit });
        else if (event.value === "repo_behind") {
          // The background sync check found repos with new remote commits → warn (toast +
          // opt-in OS notification). The amber card state arrives separately via repo_state_changed.
          notifyBehind((payload.repos as BehindRepo[] | undefined) ?? []);
        } else if (event.value === "repo_synced") {
          // "Keep in sync" auto-pulled these — quiet confirmation (the cards already updated).
          const synced = (payload.repos as SyncedRepo[] | undefined) ?? [];
          for (const repo of synced) {
            if (repo.pulled > 0) bumpHistoryRevision(repo.id);
          }
          notifySynced(synced);
        } else if (event.value === "repo_auto_committed") {
          // The auto-commit timer committed (and maybe synced) these — quiet success toast.
          const committed = (payload.repos as AutoCommittedRepo[] | undefined) ?? [];
          for (const repo of committed) {
            if (repo.commits > 0) bumpHistoryRevision(repo.id);
          }
          notifyAutoCommitted(committed);
        } else if (event.value === "repo_auto_commit_blocked") {
          // The auto-commit timer skipped these (conflict / mid-operation / failed sync) → warn.
          notifyAutoCommitBlocked((payload.repos as AutoCommitBlockedRepo[] | undefined) ?? []);
        } else if (event.value === "update_available") {
          // The scheduled check found a newer build. This NEVER installs anything on its own
          // (that's the separate, opt-in `autoUpdate`) — it surfaces the offer and lets the
          // owner decide, which is the whole point of the notify/apply split.
          notifyUpdateAvailable({
            canApply: payload.canApply !== false,
            reason: typeof payload.reason === "string" ? payload.reason : null,
          });
        } else if (event.value === "daemon_status") {
          // daemon_status is a PATCH, not a snapshot. The relay announces after the tunnel comes
          // up and emits only relay fields; treating an absent tunnelUrl as null erased the healthy
          // quick-tunnel URL and left the UI spinning forever.
          if (payload.tunnelUrl !== undefined) {
            tunnelUrl.value = typeof payload.tunnelUrl === "string" ? payload.tunnelUrl : null;
          }
          if (typeof payload.tunnelActive === "boolean") tunnelActive.value = payload.tunnelActive;
          // A tunnel that came up or went away re-announces (or invalidates) the permanent link,
          // so the relay's registered state rides the same event rather than needing a poll.
          if (payload.relayUrl !== undefined) relayUrl.value = (payload.relayUrl as string | null) ?? null;
          if (typeof payload.relayAnnounced === "boolean") relayAnnounced.value = payload.relayAnnounced;
          if (payload.relayError !== undefined) {
            relayError.value =
              typeof payload.relayError === "string" ? payload.relayError : null;
          }
          if (payload.relay) relayConfig.value = payload.relay as RelayStatus;
        } else if (event.value === "settings_changed") {
          if (typeof payload.diffStats === "boolean") diffStatsEnabled.value = payload.diffStats;
          if (payload.changesStatDisplay === "numbers" || payload.changesStatDisplay === "bars") {
            changesStatDisplay.value = payload.changesStatDisplay;
          }
          if (typeof payload.changesChars === "boolean") changesCharsEnabled.value = payload.changesChars;
          if (typeof payload.remoteEditing === "boolean") remoteEditing.value = payload.remoteEditing;
          if (typeof payload.diffPatchBytes === "number") diffPatchBytes.value = payload.diffPatchBytes;
          if (typeof payload.diffPatchEnabled === "boolean") diffPatchEnabled.value = payload.diffPatchEnabled;
          if (typeof payload.syncCheck === "boolean") syncCheckEnabled.value = payload.syncCheck;
          if (typeof payload.syncIntervalSecs === "number") syncIntervalSecs.value = payload.syncIntervalSecs;
          if (typeof payload.keepInSync === "boolean") keepInSync.value = payload.keepInSync;
          if (typeof payload.autoCommit === "boolean") autoCommit.value = payload.autoCommit;
          if (typeof payload.autoUpdate === "boolean") autoUpdate.value = payload.autoUpdate;
          if (typeof payload.updateNotify === "boolean") updateNotify.value = payload.updateNotify;
          if (payload.autoCommitMode === "interval" || payload.autoCommitMode === "daily")
            autoCommitMode.value = payload.autoCommitMode;
          if (typeof payload.autoCommitIntervalSecs === "number")
            autoCommitIntervalSecs.value = payload.autoCommitIntervalSecs;
          if (typeof payload.autoCommitAt === "string") autoCommitAt.value = payload.autoCommitAt;
          if (typeof payload.autoCommitPull === "boolean") autoCommitPull.value = payload.autoCommitPull;
          if (typeof payload.autoCommitPush === "boolean") autoCommitPush.value = payload.autoCommitPush;
          if (payload.autoCommitAiFallback === "skip" || payload.autoCommitAiFallback === "basic")
            autoCommitAiFallback.value = payload.autoCommitAiFallback;
          if (typeof payload.autoScan === "boolean") autoScan.value = payload.autoScan;
          if (typeof payload.loreServersEnabled === "boolean") loreServersEnabled.value = payload.loreServersEnabled;
          if (typeof payload.portableMode === "boolean") portableMode.value = payload.portableMode;
          if (typeof payload.hideTrayIcon === "boolean") hideTrayIcon.value = payload.hideTrayIcon;
          if (typeof payload.mcpApprovalGate === "boolean") mcpApprovalGate.value = payload.mcpApprovalGate;
          if (typeof payload.mcpApprovalTimeoutSecs === "number")
            mcpApprovalTimeoutSecs.value = payload.mcpApprovalTimeoutSecs;
          if (typeof payload.mcpAutoDeny === "boolean") mcpAutoDeny.value = payload.mcpAutoDeny;
          if (typeof payload.mcpAutoApprove === "boolean") mcpAutoApprove.value = payload.mcpAutoApprove;
          if (typeof payload.mcpAutoApproveTimeoutSecs === "number")
            mcpAutoApproveTimeoutSecs.value = payload.mcpAutoApproveTimeoutSecs;
          // defaultEditor is broadcast as string|null (present only when it changed) — a null is
          // a legitimate "cleared" value, so gate on the key existing, not on truthiness.
          if (payload.defaultEditor !== undefined) {
            defaultEditor.value = (payload.defaultEditor as string | null) ?? null;
            // The stored pref just changed elsewhere (another tab/device) → the resolved
            // effectiveEditor (drives the Open-with dropdown's "current default" check) is now
            // stale. Re-fetch the catalogue, but only for a tab that already uses it.
            if (editorsLoaded.value) void loadEditors(true);
          }
          if (payload.tunnel) tunnelConfig.value = payload.tunnel as TunnelStatus;
          if (payload.relay) relayConfig.value = payload.relay as RelayStatus;
          // The daemon applied a pulled cloud-sync doc (possibly from another device) — re-fetch
          // status and re-apply the synced appearance (loadSyncStatus applies it internally).
          if (payload.cloudSync) void loadSyncStatus();
        } else if (event.value === "approval_pending") {
          // A headless agent's mutating MCP call is now awaiting owner approve/deny.
          addPendingApproval(payload as PendingApproval);
        } else if (event.value === "approval_resolved") {
          // Approved/denied/timed out — elsewhere (another tab) or by the auto-deny/approve timer.
          removePendingApproval(payload.id);
        } else if (event.value === "collaboration_snapshots_changed") {
          // Snapshot arrival and expiry are daemon events. This replaces a 2.5s HTTP poll in
          // every open tab while still removing a peer promptly when its heartbeat expires.
          if (Array.isArray(payload.snapshots))
            collaborationSnapshots.value = payload.snapshots as CollaborationSnapshot[];
        } else if (event.value === "ai_key_invalid") {
          // The startup key-liveness check found a configured AI provider's key was rejected.
          notifyAiKeyInvalid(
            typeof payload.label === "string" && payload.label ? payload.label : String(payload.provider ?? ""),
          );
        } else if (event.value === "scan_started") {
          // A rescan began (from the modal, or another device) — reset the live counters.
          scanning.value = true;
          scanDone.value = false;
          lastScanCancelled.value = false;
          scanFound.value = 0;
          scanNew.value = 0;
          scanNewRepos.value = [];
          collectingScanRepos.value = true;
        } else if (event.value === "scan_progress") {
          if (typeof payload.found === "number") scanFound.value = payload.found;
          if (typeof payload.added === "number") scanNew.value = payload.added;
        } else if (event.value === "scan_done" || event.value === "scan_cancelled") {
          // Force in whatever `repo_added` events are still sitting in the insert buffer — the
          // scan can finish between animation frames, and the summary/review list below reads
          // straight off `repos.value`/`scanNewRepos`, which must already reflect every find.
          flushPendingRepoInserts();
          scanning.value = false;
          scanDone.value = true;
          collectingScanRepos.value = false;
          lastScanCancelled.value = event.value === "scan_cancelled";
          if (typeof payload.found === "number") scanFound.value = payload.found;
          if (typeof payload.added === "number") scanNew.value = payload.added;
          // Surface genuinely-new projects even if the scan was stopped early.
          if (typeof payload.added === "number") notifyNewProjects(payload.added);
        }
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
    checkForUpdate,
    applyUpdate,
    recordPulse,
    busy,
    historyRevisionByRepo,
    bumpHistoryRevision,
    changesByRepo,
    changesLoading,
    changesMeta,
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
    scanNewRepos,
    scanReturnToAdd,
    dropScanNewRepo,
    startScan,
    cancelScan,
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
    fetchAll,
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
    genCommitMessage,
    genCommitPlan,
    smartCommit,
    listConflicts,
    readConflict,
    resolveConflict,
    applyConflict,
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
    setRemoteEditing,
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
