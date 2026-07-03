import { defineStore } from "pinia";
import { ref, reactive, computed, watch } from "vue";
import { useEventSource } from "@vueuse/core";
import { toast } from "vue-sonner";
import { api, ApiError, type AccessMode, type TunnelStatus } from "./api";
import { t } from "./i18n";
import type {
  AccountsSnapshot,
  ActionName,
  ActionResult,
  AiCatalogEntry,
  AiModel,
  AiProviderId,
  AiSettings,
  CommitStyle,
  GhAccount,
  LoreServer,
  BranchList,
  ChangedFile,
  CommitPlanResponse,
  DetectedIdentity,
  FetchAllResult,
  Identity,
  LogResult,
  Repo,
  SmartCommitResult,
  StashList,
  TagList,
  UpdateApplyResult,
  UpdateStatus,
} from "./types";

/** Sync-status filter keys (multi-select; OR semantics). */
export type StatusKey = "dirty" | "ahead" | "behind" | "clean" | "error";

/** One repo that just fell further behind its remote (the `repo_behind` SSE payload). */
interface BehindRepo {
  id: string;
  name: string;
  branch: string | null;
  behind: number;
}

/** One repo "keep in sync" just auto fast-forwarded (the `repo_synced` SSE payload). */
interface SyncedRepo {
  id: string;
  name: string;
  pulled: number;
}

// Desktop-notification opt-in is per-browser (it rides the browser's Notification permission),
// so it lives in localStorage, not the daemon config.
const DESKTOP_NOTIFY_KEY = "repoyeti.desktopNotify";
let appOpenedPulsed = false;
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

export const useStore = defineStore("repoyeti", () => {
  const repos = ref<Repo[]>([]);
  const identities = ref<Identity[]>([]);
  const detectedIdentities = ref<DetectedIdentity[]>([]);
  const detectedIdentitiesLoading = ref(false);
  const detectedIdentitiesReady = ref(false);
  const loading = ref(true);
  const connected = ref(false);
  const updateStatus = ref<UpdateStatus | null>(null);
  const updateChecking = ref(false);
  const updateApplying = ref(false);

  // auth
  const authReady = ref(false);
  const authEnforced = ref(false);
  const authenticated = ref(true);
  const owner = ref<string | null>(null);
  // Access mode + local/remote auth state (see /api/auth/status).
  const mode = ref<AccessMode>("local");
  const ownerClaimed = ref(false);
  const canContinueLocal = ref(true);
  const localBypass = ref(false);
  /** repoId → the action currently in flight (drives per-button loading state). */
  const busy = reactive<Record<string, ActionName | undefined>>({});
  /** repoId → changed-file list (for the expandable tree view), lazily loaded. */
  const changesByRepo = reactive<Record<string, ChangedFile[]>>({});
  const changesLoading = reactive<Record<string, boolean>>({});
  /** repoId → { total, truncated } when the server capped an oversized changed-file list
   *  (MAX_CHANGED_FILES); drives the "showing N of M" notice. Absent = not truncated. */
  const changesMeta = reactive<Record<string, { total: number; truncated: boolean }>>({});

  // ── branches / history / stash (lazily loaded per repo when a section opens) ──
  const branchesByRepo = reactive<Record<string, BranchList>>({});
  const logByRepo = reactive<Record<string, LogResult>>({});
  const stashesByRepo = reactive<Record<string, StashList>>({});
  const tagsByRepo = reactive<Record<string, TagList>>({});
  /** repoId → a secondary git op in flight (branch switch / stash / discard …), for spinners
   *  and to disable the relevant control. Distinct from `busy` (the primary fetch/pull/push). */
  const gitOpBusy = reactive<Record<string, string | undefined>>({});

  // Scan roots (discovery directories) — lazily loaded when Settings opens.
  const roots = ref<string[]>([]);
  // Registered Lore servers — lazily loaded when Settings / Add-repo opens.
  const servers = ref<LoreServer[]>([]);
  // True while a bulk "fetch all" is running (drives the header button spinner).
  const fetchingAll = ref(false);

  // ── "Scan for projects" modal ──────────────────────────────────────────────────
  // Store-owned so every entry point (header kebab, Add-project button, and the
  // "new projects found" toast raised from inside this store) can open the one modal.
  const scanOpen = ref(false);
  // Live scan lifecycle, driven entirely by the scan_* SSE events (see connect()).
  const scanning = ref(false);
  const scanFound = ref(0); // repos seen so far this scan
  const scanNew = ref(0); // of those, how many were not previously known
  const scanDone = ref(false); // a scan has finished (or was stopped) → show the summary
  const lastScanCancelled = ref(false); // the finished scan ended via the Stop (X) control

  // BYOK AI settings (redacted — never holds a key). `aiEnabled` gates the Generate button.
  // Style is hardcoded to Conventional Commits (no UI picker); owners can still override
  // it in ~/.repoyeti/config.json. The daemon mirrors this default.
  const aiSettings = ref<AiSettings>({ providers: {}, defaultProvider: null, style: "conventional", yolo: false });
  const aiReady = ref(false);
  /** Provider catalog from GET /api/ai/catalog — safe display metadata, no secrets. */
  const aiCatalog = ref<AiCatalogEntry[]>([]);
  const aiEnabled = computed(() => {
    const dp = aiSettings.value.defaultProvider;
    return !!(dp && aiSettings.value.providers[dp]?.model);
  });

  const identityById = computed<Record<string, Identity>>(() =>
    Object.fromEntries(identities.value.map((i) => [i.id, i])),
  );

  // ── GitHub (gh) accounts — the machine-wide active-account switcher ────────────
  // `ghAvailable` is false when the `gh` CLI isn't installed/reachable (the UI then shows a hint).
  // Loaded on boot (loadAll) so the header switcher shows the active account, and refreshed when
  // Settings opens. Switching flips the active auth account — see AccountSwitcher.vue / AppHeader.vue.
  const ghAvailable = ref(false);
  const ghAccounts = ref<GhAccount[]>([]);
  /** Global git author in effect (display-only; switching auth does NOT change this). */
  const gitCommitIdentity = ref<{ name: string; email: string }>({ name: "", email: "" });
  const accountsReady = ref(false);
  const accountsLoading = ref(false);
  /** The login currently being switched to (drives per-row + header spinners); null when idle. */
  const switchingAccount = ref<string | null>(null);
  const activeAccount = computed(() => ghAccounts.value.find((a) => a.active) ?? null);

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
  // Client-only (per browser): also raise an OS notification on a fresh fall-behind. Persisted
  // in localStorage; only fires when the browser's Notification permission is granted.
  const desktopNotify = ref(loadDesktopNotifyPref());
  // The browser's current Notification permission, or "unsupported" where the API is absent.
  // Drives the Settings hint + whether `notifyBehind` may pop a system notification.
  const notifyPermission = ref<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  // Min query length before the changed-files "search content" toggle greps. Server-owned
  // (from /api/status) so the UI gate never drifts from the daemon's; 3 until status loads.
  const contentSearchMin = ref(3);

  // ── list filters (display-only; drag-reorder is disabled while a filter is active) ──
  const filterQuery = ref("");
  // undefined = all · null = "no identity" · string = a specific identity id
  const filterIdentity = ref<string | null | undefined>(undefined);
  // multi-select: an empty set means "any status"; multiple selected = OR (e.g. ahead OR behind).
  const filterStatuses = ref<StatusKey[]>([]);
  // Hidden repos are excluded from every view unless this is on (a deprecated-repo opt-out,
  // not a "filter" — drag-reorder still works over the visible set when it's off).
  const showHidden = ref(false);
  const hasHidden = computed(() => repos.value.some((r) => r.hidden));
  /** The repos any non-search view starts from: hidden ones dropped unless showHidden. */
  const visibleRepos = computed(() =>
    showHidden.value ? repos.value : repos.value.filter((r) => !r.hidden),
  );
  const filtersActive = computed(
    () =>
      !!filterQuery.value.trim() ||
      filterIdentity.value !== undefined ||
      filterStatuses.value.length > 0,
  );
  // ── dashboard sections (display-only buckets, precedence: pinned > starred > rest) ──
  // A repo lands in exactly one section so it never renders twice; the card can still
  // show both badges. Each preserves the global sort_order via `visibleRepos`.
  const pinnedRepos = computed(() => visibleRepos.value.filter((r) => r.pinned));
  const starredRepos = computed(() => visibleRepos.value.filter((r) => r.starred && !r.pinned));
  const otherRepos = computed(() => visibleRepos.value.filter((r) => !r.pinned && !r.starred));
  function matchesStatus(r: Repo, key: StatusKey): boolean {
    const st = r.status;
    switch (key) {
      case "dirty":
        return !!st && st.dirty > 0;
      case "ahead":
        return !!st && st.ahead > 0;
      case "behind":
        return !!st && st.behind > 0;
      case "error":
        return !!st?.error;
      case "clean":
        return !!st && !st.error && st.dirty === 0 && st.ahead === 0 && st.behind === 0;
    }
  }
  function toggleStatus(key: StatusKey): void {
    const i = filterStatuses.value.indexOf(key);
    if (i >= 0) filterStatuses.value.splice(i, 1);
    else filterStatuses.value.push(key);
  }
  const filteredRepos = computed(() => {
    const q = filterQuery.value.trim().toLowerCase();
    const statuses = filterStatuses.value;
    return visibleRepos.value.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (filterIdentity.value !== undefined) {
        const bad =
          filterIdentity.value === null ? !!r.identityId : r.identityId !== filterIdentity.value;
        if (bad) return false;
      }
      // OR across selected statuses; empty = match anything.
      if (statuses.length && !statuses.some((s) => matchesStatus(r, s))) return false;
      return true;
    });
  });
  function clearFilters(): void {
    filterQuery.value = "";
    filterIdentity.value = undefined;
    filterStatuses.value = [];
  }

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

  async function checkForUpdate(): Promise<UpdateStatus | null> {
    if (updateChecking.value) return updateStatus.value;
    updateChecking.value = true;
    try {
      updateStatus.value = await api.checkUpdate();
      return updateStatus.value;
    } catch {
      return updateStatus.value;
    } finally {
      updateChecking.value = false;
    }
  }

  async function applyUpdate(): Promise<UpdateApplyResult> {
    updateApplying.value = true;
    try {
      const result = await api.applyUpdate();
      updateStatus.value = result.status;
      return result;
    } finally {
      updateApplying.value = false;
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
      contentSearchMin.value = s.minContentSearch ?? 3;
    } catch {
      /* status is optional — leave whatever we have */
    }
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

  /** A finished scan found repos we didn't know about. Toast (with a "View" action that opens the
   *  scan modal — handy when the scan ran while the modal was closed) plus an opt-in OS notification. */
  function notifyNewProjects(count: number): void {
    if (count < 1) return;
    toast.success(t("notify.newProjectsTitle"), {
      description: t("notify.newProjectsBody", { count }, count),
      action: {
        label: t("notify.newProjectsView"),
        onClick: () => {
          scanOpen.value = true;
        },
      },
    });
    if (desktopNotify.value && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(t("notify.newProjectsTitle"), {
          body: t("notify.newProjectsBody", { count }, count),
          tag: "repoyeti-new-projects",
        });
      } catch {
        /* notification construction can throw on some platforms — never break the SSE loop */
      }
    }
  }

  // ── BYOK AI ───────────────────────────────────────────────────────────────────
  async function loadAiCatalog(): Promise<void> {
    try {
      aiCatalog.value = await api.ai.catalog();
    } catch {
      /* catalog is optional — Settings UI falls back gracefully to an empty list */
    }
  }
  async function loadAiSettings(): Promise<void> {
    try {
      aiSettings.value = await api.ai.settings();
    } catch {
      /* leave defaults — AI is optional */
    } finally {
      aiReady.value = true;
    }
  }
  /** Validate + save a key; returns the models it unlocks. Throws ApiError on bad key. */
  async function connectProvider(provider: AiProviderId, apiKey: string): Promise<AiModel[]> {
    const r = await api.ai.connect(provider, apiKey);
    aiSettings.value = r.settings;
    return r.models;
  }
  async function listProviderModels(provider: AiProviderId): Promise<AiModel[]> {
    return (await api.ai.models(provider)).models;
  }
  async function selectModel(provider: AiProviderId, model: string | null): Promise<void> {
    aiSettings.value = await api.ai.setProvider(provider, { model });
  }
  async function setDefaultProvider(provider: AiProviderId): Promise<void> {
    aiSettings.value = await api.ai.setProvider(provider, { makeDefault: true });
  }
  /** Toggle smart-commit YOLO mode (optimistic; rolls back on failure). */
  async function setYolo(yolo: boolean): Promise<void> {
    const prev = aiSettings.value.yolo;
    aiSettings.value = { ...aiSettings.value, yolo };
    try {
      aiSettings.value = await api.ai.setYolo(yolo);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, yolo: prev }; // roll back
      throw e;
    }
  }
  async function setStyle(style: CommitStyle): Promise<void> {
    const prev = aiSettings.value.style;
    aiSettings.value = { ...aiSettings.value, style };
    try {
      aiSettings.value = await api.ai.setStyle(style);
    } catch (e) {
      aiSettings.value = { ...aiSettings.value, style: prev }; // roll back
      throw e;
    }
  }
  async function removeProvider(provider: AiProviderId): Promise<void> {
    aiSettings.value = await api.ai.removeProvider(provider);
  }
  /** Draft a commit message from the repo's diff (or just `paths`, for smart-commit per-group
   *  regenerate). Throws ApiError → caller toasts. */
  async function genCommitMessage(repoId: string, provider?: AiProviderId, paths?: string[]): Promise<string> {
    return (await api.ai.commitMessage(repoId, provider, paths)).message;
  }

  /** Propose a multi-commit plan from the repo's working tree (commits nothing). Throws
   *  ApiError (e.g. NO_AI_PROVIDER / NOTHING_TO_COMMIT) → the caller toasts. */
  async function genCommitPlan(repoId: string, provider?: AiProviderId): Promise<CommitPlanResponse> {
    return api.ai.commitPlan(repoId, provider);
  }

  /** Execute an (owner-edited) commit plan. Sets the commit busy state, reloads the changed-
   *  file tree afterward (it shrank), and returns the structured result for the UI to render. */
  async function smartCommit(
    repoId: string,
    commits: Array<{ message: string; paths: string[] }>,
    sync = false,
  ): Promise<SmartCommitResult> {
    busy[repoId] = "commit";
    try {
      const r = await api.smartCommit(repoId, commits, sync);
      await loadChanges(repoId); // some/all files were just committed
      return r;
    } catch (e) {
      return { ...asResult(e), repoId };
    } finally {
      busy[repoId] = undefined;
    }
  }

  function patchRepo(id: string, patch: Partial<Repo>): void {
    const r = repos.value.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
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
        "repo_hidden_changed",
        "repo_pinned_changed",
        "repo_starred_changed",
        "repo_behind",
        "repo_synced",
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
        else if (event.value === "repo_hidden_changed")
          patchRepo(payload.id, { hidden: !!payload.hidden });
        else if (event.value === "repo_pinned_changed")
          patchRepo(payload.id, { pinned: !!payload.pinned });
        else if (event.value === "repo_starred_changed")
          patchRepo(payload.id, { starred: !!payload.starred });
        else if (event.value === "repo_behind") {
          // The background sync check found repos with new remote commits → warn (toast +
          // opt-in OS notification). The amber card state arrives separately via repo_state_changed.
          notifyBehind((payload.repos as BehindRepo[] | undefined) ?? []);
        } else if (event.value === "repo_synced") {
          // "Keep in sync" auto-pulled these — quiet confirmation (the cards already updated).
          notifySynced((payload.repos as SyncedRepo[] | undefined) ?? []);
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

  // ── actions ─────────────────────────────────────────────────────────────────
  // (commit is separate — it needs a message — see `commit()` below)
  async function doAction(
    repoId: string,
    name: "fetch" | "pull" | "push" | "refresh",
  ): Promise<ActionResult> {
    busy[repoId] = name;
    try {
      if (name === "refresh") {
        const repo = await api.refresh(repoId);
        patchRepo(repoId, { status: repo.status });
        return { ok: true, code: "OK", message: "refreshed" };
      }
      return await api[name](repoId);
    } catch (e) {
      return asResult(e);
    } finally {
      busy[repoId] = undefined;
    }
  }

  async function loadChanges(repoId: string): Promise<void> {
    if (changesLoading[repoId]) return; // don't stack concurrent reads for the same repo
    changesLoading[repoId] = true;
    try {
      const res = await api.changes(repoId);
      changesByRepo[repoId] = res.files ?? [];
      if (res.truncated) changesMeta[repoId] = { total: res.total ?? res.files.length, truncated: true };
      else delete changesMeta[repoId];
    } catch {
      changesByRepo[repoId] = [];
      delete changesMeta[repoId];
    } finally {
      changesLoading[repoId] = false;
    }
  }

  async function commit(repoId: string, message: string, amend = false): Promise<ActionResult> {
    busy[repoId] = "commit";
    try {
      return await api.commit(repoId, message, amend);
    } catch (e) {
      return asResult(e);
    } finally {
      busy[repoId] = undefined;
    }
  }

  // Per-file staging: commit ONLY `paths` (the rest stay pending), so the changes tree must be
  // reloaded afterward to drop the committed files (unlike a full commit, which empties the tree
  // and hides the section). The SSE status push refreshes the dirty count; this refreshes the list.
  async function commitSelected(repoId: string, message: string, paths: string[]): Promise<ActionResult> {
    busy[repoId] = "commit";
    try {
      return await api.commitSelected(repoId, message, paths);
    } catch (e) {
      return asResult(e);
    } finally {
      // ALWAYS refresh the changed-file list — not just on success. On a PLAN_STALE failure (a
      // selected file vanished out-of-band) this re-syncs the tree so RepoCard's prune watch drops
      // the now-stale path from the selection, instead of leaving it checked in a retry loop.
      await loadChanges(repoId);
      busy[repoId] = undefined;
    }
  }

  async function assignIdentity(repoId: string, identityId: string | null): Promise<void> {
    patchRepo(repoId, { identityId }); // optimistic
    await api.assignIdentity(repoId, identityId);
  }

  /** Hide/unhide a repo from the dashboard (optimistic; rolls back on failure). */
  async function setHidden(repoId: string, hidden: boolean): Promise<void> {
    patchRepo(repoId, { hidden }); // optimistic
    try {
      await api.setHidden(repoId, hidden);
    } catch (e) {
      patchRepo(repoId, { hidden: !hidden }); // roll back
      throw e;
    }
  }

  /** Pin/unpin a repo into the "Pinned" section (optimistic; rolls back on failure). */
  async function setPinned(repoId: string, pinned: boolean): Promise<void> {
    patchRepo(repoId, { pinned }); // optimistic
    try {
      await api.setPinned(repoId, pinned);
    } catch (e) {
      patchRepo(repoId, { pinned: !pinned }); // roll back
      throw e;
    }
  }

  /** Star/unstar a repo into the "Starred" section (optimistic; rolls back on failure). */
  async function setStarred(repoId: string, starred: boolean): Promise<void> {
    patchRepo(repoId, { starred }); // optimistic
    try {
      await api.setStarred(repoId, starred);
    } catch (e) {
      patchRepo(repoId, { starred: !starred }); // roll back
      throw e;
    }
  }

  // ── branches / history / stash / discard ─────────────────────────────────────
  /** Normalise any thrown ApiError into the structured {ok,code,message} the UI toasts. */
  function asResult(e: unknown): ActionResult {
    if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }

  async function loadBranches(repoId: string): Promise<void> {
    try {
      branchesByRepo[repoId] = await api.branches(repoId);
    } catch (e) {
      branchesByRepo[repoId] = { ...asResult(e), current: null, detached: false, branches: [] };
    }
  }

  async function switchBranch(repoId: string, branch: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "checkout";
    try {
      const r = await api.checkout(repoId, branch);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function createBranch(repoId: string, name: string, switchTo = true): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.createBranch(repoId, name, switchTo);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function deleteBranch(repoId: string, name: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "branch";
    try {
      const r = await api.deleteBranch(repoId, name);
      await loadBranches(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  /** Load (or append, when `skip`>0) the commit log for a repo. */
  async function loadLog(repoId: string, limit = 50, skip = 0): Promise<void> {
    try {
      const res = await api.log(repoId, limit, skip);
      if (skip > 0 && logByRepo[repoId]) {
        logByRepo[repoId] = {
          ...res,
          commits: [...logByRepo[repoId]!.commits, ...res.commits],
        };
      } else {
        logByRepo[repoId] = res;
      }
    } catch (e) {
      // A paginated "load more" (skip>0) failure must NOT wipe the commits already on screen — a
      // flaky network request would otherwise blank the whole history. Keep what's shown; the user
      // can retry. Only surface the error/empty state on a first-page load.
      if (skip > 0 && logByRepo[repoId]?.commits.length) return;
      logByRepo[repoId] = { ...asResult(e), commits: [], hasMore: false };
    }
  }

  async function loadStashes(repoId: string): Promise<void> {
    try {
      stashesByRepo[repoId] = await api.stashes(repoId);
    } catch (e) {
      stashesByRepo[repoId] = { ...asResult(e), stashes: [] };
    }
  }

  async function stashSave(repoId: string, message?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashSave(repoId, message);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function stashPop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashPop(repoId, index);
      await Promise.all([loadStashes(repoId), loadChanges(repoId)]);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  async function stashDrop(repoId: string, index = 0): Promise<ActionResult> {
    gitOpBusy[repoId] = "stash";
    try {
      const r = await api.stashDrop(repoId, index);
      await loadStashes(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  /** Discard one changed file's working-tree changes (destructive — the card confirms first). */
  async function discardFile(repoId: string, path: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "discard";
    try {
      const r = await api.discard(repoId, path);
      await loadChanges(repoId);
      return { ok: r.ok, code: r.code, message: r.message ?? "discarded" };
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

  // ── remotes / tags ───────────────────────────────────────────────────────────
  async function loadTags(repoId: string): Promise<void> {
    try {
      tagsByRepo[repoId] = await api.tags(repoId);
    } catch (e) {
      tagsByRepo[repoId] = { ...asResult(e), tags: [] };
    }
  }
  async function createTag(
    repoId: string,
    input: { name: string; message?: string; push?: boolean },
  ): Promise<ActionResult> {
    gitOpBusy[repoId] = "tag";
    try {
      const r = await api.createTag(repoId, input);
      await loadTags(repoId);
      return r;
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }
  async function setRemote(repoId: string, url: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      return await api.setRemote(repoId, url, name);
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }
  async function removeRemote(repoId: string, name?: string): Promise<ActionResult> {
    gitOpBusy[repoId] = "remote";
    try {
      return await api.removeRemote(repoId, name);
    } catch (e) {
      return asResult(e);
    } finally {
      gitOpBusy[repoId] = undefined;
    }
  }

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
    scanFound.value = 0;
    scanNew.value = 0;
    try {
      await api.startScan(opts);
    } catch (e) {
      scanning.value = false; // the request itself failed — never entered the running state
      throw e;
    }
  }
  /** Stop the in-flight scan (the modal's X). The scan_cancelled SSE event settles the state. */
  async function cancelScan(): Promise<void> {
    await api.cancelScan();
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
  /** Clone a repo from a registered Lore server into a folder under a scan root. */
  async function cloneFromServer(input: { url: string; parentPath: string; name?: string }): Promise<Repo> {
    const repo = await api.cloneFromServer(input);
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
    return repo;
  }

  /** Fetch every repo with a remote. Returns a summary the caller toasts. */
  async function fetchAll(): Promise<FetchAllResult> {
    fetchingAll.value = true;
    try {
      return await api.fetchAll();
    } finally {
      fetchingAll.value = false;
    }
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
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
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
    const idx = repos.value.findIndex((r) => r.id === repo.id);
    if (idx >= 0) repos.value[idx] = repo;
    else repos.value.push(repo);
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
    try {
      await api.reorderRepos(orderedIds);
    } catch {
      /* order is a nicety — never block the UI on it */
    }
  }

  // ── identity CRUD ───────────────────────────────────────────────────────────
  async function reloadIdentities(): Promise<void> {
    identities.value = await api.listIdentities();
  }
  async function loadDetectedIdentities(): Promise<void> {
    if (detectedIdentitiesLoading.value) return;
    detectedIdentitiesLoading.value = true;
    try {
      detectedIdentities.value = await api.detectedIdentities();
      detectedIdentitiesReady.value = true;
    } catch {
      detectedIdentities.value = [];
      detectedIdentitiesReady.value = true;
    } finally {
      detectedIdentitiesLoading.value = false;
    }
  }
  async function createIdentity(input: Omit<Identity, "id">): Promise<void> {
    await api.createIdentity(input);
    await reloadIdentities();
  }
  async function updateIdentity(id: string, patch: Partial<Omit<Identity, "id">>): Promise<void> {
    await api.updateIdentity(id, patch);
    await reloadIdentities();
  }
  async function removeIdentity(id: string): Promise<void> {
    await api.deleteIdentity(id);
    // Also refresh accounts: the server cascade clears any account→identity link that pointed at
    // this identity, so re-reading drops the now-stale link from the switcher's dropdowns.
    await Promise.all([
      reloadIdentities(),
      api.listRepos().then((r) => (repos.value = r)),
      loadAccounts(),
    ]);
  }

  // ── GitHub (gh) accounts ──────────────────────────────────────────────────────
  function applyAccountsSnapshot(s: AccountsSnapshot): void {
    ghAvailable.value = s.ghAvailable;
    ghAccounts.value = s.accounts ?? [];
    gitCommitIdentity.value = s.commitIdentity ?? { name: "", email: "" };
    accountsReady.value = true;
  }
  /** Load the machine's gh accounts + active one. Best-effort: never throws (drives an empty state). */
  async function loadAccounts(): Promise<void> {
    if (accountsLoading.value) return;
    accountsLoading.value = true;
    try {
      applyAccountsSnapshot(await api.accounts());
    } catch {
      ghAvailable.value = false;
      ghAccounts.value = [];
      accountsReady.value = true;
    } finally {
      accountsLoading.value = false;
    }
  }
  /** Switch the machine's active GitHub account (host defaults to github.com). Throws ApiError →
   *  the caller toasts; on success the snapshot (incl. the new active account) is applied. */
  async function switchAccount(login: string, host?: string): Promise<void> {
    switchingAccount.value = login;
    try {
      applyAccountsSnapshot(await api.switchAccount(login, host));
    } finally {
      switchingAccount.value = null;
    }
  }
  /** Link (or unlink, with null) a GitHub account to a saved commit identity (applied on switch).
   *  Throws ApiError → the caller toasts. */
  async function setAccountIdentity(login: string, identityId: string | null, host?: string): Promise<void> {
    applyAccountsSnapshot(await api.setAccountIdentity(login, identityId, host));
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
