import { ref, computed } from "vue";
import { toast } from "vue-sonner";
import { t } from "../i18n";
import type { BehindRepo, SyncedRepo, AutoCommittedRepo, AutoCommitBlockedRepo } from "./settings.ts";

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
 * Desktop-notification opt-in (header bell + OS notifications) and the toast/notification
 * helpers that SSE events (repo_behind, repo_synced, repo_auto_committed, …) and the scan flow
 * drive. Split out of settings.ts (same module, just its own file) — no behavioral change.
 */
export function useSettingsNotifications() {
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
