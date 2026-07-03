import { ref, computed, type Ref } from "vue";
import { toast } from "vue-sonner";
import { api, type AccessMode, type TunnelStatus } from "../api";
import { t } from "../i18n";

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
  autoScan: Ref<boolean>;
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
    autoScan,
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
    notifyNewProjects,
  };
}
