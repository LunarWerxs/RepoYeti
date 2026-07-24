import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useEventSource } from "@vueuse/core";
import { api, ApiError, type AccessMode, type TunnelStatus, type RelayStatus } from "../api";
import type {
  ActionName,
  ActionResult,
  Identity,
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
    sortMode,
    setSortMode,
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
    renameRepo,
    removeRepo,
    restoreRemovedRepo,
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
    aiUsable,
    aiCommitEnabled,
    loadAiSettings,
    loadAiAvailability,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setCommitEnabled,
    setStyle,
    setDiffDetail,
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
    stageFile,
    moveFile,
    addToGitignore,
  } = useGitOps(loadChanges, asResult);

  const {
    roots,
    servers,
    loreServersEnabled,
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
    fetchAll,
    cleanupMissingRepos,
    shutdown,
    logoutAll,
    addRepo,
    cloneRepo,
    persistRepoOrder,
  } = useSources(repos, scanning, scanFound, scanNew, scanDone, lastScanCancelled);

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
    continueLocal,
    setMode,
    setTunnel,
    setRelay,
    logout,
    leaveShare,
    setDiffStats,
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
  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const guest = isGuest.value;
      const [r, i] = await Promise.all([
        api.listRepos(),
        guest ? Promise.resolve([] as Identity[]) : api.listIdentities(),
        guest ? loadAiAvailability() : loadAiSettings(),
        guest ? Promise.resolve() : loadAiCatalog(),
        loadStatus(),
        guest ? Promise.resolve() : loadAccounts(), // best-effort — populates the header account switcher on boot
        guest ? Promise.resolve() : loadSyncStatus(), // best-effort — applies any synced appearance on boot
        guest ? Promise.resolve() : loadApprovals(), // best-effort — hydrates any already-pending MCP approvals on boot
        guest ? Promise.resolve() : loadIdentityRules(), // best-effort — hydrates the Identity Firewall rules on boot
      ]);
      repos.value = r;
      identities.value = i;
    } finally {
      loading.value = false;
      if (!appOpenedPulsed && !isGuest.value) {
        appOpenedPulsed = true;
        void recordPulse("app_opened"); // owner-only telemetry; a guest is 403'd on /api/pulse
      }
      if (!isGuest.value) void checkForUpdate(); // owner-only: /api/updates
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
      if (s.relay) relayConfig.value = s.relay;
      relayUrl.value = s.relayUrl ?? null;
      relayAnnounced.value = s.relayAnnounced === true;
      relayError.value = s.relayError ?? null;
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
  function connect(): void {
    void loadCollaborations();
    const { status, event, data } = useEventSource(
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
      ],
      { autoReconnect: { retries: -1, delay: 2500 } },
    );
    watch(status, (s) => (connected.value = s === "OPEN"));
    watch(data, (raw) => {
      if (!raw || !event.value) return;
      try {
        const payload = JSON.parse(raw);
        if (event.value === "repo_state_changed") {
          patchRepo(payload.id, { status: payload.status });
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
          // Background discovery found a repo after boot — append it (or refresh in place).
          const repo = payload.repo as Repo | undefined;
          if (repo?.id) {
            const idx = repos.value.findIndex((r) => r.id === repo.id);
            if (idx >= 0) repos.value[idx] = repo;
            else repos.value.push(repo);
          }
        } else if (event.value === "repo_removed") {
          // A scan root was removed, the owner removed this repo, or — on an all-repos share link —
          // they hid it and it left this viewer's scope (src/share/events.ts translates the hide
          // into exactly this event). Drop the card live, and take the file viewer with it if it
          // was open on that repo: the drawer would otherwise sit there looking live while every
          // call it makes 404s against a repo this session can no longer reach.
          if (payload.id) {
            repos.value = repos.value.filter((r) => r.id !== payload.id);
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
          notifySynced((payload.repos as SyncedRepo[] | undefined) ?? []);
        } else if (event.value === "repo_auto_committed") {
          // The auto-commit timer committed (and maybe synced) these — quiet success toast.
          notifyAutoCommitted((payload.repos as AutoCommittedRepo[] | undefined) ?? []);
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
    stageFile,
    moveFile,
    addToGitignore,
    roots,
    servers,
    loreServersEnabled,
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
    setLoreServersEnabled,
    cloneFromServer,
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
    loadAiSettings,
    loadAiAvailability,
    loadAiCatalog,
    connectProvider,
    listProviderModels,
    selectModel,
    setDefaultProvider,
    setYolo,
    setCommitEnabled,
    setStyle,
    setDiffDetail,
    removeProvider,
    genCommitMessage,
    genCommitPlan,
    smartCommit,
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
