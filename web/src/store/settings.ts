import { ref, reactive, computed, watch, type Ref } from "vue";
import { toast } from "vue-sonner";
import {
  api,
  ApiError,
  type AccessMode,
  type TunnelStatus,
  type SyncStatus,
  type EditorInfo,
  type OpenResult,
} from "../api";
import { t } from "../i18n";
import { useTheme, type ThemeMode } from "@/lib/theme";
import type { PendingApproval } from "../types";

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

// Desktop-notification opt-in is per-browser (it rides the browser's Notification permission),
// so it lives in localStorage, not the daemon config.
const DESKTOP_NOTIFY_KEY = "repoyeti.desktopNotify";
function loadDesktopNotifyPref(): boolean {
  try {
    return localStorage.getItem(DESKTOP_NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}
function saveDesktopNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(DESKTOP_NOTIFY_KEY, on ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the in-memory ref still drives this session */
  }
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

  // ── "Sync my settings with Connections" (opt-in cloud sync) ───────────────────
  const { mode: themeMode, setTheme } = useTheme();

  const syncStatus = ref<SyncStatus>({
    ok: true,
    enabled: false,
    connected: false,
    lastSyncedAt: null,
    version: 0,
    appearance: null,
  });
  const syncLoading = ref(false); // initial load + connect/disconnect in flight
  const syncActionBusy = ref(false); // pull/push in flight (separate spinner from the toggle)
  const syncError = ref<string | null>(null);

  /** The minimal portable appearance blob — theme mode only. RepoYeti has one fixed accent
   *  (no per-user picker), so there's nothing else safe/portable to include here. Never file
   *  paths, tokens, or machine state. */
  function currentAppearance(): Record<string, unknown> {
    return { theme: themeMode.value };
  }

  /** Apply a synced appearance blob to the live theme (best-effort — ignores unknown/missing keys). */
  function applyAppearance(appearance: Record<string, unknown> | null | undefined): void {
    if (!appearance) return;
    const theme = appearance.theme;
    if (theme === "light" || theme === "dark" || theme === "system") setTheme(theme as ThemeMode);
  }

  /** Adopt a fresh status from the daemon: update the ref, clear any error, and apply appearance. */
  function absorbSyncStatus(s: SyncStatus): void {
    syncStatus.value = s;
    syncError.value = s.ok ? null : (s.error ?? null);
    applyAppearance(s.appearance);
  }

  /** Load the current sync status (auth/app boot + SSE `settings_changed`). Best-effort. */
  async function loadSyncStatus(): Promise<void> {
    syncLoading.value = true;
    try {
      const s = await api.getSyncStatus();
      absorbSyncStatus(s);
    } catch {
      /* sync is optional — leave whatever we have */
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync on, seeding it with the current local appearance. */
  async function enableSync(): Promise<void> {
    syncLoading.value = true;
    try {
      const s = await api.setSync({ enabled: true, appearance: currentAppearance() });
      absorbSyncStatus(s);
    } catch (e) {
      syncError.value = e instanceof ApiError ? e.message : t("settings.cloudSync.genericError");
      throw e;
    } finally {
      syncLoading.value = false;
    }
  }

  /** Turn sync off. `forget` also disconnects: deletes the remote doc + forgets the token. */
  async function disableSync(forget = false): Promise<void> {
    syncLoading.value = true;
    try {
      const s = await api.setSync({ enabled: false, ...(forget ? { forget: true } : {}) });
      absorbSyncStatus(s);
    } catch (e) {
      syncError.value = e instanceof ApiError ? e.message : t("settings.cloudSync.genericError");
      throw e;
    } finally {
      syncLoading.value = false;
    }
  }

  /** Manually push the current synced settings now. */
  async function pushSync(): Promise<void> {
    syncActionBusy.value = true;
    try {
      const s = await api.syncPush();
      absorbSyncStatus(s);
    } catch (e) {
      syncError.value = e instanceof ApiError ? e.message : t("settings.cloudSync.genericError");
      throw e;
    } finally {
      syncActionBusy.value = false;
    }
  }

  /** Manually pull settings synced from another device (applies appearance on success). */
  async function pullSync(): Promise<void> {
    syncActionBusy.value = true;
    try {
      const s = await api.syncPull();
      absorbSyncStatus(s);
    } catch (e) {
      syncError.value = e instanceof ApiError ? e.message : t("settings.cloudSync.genericError");
      throw e;
    } finally {
      syncActionBusy.value = false;
    }
  }

  /** Push just the current local appearance (theme/accent) as the synced blob. Silent/best-effort
   *  — used by the debounced auto-push below, so a transient failure doesn't toast on every
   *  keystroke-ish theme change. */
  async function pushAppearance(): Promise<void> {
    try {
      const s = await api.setSync({ appearance: currentAppearance() });
      absorbSyncStatus(s);
    } catch {
      /* best-effort — the next explicit push/enable will retry */
    }
  }

  /** Push the current allowlisted prefs (src/connections-sync.ts PREF_KEYS — the daemon always
   *  collects them fresh from the live cfg, so there's nothing to pass here). Silent/best-effort
   *  like pushAppearance — deliberately bypasses pushSync()'s syncActionBusy flag + rethrow so a
   *  background auto-push never flashes the manual "Sync Now" button's spinner or surfaces an
   *  inline error for a transient failure; used only by the debounced auto-push below. */
  async function pushPrefs(): Promise<void> {
    try {
      const s = await api.syncPush();
      absorbSyncStatus(s);
    } catch {
      /* best-effort — the next pref change or explicit push/enable will retry */
    }
  }

  // When the owner changes theme locally AND sync is enabled+connected, debounce and push the
  // new appearance so other devices pick it up. Debounced so rapid theme toggling doesn't spam
  // the daemon; skipped entirely while sync is off/disconnected or a status load is in flight
  // (avoids echoing a just-applied pulled appearance straight back out).
  let pushAppearanceTimer: ReturnType<typeof setTimeout> | undefined;
  watch(themeMode, () => {
    if (!syncStatus.value.enabled || !syncStatus.value.connected || syncLoading.value) return;
    clearTimeout(pushAppearanceTimer);
    pushAppearanceTimer = setTimeout(() => {
      void pushAppearance();
    }, 800);
  });

  // When the owner changes any allowlisted synced pref (src/connections-sync.ts PREF_KEYS) locally
  // AND sync is enabled+connected, debounce and push so other devices pick it up — mirrors the
  // theme watcher above (same guards, same 800ms debounce). A plain `syncPush()` is enough: the
  // daemon's pushNow() always collects the *current* cfg's PREF_KEYS, so there's nothing to pass
  // from here. Best-effort like pushAppearance — silent on failure, the next explicit action retries.
  let pushPrefsTimer: ReturnType<typeof setTimeout> | undefined;
  watch(
    [
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
    ],
    () => {
      if (!syncStatus.value.enabled || !syncStatus.value.connected || syncLoading.value) return;
      clearTimeout(pushPrefsTimer);
      pushPrefsTimer = setTimeout(() => {
        void pushPrefs();
      }, 800);
    },
  );

  // Client-only (per browser): also raise an OS notification on a fresh fall-behind. Persisted
  // in localStorage; only fires when the browser's Notification permission is granted.
  const desktopNotify = ref(loadDesktopNotifyPref());
  // The browser's current Notification permission, or "unsupported" where the API is absent.
  // Drives the Settings hint + whether `notifyBehind` may pop a system notification.
  const notifyPermission = ref<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  /** Opt into OS notifications: request the browser permission (must run from a user gesture),
   *  persist the preference, and reflect the resulting permission. Returns the new permission. */
  async function enableDesktopNotify(): Promise<NotificationPermission | "unsupported"> {
    if (typeof Notification === "undefined") {
      notifyPermission.value = "unsupported";
      return "unsupported";
    }
    let perm = Notification.permission;
    if (perm === "default") {
      try {
        perm = await Notification.requestPermission();
      } catch {
        /* some browsers reject if not from a gesture — leave perm as-is */
      }
    }
    notifyPermission.value = perm;
    const on = perm === "granted";
    desktopNotify.value = on;
    saveDesktopNotifyPref(on);
    return perm;
  }

  /** Turn OS notifications back off (browser permission is left untouched). */
  function disableDesktopNotify(): void {
    desktopNotify.value = false;
    saveDesktopNotifyPref(false);
  }

  // ── persistent notifications (header bell) ───────────────────────────────────
  // In-memory only (not persisted across reloads) — each is a lightweight rolling record
  // raised alongside a toast; see notifyNewProjects() below for the one producer today.
  const NEW_PROJECTS_NOTIFICATION_ID = "scan-new-projects";
  const notifications = ref<{ id: string; title: string; body?: string; ts: number; read: boolean }[]>(
    [],
  );
  const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length);
  function markNotificationsRead(): void {
    for (const n of notifications.value) n.read = true;
  }
  function dismissNotification(id: string): void {
    notifications.value = notifications.value.filter((n) => n.id !== id);
  }
  function clearNotifications(): void {
    notifications.value = [];
  }

  // ── "Scan for projects" modal ──────────────────────────────────────────────────
  // Store-owned so every entry point (header kebab, Add-project button, and the
  // "new projects found" toast raised from inside this store) can open the one modal.
  const scanOpen = ref(false);

  /** Warn about repos that just fell behind: always a toast, plus a system notification when the
   *  owner opted in and the browser granted permission. Summarised when several land at once. */
  function notifyBehind(behind: BehindRepo[]): void {
    if (!behind?.length) return;
    const one = behind.length === 1 ? behind[0]! : null;
    const title = one ? t("notify.behindTitle") : t("notify.behindManyTitle");
    const body = one
      ? t("notify.behindBody", { name: one.name, count: one.behind }, one.behind)
      : t("notify.behindManyBody", { count: behind.length }, behind.length);
    toast.warning(title, { description: body });
    if (
      desktopNotify.value &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        // A fixed tag coalesces rapid-fire warnings into one OS toast instead of a stack.
        new Notification(title, { body, tag: "repoyeti-behind" });
      } catch {
        /* notification construction can throw on some platforms — never break the SSE loop */
      }
    }
  }

  /** Reassure about repos "keep in sync" just auto fast-forwarded: a quiet success toast (no OS
   *  notification — an auto-resolved sync isn't something that needs the owner's attention). */
  function notifySynced(synced: SyncedRepo[]): void {
    if (!synced?.length) return;
    const one = synced.length === 1 ? synced[0]! : null;
    const body = one
      ? t("notify.syncedBody", { name: one.name, count: one.pulled }, one.pulled)
      : t("notify.syncedManyBody", { count: synced.length }, synced.length);
    toast.success(t("notify.syncedTitle"), { description: body });
  }

  /** Quiet success toast when the auto-commit timer committed (and maybe pushed) repos. */
  function notifyAutoCommitted(repos: AutoCommittedRepo[]): void {
    if (!repos?.length) return;
    const one = repos.length === 1 ? repos[0]! : null;
    const body = one
      ? t("notify.autoCommitBody", { name: one.name, count: one.commits }, one.commits)
      : t("notify.autoCommitManyBody", { count: repos.length }, repos.length);
    toast.success(t("notify.autoCommitTitle"), { description: body });
  }

  /** Warn about repos the auto-commit timer SKIPPED (merge conflict / mid-operation / a failed
   *  sync) — these need the owner's attention, so it's a warning toast (+ opt-in OS notification). */
  function notifyAutoCommitBlocked(repos: AutoCommitBlockedRepo[]): void {
    if (!repos?.length) return;
    const one = repos.length === 1 ? repos[0]! : null;
    const title = t("notify.autoCommitBlockedTitle");
    const body = one
      ? t("notify.autoCommitBlockedBody", { name: one.name })
      : t("notify.autoCommitBlockedManyBody", { count: repos.length }, repos.length);
    toast.warning(title, { description: body });
    if (
      desktopNotify.value &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(title, { body, tag: "repoyeti-auto-commit-blocked" });
      } catch {
        /* notification construction can throw on some platforms — never break the SSE loop */
      }
    }
  }

  /** A finished scan found repos we didn't know about. Upserts the one rolling "new projects"
   *  notification (a re-scan refreshes it rather than stacking), plus the existing toast (with a
   *  "View" action that opens the scan modal) and an opt-in OS notification. */
  function notifyNewProjects(count: number): void {
    if (count < 1) return;
    const title = t("notify.newProjectsTitle");
    const body = t("notify.newProjectsBody", { count }, count);
    const existing = notifications.value.find((n) => n.id === NEW_PROJECTS_NOTIFICATION_ID);
    if (existing) {
      existing.body = body;
      existing.ts = Date.now();
      existing.read = false;
    } else {
      notifications.value.unshift({ id: NEW_PROJECTS_NOTIFICATION_ID, title, body, ts: Date.now(), read: false });
    }
    toast.success(title, {
      description: body,
      action: {
        label: t("notify.newProjectsView"),
        onClick: () => {
          scanOpen.value = true;
        },
      },
    });
    if (desktopNotify.value && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag: "repoyeti-new-projects" });
      } catch {
        /* notification construction can throw on some platforms — never break the SSE loop */
      }
    }
  }

  return {
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
