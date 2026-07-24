import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { t } from "../i18n";
import type { ActionResult } from "../types.ts";
import type { AutoCommitBlockedRepo, AutoCommittedRepo, BehindRepo, SyncedRepo } from "./settings.ts";

interface HeaderNotification {
  id: string;
  title: string;
  body?: string;
  ts: number;
  read: boolean;
  kind?: "scan" | "ai-key" | "behind" | "update";
  /** For a "behind" entry: the repos it covers, so the bell can offer Pull right there. */
  behind?: BehindRepo[];
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
 * Desktop-notification opt-in (header bell + OS notifications) and the toast/notification
 * helpers that SSE events (repo_behind, repo_synced, repo_auto_committed, …) and the scan flow
 * drive. Split out of settings.ts (same module, just its own file) — no behavioral change.
 *
 * `pullRepo` (the barrel's doAction("pull") bound by settings.ts) powers the behind-toast's
 * "Pull now / Pull all" action button; optional so tests and future callers can omit it.
 */
export function useSettingsNotifications(pullRepo?: (repoId: string) => Promise<ActionResult>) {
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
  const AI_KEY_INVALID_NOTIFICATION_PREFIX = "ai-key-invalid:";
  // One rolling "you are behind" entry, reconciled in place: a repo that keeps falling behind
  // should not grow the list, another repo must not hide the first, and once pulled there is
  // nothing left to act on.
  const BEHIND_NOTIFICATION_ID = "repos-behind";
  const UPDATE_NOTIFICATION_ID = "update-available";
  // `kind` tells the header bell where a click should go ("scan" → the scan modal, "ai-key" →
  // Settings → AI). Absent = a plain informational entry with no navigation.
  const notifications = ref<HeaderNotification[]>([]);
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

  /** Pull every behind repo from the toast's action button, then toast the outcome. */
  async function pullBehind(behind: BehindRepo[]): Promise<void> {
    if (!pullRepo) return;
    const results = await Promise.all(
      behind.map(async (r) => {
        try {
          return { repo: r, res: await pullRepo(r.id) };
        } catch {
          return { repo: r, res: { ok: false, code: "ERROR", message: "" } as ActionResult };
        }
      }),
    );
    const failed = results.filter((r) => !r.res.ok);
    // Resolve only the pulls that actually landed. A new behind event can arrive while these
    // requests are in flight, so dismissing the whole rolling entry here could erase a repo this
    // button never attempted.
    for (const { repo, res } of results) {
      if (res.ok) reconcileBehindNotification(repo.id, 0);
    }
    if (!failed.length) {
      toast.success(t("notify.behindPullDone", { count: behind.length }, behind.length));
    } else if (failed.length === 1 && behind.length === 1) {
      const f = failed[0]!;
      toast.error(f.res.message || t("notify.behindPullFailed", { name: f.repo.name }));
    } else {
      toast.error(t("notify.behindPullSomeFailed", { count: failed.length }, failed.length));
    }
  }

  // ── update available ──────────────────────────────────────────────────────────
  // The daemon's scheduled check found a newer build. NOTHING is installed here: this raises a
  // persistent bell entry and opens a prompt that offers the install. (Silently installing is
  // the separate, opt-in `autoUpdate` setting, which never reaches this path.)
  const updatePromptOpen = ref(false);
  /** Why an available update can't be installed right now (dirty tree, detached HEAD…), or null. */
  const updateBlockedReason = ref<string | null>(null);

  function notifyUpdateAvailable(info: { canApply: boolean; reason: string | null }): void {
    updateBlockedReason.value = info.canApply ? null : info.reason;
    const id = UPDATE_NOTIFICATION_ID;
    const entry = {
      id,
      title: t("notify.updateTitle"),
      body: info.canApply ? t("notify.updateBody") : t("notify.updateBlockedBody"),
      ts: Date.now(),
      read: false,
      kind: "update" as const,
    };
    const at = notifications.value.findIndex((n) => n.id === id);
    if (at === -1) notifications.value.unshift(entry);
    else notifications.value[at] = entry;
    // Prompt once per announcement rather than on every scheduled re-check, so a build the owner
    // chose to skip doesn't reopen a modal at them every few hours. The bell entry persists.
    if (at === -1) updatePromptOpen.value = true;
  }

  /** Called once an update actually applies — the offer no longer describes reality. */
  function clearUpdateNotification(): void {
    dismissNotification(UPDATE_NOTIFICATION_ID);
    updatePromptOpen.value = false;
  }

  /** Copy for the rolling behind entry. Kept in one place because live status changes can turn a
   *  many-repo notification back into a one-repo notification (and vice versa). */
  function behindNotificationCopy(behind: BehindRepo[]): { title: string; body: string } {
    const one = behind.length === 1 ? behind[0]! : null;
    return {
      title: one ? one.name : t("notify.behindManyTitle"),
      body: one
        ? t("notify.behindOneBody", { count: one.behind }, one.behind)
        : t("notify.behindManyBody", { count: behind.length }, behind.length),
    };
  }

  /** Reconcile an existing behind notification with an authoritative repo status. Status changes
   *  arrive after every fetch/pull/refresh, even when the action happened somewhere other than
   *  the notification button. Preserve its timestamp/read state: correcting stale copy is not a
   *  new alert. A separate `repo_behind` event marks genuine new remote work unread. */
  function reconcileBehindNotification(repoId: string, behind: number): void {
    const entry = notifications.value.find((n) => n.id === BEHIND_NOTIFICATION_ID);
    if (!entry?.behind) return;
    const repoAt = entry.behind.findIndex((r) => r.id === repoId);
    if (repoAt === -1) return;

    const next = [...entry.behind];
    if (behind > 0) next[repoAt] = { ...next[repoAt]!, behind };
    else next.splice(repoAt, 1);

    if (next.length === 0) {
      dismissNotification(BEHIND_NOTIFICATION_ID);
      return;
    }
    const copy = behindNotificationCopy(next);
    entry.behind = next;
    entry.title = copy.title;
    entry.body = copy.body;
  }

  /** Warn about repos that just fell behind: always a toast, plus a system notification when the
   *  owner opted in and the browser granted permission. Summarised when several land at once. */
  function notifyBehind(behind: BehindRepo[]): void {
    if (!behind?.length) return;
    const id = BEHIND_NOTIFICATION_ID;
    const existing = notifications.value.find((n) => n.id === id);
    const merged = existing?.behind ? [...existing.behind] : [];
    for (const repo of behind) {
      const at = merged.findIndex((r) => r.id === repo.id);
      if (at === -1) merged.push(repo);
      else merged[at] = repo;
    }
    // The REPO is the title. "Behind remote" told you the category of thing that happened but
    // not which repo it happened to, which is the only part you can't guess — and the bell shows
    // entries from several sources, so a generic title is easy to skim past.
    const { title, body } = behindNotificationCopy(merged);
    // The bell is where this LIVES: a persistent entry the owner can come back to and resolve,
    // rather than a wall of text over the middle of the page that expires on its own. One entry
    // reconciled (not stacked) so a repo that keeps falling behind can't pile up.
    const entry = { id, title, body, ts: Date.now(), read: false, kind: "behind" as const, behind: merged };
    const at = notifications.value.findIndex((n) => n.id === id);
    if (at === -1) notifications.value.unshift(entry);
    else notifications.value[at] = entry;

    // The toast is now only a nudge toward the bell: ONE line, no description block, with a
    // small pull action. It sits bottom-right (see App.vue) instead of over the page centre,
    // where its warning tint sat too close to the page background to read cleanly.
    toast.warning(body, {
      duration: 6000,
      action: pullRepo
        ? {
            label: merged.length === 1 ? t("notify.behindPull") : t("notify.behindPullAll"),
            onClick: () => {
              void pullBehind(merged);
            },
          }
        : undefined,
    });
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
    let body = one
      ? t("notify.autoCommitBody", { name: one.name, count: one.commits }, one.commits)
      : t("notify.autoCommitManyBody", { count: repos.length }, repos.length);
    // A configured provider failed and the owner's "basic" fallback split those with the built-in
    // grouping. Say so — unannounced, the generic messages read as the AI's own work. Count it
    // rather than testing `.some()`: the body already names the WHOLE batch, so an unqualified
    // note would tar repos the AI actually did split (same mixed-batch trap as the blocked path).
    const degraded = repos.filter((r) => r.degraded).length;
    if (degraded > 0) {
      body += ` — ${
        degraded === repos.length
          ? t("notify.autoCommitDegradedNote")
          : t("notify.autoCommitDegradedSomeNote", { n: degraded }, degraded)
      }`;
    }
    toast.success(t("notify.autoCommitTitle"), { description: body });
  }

  /** Warn about repos the auto-commit timer SKIPPED (merge conflict / mid-operation / a failed
   *  sync) — these need the owner's attention, so it's a warning toast (+ opt-in OS notification). */
  function notifyAutoCommitBlocked(repos: AutoCommitBlockedRepo[]): void {
    if (!repos?.length) return;
    const one = repos.length === 1 ? repos[0]! : null;
    const title = t("notify.autoCommitBlockedTitle");
    // AI_UNAVAILABLE is not a "go fix it" skip: the owner chose to skip rather than publish generic
    // messages, and the next tick retries on its own. The default copy ("resolve it at your desk")
    // would be a lie. Only claim it when EVERY skip is that reason — a mixed round still has a real
    // conflict in it, and that one does need the owner.
    const allAiUnavailable = repos.every((r) => r.reason === "AI_UNAVAILABLE");
    const body = allAiUnavailable
      ? one
        ? t("notify.autoCommitBlockedAiBody", { name: one.name })
        : t("notify.autoCommitBlockedAiManyBody", { count: repos.length }, repos.length)
      : one
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
      notifications.value.unshift({ id: NEW_PROJECTS_NOTIFICATION_ID, title, body, ts: Date.now(), read: false, kind: "scan" });
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

  // Providers we've already TOASTED about this session — so the live SSE broadcast (browser open at
  // boot) and the /api/status catch-up (browser opened later) never double-toast the same dead key.
  // The persistent bell entry is always (idempotently) refreshed regardless.
  const aiKeyToasted = new Set<string>();

  /** A configured AI provider's key was rejected on the liveness check. Refreshes a persistent bell
   *  entry (rolling, one per provider) so the owner sees it even after the toast fades — a dead key
   *  needs their attention (it silently breaks every "Generate"). Toasts once per provider/session. */
  function notifyAiKeyInvalid(providerLabel: string): void {
    const label = providerLabel || t("notify.aiKeyInvalidProvider");
    const title = t("notify.aiKeyInvalidTitle");
    const body = t("notify.aiKeyInvalidBody", { provider: label });
    const id = `${AI_KEY_INVALID_NOTIFICATION_PREFIX}${label}`;
    const existing = notifications.value.find((n) => n.id === id);
    if (existing) {
      existing.body = body;
      existing.ts = Date.now();
      existing.read = false;
    } else {
      notifications.value.unshift({ id, title, body, ts: Date.now(), read: false, kind: "ai-key" });
    }
    if (aiKeyToasted.has(label)) return; // bell refreshed above; don't re-toast the same dead key
    aiKeyToasted.add(label);
    toast.warning(title, { description: body });
    if (desktopNotify.value && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag: `repoyeti-ai-key-${label}` });
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
  };
}
