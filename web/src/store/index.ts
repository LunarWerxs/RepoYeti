import { defineStore } from "pinia";
import { ref, reactive, watch } from "vue";
import { useEventSource } from "@vueuse/core";
import { api, ApiError, type AccessMode, type TunnelStatus } from "../api";
import type { ActionName, ActionResult, Repo, UpdateApplyResult, UpdateStatus } from "../types";
import { useSelfUpdate } from "@/lib/useSelfUpdate";
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
  const loading = ref(true);
  const connected = ref(false);
  const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate } =
    useSelfUpdate<UpdateStatus, UpdateApplyResult>(api);

  /** repoId → the action currently in flight (drives per-button loading state). */
  const busy = reactive<Record<string, ActionName | undefined>>({});

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
  // Access mode + local/remote auth state (see /api/auth/status).
  const mode = ref<AccessMode>("local");

  // Owner setting: show added/removed line + char counts per file and per repo. Sourced
  // from /api/status and kept live via the `settings_changed` SSE event. Off by default.
  const diffStatsEnabled = ref(false);
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
  // behind its remote. From /api/status, kept live via `settings_changed`; on until status loads.
  const syncCheckEnabled = ref(true);
  // How often that background check runs, in seconds. From /api/status; 120 until status loads.
  const syncIntervalSecs = ref(120);
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
  // Owner setting: sweep the whole machine for repos on every app start. From /api/status,
  // kept live via `settings_changed`; off until status loads (opt-in) — see AppShell.vue's
  // scheduleIdle(() => autoScan && startScan()) on mount.
  const autoScan = ref(false);

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

  /** Normalise any thrown ApiError into the structured {ok,code,message} the UI toasts. */
  function asResult(e: unknown): ActionResult {
    if (e instanceof ApiError) return { ok: false, code: e.code ?? "ERROR", message: e.message };
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
    visibleRepos,
    pinnedRepos,
    starredRepos,
    otherRepos,
    patchRepo,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    setHidden,
    setPinned,
    setStarred,
    setAutoCommit: setRepoAutoCommit,
  } = useRepoActions(repos, busy, asResult);

  const {
    aiSettings,
    aiCatalog,
    aiReady,
    aiEnabled,
    loadAiSettings,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setStyle,
    removeProvider,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
  } = useAi(busy, loadChanges, asResult);

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
    createTag,
    setRemote,
    removeRemote,
    stashSave,
    stashPop,
    stashDrop,
    discardFile,
  } = useGitOps(loadChanges, asResult);

  const {
    roots,
    servers,
    fetchingAll,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    startScan,
    cancelScan,
    loadServers,
    addServer,
    removeServer,
    cloneFromServer,
    fetchAll,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
  } = useSources(repos, scanning, scanFound, scanNew, scanDone, lastScanCancelled);

  const {
    identities,
    detectedIdentities,
    detectedIdentitiesLoading,
    detectedIdentitiesReady,
    identityById,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
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
    ownerClaimed,
    canContinueLocal,
    localBypass,
    loadAuth,
    continueLocal,
    setMode,
    setTunnel,
    logout,
    setDiffStats,
    setRemoteEditing,
    setDiffPatchBytes,
    setDiffPatchEnabled,
    setSyncCheck,
    setSyncInterval,
    setKeepInSync,
    setAutoCommit,
    setAutoCommitMode,
    setAutoCommitInterval,
    setAutoCommitAt,
    setAutoCommitPull,
    setAutoCommitPush,
    setAutoScan,
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
    notifyBehind,
    notifySynced,
    notifyAutoCommitted,
    notifyAutoCommitBlocked,
    notifyNewProjects,
  } = useSettings({
    mode,
    tunnelActive,
    tunnelUrl,
    tunnelConfig,
    diffStatsEnabled,
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
    autoScan,
  });

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [r, i] = await Promise.all([
        api.listRepos(),
        api.listIdentities(),
        loadAiSettings(),
        loadAiCatalog(),
        loadStatus(),
        loadAccounts(), // best-effort — populates the header account switcher on boot
      ]);
      repos.value = r;
      identities.value = i;
    } finally {
      loading.value = false;
      if (!appOpenedPulsed) {
        appOpenedPulsed = true;
        void recordPulse("app_opened");
      }
      void checkForUpdate();
    }
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
      diffStatsEnabled.value = s.diffStats;
      remoteEditing.value = s.remoteEditing;
      diffPatchBytes.value = s.diffPatchBytes ?? 512 * 1024;
      diffPatchEnabled.value = s.diffPatchEnabled ?? true;
      syncCheckEnabled.value = s.syncCheck ?? true;
      syncIntervalSecs.value = s.syncIntervalSecs ?? 120;
      keepInSync.value = s.keepInSync ?? false;
      autoCommit.value = s.autoCommit ?? false;
      autoCommitMode.value = s.autoCommitMode ?? "interval";
      autoCommitIntervalSecs.value = s.autoCommitIntervalSecs ?? 900;
      autoCommitAt.value = s.autoCommitAt ?? "18:00";
      autoCommitPull.value = s.autoCommitPull ?? true;
      autoCommitPush.value = s.autoCommitPush ?? true;
      autoScan.value = s.autoScan ?? false;
      contentSearchMin.value = s.minContentSearch ?? 3;
    } catch {
      /* status is optional — leave whatever we have */
    }
  }

  // ── live updates (SSE) ──────────────────────────────────────────────────────
  function connect(): void {
    const { status, event, data } = useEventSource(
      "/api/events",
      [
        "hello",
        "ping",
        "repo_state_changed",
        "repo_added",
        "repo_removed",
        "repo_identity_changed",
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
      ],
      { autoReconnect: { retries: -1, delay: 2500 } },
    );
    watch(status, (s) => (connected.value = s === "OPEN"));
    watch(data, (raw) => {
      if (!raw || !event.value) return;
      try {
        const payload = JSON.parse(raw);
        if (event.value === "repo_state_changed") patchRepo(payload.id, { status: payload.status });
        else if (event.value === "repo_added") {
          // Background discovery found a repo after boot — append it (or refresh in place).
          const repo = payload.repo as Repo | undefined;
          if (repo?.id) {
            const idx = repos.value.findIndex((r) => r.id === repo.id);
            if (idx >= 0) repos.value[idx] = repo;
            else repos.value.push(repo);
          }
        } else if (event.value === "repo_removed") {
          // A scan root was removed → its auto repos are forgotten. Drop the card live.
          if (payload.id) repos.value = repos.value.filter((r) => r.id !== payload.id);
        } else if (event.value === "repo_identity_changed")
          patchRepo(payload.id, { identityId: payload.identityId });
        else if (event.value === "repo_account_changed")
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
          notifySynced((payload.repos as SyncedRepo[] | undefined) ?? []);
        } else if (event.value === "repo_auto_committed") {
          // The auto-commit timer committed (and maybe synced) these — quiet success toast.
          notifyAutoCommitted((payload.repos as AutoCommittedRepo[] | undefined) ?? []);
        } else if (event.value === "repo_auto_commit_blocked") {
          // The auto-commit timer skipped these (conflict / mid-operation / failed sync) → warn.
          notifyAutoCommitBlocked((payload.repos as AutoCommitBlockedRepo[] | undefined) ?? []);
        } else if (event.value === "daemon_status") {
          tunnelUrl.value = typeof payload.tunnelUrl === "string" ? payload.tunnelUrl : null;
          if (typeof payload.tunnelActive === "boolean") tunnelActive.value = payload.tunnelActive;
        } else if (event.value === "settings_changed") {
          if (typeof payload.diffStats === "boolean") diffStatsEnabled.value = payload.diffStats;
          if (typeof payload.remoteEditing === "boolean") remoteEditing.value = payload.remoteEditing;
          if (typeof payload.diffPatchBytes === "number") diffPatchBytes.value = payload.diffPatchBytes;
          if (typeof payload.diffPatchEnabled === "boolean") diffPatchEnabled.value = payload.diffPatchEnabled;
          if (typeof payload.syncCheck === "boolean") syncCheckEnabled.value = payload.syncCheck;
          if (typeof payload.syncIntervalSecs === "number") syncIntervalSecs.value = payload.syncIntervalSecs;
          if (typeof payload.keepInSync === "boolean") keepInSync.value = payload.keepInSync;
          if (typeof payload.autoCommit === "boolean") autoCommit.value = payload.autoCommit;
          if (payload.autoCommitMode === "interval" || payload.autoCommitMode === "daily")
            autoCommitMode.value = payload.autoCommitMode;
          if (typeof payload.autoCommitIntervalSecs === "number")
            autoCommitIntervalSecs.value = payload.autoCommitIntervalSecs;
          if (typeof payload.autoCommitAt === "string") autoCommitAt.value = payload.autoCommitAt;
          if (typeof payload.autoCommitPull === "boolean") autoCommitPull.value = payload.autoCommitPull;
          if (typeof payload.autoCommitPush === "boolean") autoCommitPush.value = payload.autoCommitPush;
          if (typeof payload.autoScan === "boolean") autoScan.value = payload.autoScan;
          if (payload.tunnel) tunnelConfig.value = payload.tunnel as TunnelStatus;
        } else if (event.value === "scan_started") {
          // A rescan began (from the modal, or another device) — reset the live counters.
          scanning.value = true;
          scanDone.value = false;
          lastScanCancelled.value = false;
          scanFound.value = 0;
          scanNew.value = 0;
        } else if (event.value === "scan_progress") {
          if (typeof payload.found === "number") scanFound.value = payload.found;
          if (typeof payload.added === "number") scanNew.value = payload.added;
        } else if (event.value === "scan_done" || event.value === "scan_cancelled") {
          scanning.value = false;
          scanDone.value = true;
          lastScanCancelled.value = event.value === "scan_cancelled";
          if (typeof payload.found === "number") scanFound.value = payload.found;
          if (typeof payload.added === "number") scanNew.value = payload.added;
          // Surface genuinely-new projects even if the scan was stopped early.
          if (typeof payload.added === "number") notifyNewProjects(payload.added);
        }
      } catch {
        /* ignore malformed frame */
      }
    });
  }

  return {
    repos,
    identities,
    detectedIdentities,
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
    createTag,
    setRemote,
    removeRemote,
    stashSave,
    stashPop,
    stashDrop,
    discardFile,
    roots,
    servers,
    fetchingAll,
    loadRoots,
    addScanRoot,
    removeScanRoot,
    scanOpen,
    scanning,
    scanFound,
    scanNew,
    scanDone,
    lastScanCancelled,
    startScan,
    cancelScan,
    loadServers,
    addServer,
    removeServer,
    cloneFromServer,
    fetchAll,
    shutdown,
    logoutAll,
    aiSettings,
    aiCatalog,
    aiReady,
    aiEnabled,
    loadAiSettings,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setStyle,
    removeProvider,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
    authReady,
    authEnforced,
    authenticated,
    owner,
    mode,
    ownerClaimed,
    canContinueLocal,
    localBypass,
    continueLocal,
    setMode,
    setTunnel,
    identityById,
    tunnelUrl,
    tunnelActive,
    tunnelConfig,
    diffStatsEnabled,
    contentSearchMin,
    setDiffStats,
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
    setAutoCommit,
    setAutoCommitMode,
    setAutoCommitInterval,
    setAutoCommitAt,
    setAutoCommitPull,
    setAutoCommitPush,
    setRepoAutoCommit,
    autoScan,
    setAutoScan,
    notifications,
    unreadCount,
    markNotificationsRead,
    dismissNotification,
    clearNotifications,
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
    visibleRepos,
    pinnedRepos,
    starredRepos,
    otherRepos,
    setHidden,
    setPinned,
    setStarred,
    loadAuth,
    logout,
    loadAll,
    connect,
    doAction,
    commit,
    commitSelected,
    assignIdentity,
    assignRepoAccount,
    addRepo,
    persistRepoOrder,
    createIdentity,
    updateIdentity,
    removeIdentity,
    loadDetectedIdentities,
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
