import { ref, reactive, type Ref } from "vue";
import {
  api,
  type AccessMode,
  type TunnelStatus,
  type EditorInfo,
  type OpenResult,
} from "../api";
import type { PendingApproval } from "../types";
import { useSettingsCloudSync } from "./settings-cloud-sync.ts";
import { useSettingsNotifications } from "./settings-notifications.ts";

/** One repo that just fell further behind its remote (the `repo_behind` SSE payload). */
export interface BehindRepo {
  id: string;
  name: string;
  branch: string | null;
  behind: number;
}

/** One repo "keep in sync" just auto fast-forwarded (the `repo_synced` SSE payload). */
export interface SyncedRepo {
  id: string;
  name: string;
  pulled: number;
}

/** One repo the auto-commit timer just committed (the `repo_auto_committed` SSE payload). */
export interface AutoCommittedRepo {
  id: string;
  name: string;
  commits: number;
  pulled: boolean;
  pushed: boolean;
  note?: string;
}

/** One repo the auto-commit timer refused to touch (the `repo_auto_commit_blocked` SSE payload). */
export interface AutoCommitBlockedRepo {
  id: string;
  name: string;
  reason: string;
}

/**
 * Auth/access-mode flow, owner-configurable daemon settings toggles, and the notifications
 * (desktop opt-in + header bell + toast/OS-notification helpers) those settings drive. The
 * mode/tunnel/settings refs themselves are owned by the barrel — the `connect()` SSE handler
 * and `loadStatus()` also write them directly — so they're passed in here.
 */
export function useSettings(deps: {
  mode: Ref<AccessMode>;
  tunnelActive: Ref<boolean>;
  tunnelUrl: Ref<string | null>;
  tunnelConfig: Ref<TunnelStatus>;
  diffStatsEnabled: Ref<boolean>;
  remoteEditing: Ref<boolean>;
  diffPatchBytes: Ref<number>;
  diffPatchEnabled: Ref<boolean>;
  syncCheckEnabled: Ref<boolean>;
  syncIntervalSecs: Ref<number>;
  keepInSync: Ref<boolean>;
  autoCommit: Ref<boolean>;
  autoCommitMode: Ref<"interval" | "daily">;
  autoCommitIntervalSecs: Ref<number>;
  autoCommitAt: Ref<string>;
  autoCommitPull: Ref<boolean>;
  autoCommitPush: Ref<boolean>;
  autoUpdate: Ref<boolean>;
  autoScan: Ref<boolean>;
  mcpApprovalGate: Ref<boolean>;
  mcpApprovalTimeoutSecs: Ref<number>;
  defaultEditor: Ref<string | null>;
}) {
  const {
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
    autoUpdate,
    autoScan,
    mcpApprovalGate,
    mcpApprovalTimeoutSecs,
    defaultEditor,
  } = deps;

  // auth
  const authReady = ref(false);
  const authEnforced = ref(false);
  const authenticated = ref(true);
  const owner = ref<string | null>(null);
  const ownerPicture = ref<string | null>(null);
  // Access mode + local/remote auth state (see /api/auth/status).
  const ownerClaimed = ref(false);
  const canContinueLocal = ref(true);
  const localBypass = ref(false);

  async function loadAuth(): Promise<void> {
    try {
      const s = await api.authStatus();
      authEnforced.value = s.authEnforced;
      authenticated.value = s.authenticated;
      owner.value = s.owner;
      ownerPicture.value = s.ownerPicture;
      mode.value = s.mode;
      ownerClaimed.value = s.ownerClaimed;
      canContinueLocal.value = s.canContinueLocal;
      localBypass.value = s.localBypass;
    } catch {
      // status endpoint unreachable — treat as open so we still try to load
      authEnforced.value = false;
      authenticated.value = true;
      mode.value = "local";
      localBypass.value = false;
    } finally {
      authReady.value = true;
    }
  }
  /** Grant the localhost-only bypass, then reload into the dashboard. */
  async function continueLocal(): Promise<void> {
    await api.continueLocal();
    localBypass.value = true;
    location.reload();
  }
  /** Flip local ↔ remote. Throws ApiError "NEEDS_OWNER" so the caller can send the
   *  owner through sign-in first; otherwise updates mode + tunnel state in place. */
  async function setMode(next: AccessMode): Promise<void> {
    const r = await api.setMode(next);
    mode.value = r.mode;
    tunnelActive.value = r.tunnelActive;
    tunnelUrl.value = r.tunnelUrl;
  }
  /** Configure the stable named tunnel (hostname + connector token). Token is write-only — pass
   *  "" to clear a field, omit it to keep the saved one. Throws ApiError → the caller toasts. */
  async function setTunnel(input: { hostname?: string; token?: string }): Promise<void> {
    const r = await api.setTunnel(input);
    tunnelConfig.value = r.tunnel;
    tunnelActive.value = r.tunnelActive;
    tunnelUrl.value = r.tunnelUrl;
  }
  async function logout(): Promise<void> {
    await api.logout();
    location.reload();
  }

  /** Toggle the diff-stats setting (optimistic; rolls back on failure). */
  async function setDiffStats(enabled: boolean): Promise<void> {
    diffStatsEnabled.value = enabled;
    try {
      await api.setDiffStats(enabled);
    } catch (e) {
      diffStatsEnabled.value = !enabled; // roll back
      throw e;
    }
  }

  /** Toggle editing over remote access (optimistic; rolls back on failure). */
  async function setRemoteEditing(enabled: boolean): Promise<void> {
    remoteEditing.value = enabled;
    try {
      await api.setRemoteEditing(enabled);
    } catch (e) {
      remoteEditing.value = !enabled; // roll back
      throw e;
    }
  }

  /** Set the large-file diff threshold in bytes (optimistic; adopts the server's clamped
   *  value on success, rolls back on failure). */
  async function setDiffPatchBytes(bytes: number): Promise<void> {
    const prev = diffPatchBytes.value;
    diffPatchBytes.value = bytes;
    try {
      const r = await api.setDiffPatchBytes(bytes);
      diffPatchBytes.value = r.diffPatchBytes;
    } catch (e) {
      diffPatchBytes.value = prev; // roll back
      throw e;
    }
  }

  /** Toggle compact patch mode for large files (optimistic; rolls back on failure).
   *  false = always side-by-side. */
  async function setDiffPatchEnabled(enabled: boolean): Promise<void> {
    diffPatchEnabled.value = enabled;
    try {
      await api.setDiffPatchEnabled(enabled);
    } catch (e) {
      diffPatchEnabled.value = !enabled; // roll back
      throw e;
    }
  }

  // ── background remote-sync check + behind notifications ───────────────────────
  /** Toggle the background sync check (optimistic; rolls back on failure). */
  async function setSyncCheck(enabled: boolean): Promise<void> {
    syncCheckEnabled.value = enabled;
    try {
      await api.setSyncCheck(enabled);
    } catch (e) {
      syncCheckEnabled.value = !enabled; // roll back
      throw e;
    }
  }

  /** Set the sync-check cadence in seconds (optimistic; adopts the server's clamped value). */
  async function setSyncInterval(secs: number): Promise<void> {
    const prev = syncIntervalSecs.value;
    syncIntervalSecs.value = secs;
    try {
      const r = await api.setSyncInterval(secs);
      syncIntervalSecs.value = r.syncIntervalSecs;
    } catch (e) {
      syncIntervalSecs.value = prev; // roll back
      throw e;
    }
  }

  /** Toggle "keep in sync" auto fast-forward (optimistic; rolls back on failure). */
  async function setKeepInSync(enabled: boolean): Promise<void> {
    keepInSync.value = enabled;
    try {
      await api.setKeepInSync(enabled);
    } catch (e) {
      keepInSync.value = !enabled; // roll back
      throw e;
    }
  }

  // ── auto-commit timer settings (all optimistic; roll back on failure) ─────────
  async function setAutoCommit(enabled: boolean): Promise<void> {
    autoCommit.value = enabled;
    try {
      await api.setAutoCommit(enabled);
    } catch (e) {
      autoCommit.value = !enabled; // roll back
      throw e;
    }
  }
  async function setAutoCommitMode(next: "interval" | "daily"): Promise<void> {
    const prev = autoCommitMode.value;
    autoCommitMode.value = next;
    try {
      await api.setAutoCommitMode(next);
    } catch (e) {
      autoCommitMode.value = prev; // roll back
      throw e;
    }
  }
  async function setAutoCommitInterval(secs: number): Promise<void> {
    const prev = autoCommitIntervalSecs.value;
    autoCommitIntervalSecs.value = secs;
    try {
      const r = await api.setAutoCommitInterval(secs);
      autoCommitIntervalSecs.value = r.autoCommitIntervalSecs; // adopt the server's clamped value
    } catch (e) {
      autoCommitIntervalSecs.value = prev; // roll back
      throw e;
    }
  }
  async function setAutoCommitAt(at: string): Promise<void> {
    const prev = autoCommitAt.value;
    autoCommitAt.value = at;
    try {
      const r = await api.setAutoCommitAt(at);
      autoCommitAt.value = r.autoCommitAt; // adopt the server's normalised value
    } catch (e) {
      autoCommitAt.value = prev; // roll back
      throw e;
    }
  }
  async function setAutoCommitPull(enabled: boolean): Promise<void> {
    autoCommitPull.value = enabled;
    try {
      await api.setAutoCommitPull(enabled);
    } catch (e) {
      autoCommitPull.value = !enabled; // roll back
      throw e;
    }
  }
  async function setAutoCommitPush(enabled: boolean): Promise<void> {
    autoCommitPush.value = enabled;
    try {
      await api.setAutoCommitPush(enabled);
    } catch (e) {
      autoCommitPush.value = !enabled; // roll back
      throw e;
    }
  }

  /** Toggle auto-scanning the whole machine on every app start (optimistic; rolls back). */
  async function setAutoScan(enabled: boolean): Promise<void> {
    autoScan.value = enabled;
    try {
      await api.setAutoScan(enabled);
    } catch (e) {
      autoScan.value = !enabled; // roll back
      throw e;
    }
  }

  /** Toggle silent auto-update + restart of the app (optimistic; rolls back on failure). */
  async function setAutoUpdate(enabled: boolean): Promise<void> {
    autoUpdate.value = enabled;
    try {
      await api.setAutoUpdate(enabled);
    } catch (e) {
      autoUpdate.value = !enabled; // roll back
      throw e;
    }
  }

  // ── ⭐ Agent Safety Rail (all optimistic; roll back on failure) ────────────────
  /** Toggle whether mutating MCP tool calls are gated behind owner approve/deny. */
  async function setMcpApprovalGate(enabled: boolean): Promise<void> {
    mcpApprovalGate.value = enabled;
    try {
      await api.setMcpApprovalGate(enabled);
    } catch (e) {
      mcpApprovalGate.value = !enabled; // roll back
      throw e;
    }
  }
  /** Set the auto-deny timeout in seconds (adopts the server's clamped value). */
  async function setMcpApprovalTimeoutSecs(secs: number): Promise<void> {
    const prev = mcpApprovalTimeoutSecs.value;
    mcpApprovalTimeoutSecs.value = secs;
    try {
      const r = await api.setMcpApprovalTimeoutSecs(secs);
      mcpApprovalTimeoutSecs.value = r.mcpApprovalTimeoutSecs;
    } catch (e) {
      mcpApprovalTimeoutSecs.value = prev; // roll back
      throw e;
    }
  }

  // ── "Open with…" external editors (loopback-only convenience) ─────────────────
  // The detected editor catalogue for this machine (from GET /api/editors). Loaded lazily the
  // first time the file viewer / Settings needs it; `defaultEditor` (the stored pref) rides the
  // normal settings hydration + `settings_changed` SSE like every other owner setting.
  const editorsCatalog = ref<EditorInfo[]>([]);
  const editorsPlatform = ref("");
  const effectiveEditor = ref(""); // the id the Open-with button actually launches
  const editorsLoaded = ref(false);
  const editorsLoading = ref(false);
  let editorsRefreshPending = false; // a force-refresh requested while a load was already in flight

  /** Fetch the editor catalogue (best-effort). No-ops after the first success unless `force` is set
   *  (e.g. the default changed, or an editor was installed). A `force` that arrives while a load is
   *  already in flight is deferred and re-run once that load settles — so it never silently drops. */
  async function loadEditors(force = false): Promise<void> {
    if (editorsLoading.value) {
      if (force) editorsRefreshPending = true; // coalesce into a single follow-up after this load
      return;
    }
    if (editorsLoaded.value && !force) return;
    editorsLoading.value = true;
    try {
      const r = await api.editors();
      editorsCatalog.value = r.editors;
      editorsPlatform.value = r.platform;
      effectiveEditor.value = r.effectiveDefault;
      if (defaultEditor.value == null) defaultEditor.value = r.defaultEditor;
      editorsLoaded.value = true;
    } catch {
      /* editors are optional — leave whatever we have */
    } finally {
      editorsLoading.value = false;
      if (editorsRefreshPending) {
        editorsRefreshPending = false;
        void loadEditors(true); // run the refresh that arrived while we were busy
      }
    }
  }

  /** Set the default "Open with…" editor (""=auto-pick first installed). Optimistic; rolls back
   *  on failure. Re-derives the effective default from the fresh choice. */
  async function setDefaultEditor(id: string): Promise<void> {
    const prev = defaultEditor.value;
    defaultEditor.value = id === "" ? null : id;
    try {
      const r = await api.setDefaultEditor(id);
      defaultEditor.value = r.defaultEditor;
      // A changed preference can change which editor the button targets → refresh the catalogue.
      void loadEditors(true);
    } catch (e) {
      defaultEditor.value = prev; // roll back
      throw e;
    }
  }

  /** Launch a repo folder (and optional changed file) in an editor. Throws ApiError on failure
   *  (the caller toasts); resolves with the OpenResult on success. */
  async function openInEditor(repoId: string, opts: { editor?: string; path?: string } = {}): Promise<OpenResult> {
    return api.openInEditor(repoId, opts);
  }

  // ── ⭐ Agent Safety Rail — pending approvals (SSE-driven; hydrated on boot) ────
  const pendingApprovals = ref<PendingApproval[]>([]);
  const approvalBusy = reactive<Record<string, boolean>>({});

  /** Hydrate the pending-approvals list (app boot / reconnect). SSE keeps it live after that. */
  async function loadApprovals(): Promise<void> {
    try {
      pendingApprovals.value = await api.listApprovals();
    } catch {
      /* best-effort — SSE will still deliver approval_pending for anything new */
    }
  }
  /** Upsert one pending approval (approval_pending SSE event). */
  function addPendingApproval(a: PendingApproval): void {
    const i = pendingApprovals.value.findIndex((p) => p.id === a.id);
    if (i === -1) pendingApprovals.value.push(a);
    else pendingApprovals.value[i] = a;
  }
  /** Drop a resolved approval (approval_resolved SSE event, or after a manual approve/deny). */
  function removePendingApproval(id: string): void {
    pendingApprovals.value = pendingApprovals.value.filter((p) => p.id !== id);
    delete approvalBusy[id];
  }
  /** Owner tapped Approve on the dashboard card. */
  async function approveCall(id: string): Promise<void> {
    approvalBusy[id] = true;
    try {
      await api.approveCall(id);
      removePendingApproval(id);
    } finally {
      delete approvalBusy[id];
    }
  }
  /** Owner tapped Deny on the dashboard card. */
  async function denyCall(id: string): Promise<void> {
    approvalBusy[id] = true;
    try {
      await api.denyCall(id);
      removePendingApproval(id);
    } finally {
      delete approvalBusy[id];
    }
  }

  // ── "Sync my settings with Connections" (opt-in cloud sync) — split into its own module ──
  const {
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
    applyAppearance,
  } = useSettingsCloudSync({
    diffStatsEnabled,
    remoteEditing,
    diffPatchBytes,
    diffPatchEnabled,
    syncCheckEnabled,
    syncIntervalSecs,
    keepInSync,
    autoCommitMode,
    autoCommitIntervalSecs,
    autoCommitAt,
    autoCommitPull,
    autoScan,
  });

  // ── desktop opt-in + header-bell notifications — split into its own module ────────────────
  const {
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
  } = useSettingsNotifications();

  return {
    authReady,
    authEnforced,
    authenticated,
    owner,
    ownerPicture,
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
    setAutoUpdate,
    setMcpApprovalGate,
    setMcpApprovalTimeoutSecs,
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
    applyAppearance,
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
  };
}
