import { type Ref, ref, watch } from "vue";
import { api, ApiError, type SyncStatus } from "../api";
import { t } from "../i18n";
import { useTheme, type ThemeMode } from "@/lib/theme";

/**
 * "Sync my settings with Connections" (opt-in cloud sync): status, enable/disable, manual
 * push/pull, and the debounced auto-push watchers for theme + the allowlisted prefs (PREF_KEYS
 * in src/connections-sync.ts). Split out of settings.ts (same module, just its own file) — no
 * behavioral change. `prefs` are the settings refs the auto-push watcher tracks.
 */
export function useSettingsCloudSync(prefs: {
  diffStatsEnabled: Ref<boolean>;
  remoteEditing: Ref<boolean>;
  diffPatchBytes: Ref<number>;
  diffPatchEnabled: Ref<boolean>;
  syncCheckEnabled: Ref<boolean>;
  syncIntervalSecs: Ref<number>;
  keepInSync: Ref<boolean>;
  autoCommitMode: Ref<"interval" | "daily">;
  autoCommitIntervalSecs: Ref<number>;
  autoCommitAt: Ref<string>;
  autoCommitPull: Ref<boolean>;
  autoScan: Ref<boolean>;
}) {
  const {
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
  } = prefs;

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

  return {
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
  };
}
