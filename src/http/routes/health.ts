import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { VERSION, accessMode, redactTunnel, saveConfig, type RepoYetiConfig } from "../../config.ts";
import { getTunnelUrl, tunnelActive } from "../../runtime.ts";
import { broadcast } from "../../bus.ts";
import {
  readInstanceInfo,
  updateInstanceInfo,
  instanceFilePath,
  writeShutdownRequest,
} from "../../instance.ts";
import { openPortableWindow } from "../../portable-window.mjs";
import { dirname, join } from "node:path";
import { diffStatsEnabled, setDiffStatsEnabled } from "../../read/diffstat.ts";
import {
  refreshAllRepos,
  MIN_CONTENT_SEARCH,
  getDiffPatchBytes,
  setDiffPatchBytes,
  getDiffPatchEnabled,
  setDiffPatchEnabled,
} from "../../service/index.ts";
import {
  syncCheckEnabled,
  keepInSyncEnabled,
  getSyncIntervalSecs,
  setSyncCheckEnabled,
  setKeepInSync,
  setSyncIntervalSecs,
} from "../../remote-sync.ts";
import {
  autoCommitEnabled,
  getAutoCommitMode,
  getAutoCommitIntervalSecs,
  getAutoCommitAt,
  autoCommitPullEnabled,
  autoCommitPushEnabled,
  setAutoCommitEnabled,
  setAutoCommitMode,
  setAutoCommitIntervalSecs,
  setAutoCommitAt,
  setAutoCommitPull,
  setAutoCommitPush,
} from "../../auto-commit.ts";
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  setAutoUpdateEnabled,
  setAutoUpdateIntervalSecs,
} from "../../auto-update.ts";
import {
  approvalGateEnabled,
  getApprovalTimeoutSecs,
  setApprovalGateEnabled,
  setApprovalTimeoutSecs,
} from "../../approvals.ts";
import { isKnownEditor } from "../../service/index.ts";

/**
 * Resolve `loreServersEnabled`, deriving + persisting a one-time default on first read so
 * existing owners with servers already configured don't see the section suddenly collapse
 * (see RepoYetiConfig.loreServersEnabled).
 */
function resolveLoreServersEnabled(cfg: RepoYetiConfig): boolean {
  if (typeof cfg.loreServersEnabled === "boolean") return cfg.loreServersEnabled;
  const enabled = (cfg.servers?.length ?? 0) > 0;
  cfg.loreServersEnabled = enabled;
  saveConfig(cfg);
  return enabled;
}

export function register(app: Hono, { cfg, requestShutdown }: Deps): void {
  // ── auth surface ───────────────────────────────────────────────────────────
  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "repoyeti", version: VERSION, ts: Date.now() }),
  );
  // Runtime status for the UI — access mode + the public tunnel URL (null until a
  // cloudflared tunnel yields one) so the web app can show the remote-access link/QR.
  app.get("/api/status", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      mode: accessMode(cfg),
      tunnelActive: tunnelActive(),
      tunnelUrl: getTunnelUrl(),
      // Redacted named-tunnel config (hostname + token-presence flags) so the Settings UI can show
      // the stable-address state on first load. NEVER the token bytes — see redactTunnel().
      tunnel: redactTunnel(cfg),
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      // Large-file Diff threshold (bytes) — owner setting; the viewer compares file size to it.
      diffPatchBytes: getDiffPatchBytes(),
      // Whether large files may use the compact patch view at all (false = always side-by-side).
      diffPatchEnabled: getDiffPatchEnabled(),
      // The min query length for "search content" — the single source of truth, so the UI
      // gate can never silently drift from the server's grep gate.
      minContentSearch: MIN_CONTENT_SEARCH,
      // Background remote-sync check: whether it runs + how often (seconds), so the Settings
      // UI reflects the live state on first load without a separate request.
      syncCheck: syncCheckEnabled(),
      syncIntervalSecs: getSyncIntervalSecs(),
      // "Keep in sync": whether the check also auto fast-forwards safe repos.
      keepInSync: keepInSyncEnabled(),
      // Auto-commit timer: whether it runs, how it's scheduled, and its pull/push behaviour, so
      // the Settings UI reflects the live state on first load. Per-repo opt-in lives on each repo.
      autoCommit: autoCommitEnabled(),
      autoCommitMode: getAutoCommitMode(),
      autoCommitIntervalSecs: getAutoCommitIntervalSecs(),
      autoCommitAt: getAutoCommitAt(),
      autoCommitPull: autoCommitPullEnabled(),
      autoCommitPush: autoCommitPushEnabled(),
      // Auto-update: whether the daemon self-updates + restarts on a schedule, and the check
      // cadence (seconds), so Settings reflects the live state on first load.
      autoUpdate: autoUpdateEnabled(),
      autoUpdateIntervalSecs: getAutoUpdateIntervalSecs(),
      // Auto-scan the whole machine on every app start (owner setting; off by default). A pure
      // stored flag — the web client acts on it at boot; the daemon has no runtime side effect.
      autoScan: cfg.autoScan === true,
      // Lore-servers settings section expanded/collapsed (owner setting; pure stored flag,
      // no daemon side effect). First read with no explicit value → derive a sensible default
      // (expanded if servers are already configured) and persist it so it sticks from here on.
      loreServersEnabled: resolveLoreServersEnabled(cfg),
      // Whether the app UI opens in a chromeless Chromium app window instead of a browser tab
      // (owner setting; off by default). The desktop launcher/tray reads the same flag off
      // runtime.json (see src/instance.ts), not this endpoint, so it can act before the daemon
      // is up — this is just what the Settings UI reflects on load.
      portableMode: cfg.portableMode === true,
      // Whether the system-tray notification-area icon is hidden (owner setting; off by
      // default). The tray launcher reads the same flag off runtime.json (see src/instance.ts)
      // so it can act on it live, not just at boot — this is just what Settings reflects on load.
      hideTrayIcon: cfg.hideTrayIcon === true,
      // ⭐ Agent Safety Rail: whether mutating MCP tool calls are gated behind a human
      // approve/deny (owner setting; default ON), and the auto-deny timeout in seconds.
      mcpApprovalGate: approvalGateEnabled(),
      mcpApprovalTimeoutSecs: getApprovalTimeoutSecs(),
      // "Open with…" default external editor id (null = auto-pick the first installed). The
      // catalogue + per-machine availability come from GET /api/editors.
      defaultEditor: cfg.defaultEditor ?? null,
    }),
  );

  app.post("/api/shutdown", (c) => {
    // The tray stops the daemon by port (Stop-RepoYeti) and never calls this route, so any request
    // that reaches here is a user "Shut Down" from the web UI — a request to terminate the WHOLE
    // app, tray included. Drop a sentinel the tray host polls so it disposes its notification-area
    // icon and exits too (and its auto-restart watchdog stands down instead of resurrecting the
    // daemon); harmless when no tray is running (cleared on the next daemon boot).
    writeShutdownRequest();
    setTimeout(() => requestShutdown?.(), 25);
    return c.json({ ok: true });
  });
  // Owner UI settings. Currently just the diff-stats toggle: flipping it persists the
  // config, updates the runtime flag, tells every client over SSE, and re-reads all repos
  // so each card's aggregate stat appears/clears immediately.
  app.put("/api/settings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.diffStats === "boolean") {
      cfg.diffStats = b.diffStats;
      setDiffStatsEnabled(b.diffStats);
      saveConfig(cfg);
      broadcast("settings_changed", { diffStats: cfg.diffStats });
      refreshAllRepos();
    }
    if (typeof b.remoteEditing === "boolean") {
      cfg.remoteEditing = b.remoteEditing;
      saveConfig(cfg);
      broadcast("settings_changed", { remoteEditing: cfg.remoteEditing });
    }
    if (typeof b.diffPatchBytes === "number" && Number.isFinite(b.diffPatchBytes)) {
      // setDiffPatchBytes clamps → persist the clamped value, not the raw input.
      cfg.diffPatchBytes = setDiffPatchBytes(b.diffPatchBytes);
      saveConfig(cfg);
      broadcast("settings_changed", { diffPatchBytes: cfg.diffPatchBytes });
    }
    if (typeof b.diffPatchEnabled === "boolean") {
      cfg.diffPatchEnabled = b.diffPatchEnabled;
      setDiffPatchEnabled(b.diffPatchEnabled);
      saveConfig(cfg);
      broadcast("settings_changed", { diffPatchEnabled: cfg.diffPatchEnabled });
    }
    if (typeof b.syncCheck === "boolean") {
      // Toggling the check starts/stops the daemon-wide fetch timer (see remote-sync.ts).
      cfg.syncCheck = b.syncCheck;
      setSyncCheckEnabled(b.syncCheck);
      saveConfig(cfg);
      broadcast("settings_changed", { syncCheck: cfg.syncCheck });
    }
    if (typeof b.syncIntervalSecs === "number" && Number.isFinite(b.syncIntervalSecs)) {
      // setSyncIntervalSecs clamps to [30, 3600] → persist the clamped value, not the raw input.
      cfg.syncIntervalSecs = setSyncIntervalSecs(b.syncIntervalSecs);
      saveConfig(cfg);
      broadcast("settings_changed", { syncIntervalSecs: cfg.syncIntervalSecs });
    }
    if (typeof b.keepInSync === "boolean") {
      cfg.keepInSync = b.keepInSync;
      setKeepInSync(b.keepInSync);
      saveConfig(cfg);
      broadcast("settings_changed", { keepInSync: cfg.keepInSync });
    }
    // ── auto-commit timer settings ──────────────────────────────────────────
    if (typeof b.autoCommit === "boolean") {
      // Toggling this starts/stops the daemon-wide auto-commit timer (see auto-commit.ts).
      cfg.autoCommit = b.autoCommit;
      setAutoCommitEnabled(b.autoCommit);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommit: cfg.autoCommit });
    }
    if (b.autoCommitMode === "interval" || b.autoCommitMode === "daily") {
      cfg.autoCommitMode = b.autoCommitMode;
      setAutoCommitMode(b.autoCommitMode);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommitMode: cfg.autoCommitMode });
    }
    if (typeof b.autoCommitIntervalSecs === "number" && Number.isFinite(b.autoCommitIntervalSecs)) {
      // setAutoCommitIntervalSecs clamps to [60, 86400] → persist the clamped value.
      cfg.autoCommitIntervalSecs = setAutoCommitIntervalSecs(b.autoCommitIntervalSecs);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommitIntervalSecs: cfg.autoCommitIntervalSecs });
    }
    if (typeof b.autoCommitAt === "string") {
      // setAutoCommitAt normalises "HH:MM" → persist the normalised value.
      cfg.autoCommitAt = setAutoCommitAt(b.autoCommitAt);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommitAt: cfg.autoCommitAt });
    }
    if (typeof b.autoCommitPull === "boolean") {
      cfg.autoCommitPull = b.autoCommitPull;
      setAutoCommitPull(b.autoCommitPull);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommitPull: cfg.autoCommitPull });
    }
    if (typeof b.autoCommitPush === "boolean") {
      cfg.autoCommitPush = b.autoCommitPush;
      setAutoCommitPush(b.autoCommitPush);
      saveConfig(cfg);
      broadcast("settings_changed", { autoCommitPush: cfg.autoCommitPush });
    }
    // ── auto-update timer settings ──────────────────────────────────────────
    if (typeof b.autoUpdate === "boolean") {
      // Toggling this starts/stops the daemon-wide auto-update timer (see auto-update.ts).
      cfg.autoUpdate = b.autoUpdate;
      setAutoUpdateEnabled(b.autoUpdate);
      saveConfig(cfg);
      broadcast("settings_changed", { autoUpdate: cfg.autoUpdate });
    }
    if (typeof b.autoUpdateIntervalSecs === "number" && Number.isFinite(b.autoUpdateIntervalSecs)) {
      // setAutoUpdateIntervalSecs clamps to [900, 604800] → persist the clamped value.
      cfg.autoUpdateIntervalSecs = setAutoUpdateIntervalSecs(b.autoUpdateIntervalSecs);
      saveConfig(cfg);
      broadcast("settings_changed", { autoUpdateIntervalSecs: cfg.autoUpdateIntervalSecs });
    }
    if (typeof b.autoScan === "boolean") {
      // Pure stored flag; no runtime call (the web client is what acts on it at boot).
      cfg.autoScan = b.autoScan;
      saveConfig(cfg);
      broadcast("settings_changed", { autoScan: cfg.autoScan });
    }
    if (typeof b.loreServersEnabled === "boolean") {
      // Pure stored flag: no runtime call, just whether the Settings section is expanded.
      cfg.loreServersEnabled = b.loreServersEnabled;
      saveConfig(cfg);
      broadcast("settings_changed", { loreServersEnabled: cfg.loreServersEnabled });
    }
    if (typeof b.portableMode === "boolean") {
      cfg.portableMode = b.portableMode;
      saveConfig(cfg);
      // Keep runtime.json current so the tray launcher picks up the new preference on its
      // very next cold start, even though it never talks to this daemon to learn it.
      updateInstanceInfo({ portableMode: cfg.portableMode });
      broadcast("settings_changed", { portableMode: cfg.portableMode });
    }
    if (typeof b.hideTrayIcon === "boolean") {
      cfg.hideTrayIcon = b.hideTrayIcon;
      saveConfig(cfg);
      // Keep runtime.json current so the tray host's live watch-timer re-read picks up the
      // new preference within a few seconds, without a restart — see misc/RepoYeti-Tray.ps1.
      updateInstanceInfo({ hideTrayIcon: cfg.hideTrayIcon });
      broadcast("settings_changed", { hideTrayIcon: cfg.hideTrayIcon });
    }
    // ── ⭐ Agent Safety Rail settings ────────────────────────────────────────
    if (typeof b.mcpApprovalGate === "boolean") {
      cfg.mcpApprovalGate = b.mcpApprovalGate;
      setApprovalGateEnabled(b.mcpApprovalGate);
      saveConfig(cfg);
      broadcast("settings_changed", { mcpApprovalGate: cfg.mcpApprovalGate });
    }
    if (typeof b.mcpApprovalTimeoutSecs === "number" && Number.isFinite(b.mcpApprovalTimeoutSecs)) {
      // setApprovalTimeoutSecs clamps to [10, 3600] → persist the clamped value.
      cfg.mcpApprovalTimeoutSecs = setApprovalTimeoutSecs(b.mcpApprovalTimeoutSecs);
      saveConfig(cfg);
      broadcast("settings_changed", { mcpApprovalTimeoutSecs: cfg.mcpApprovalTimeoutSecs });
    }
    // "Open with…" default editor. An empty string clears the preference (auto-pick the first
    // installed editor); any other value must be a known catalog id, else it's ignored.
    if (typeof b.defaultEditor === "string") {
      if (b.defaultEditor === "") cfg.defaultEditor = undefined;
      else if (isKnownEditor(b.defaultEditor)) cfg.defaultEditor = b.defaultEditor;
      if (b.defaultEditor === "" || isKnownEditor(b.defaultEditor)) {
        saveConfig(cfg);
        broadcast("settings_changed", { defaultEditor: cfg.defaultEditor ?? null });
      }
    }
    return c.json({
      ok: true,
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      diffPatchBytes: getDiffPatchBytes(),
      diffPatchEnabled: getDiffPatchEnabled(),
      syncCheck: syncCheckEnabled(),
      syncIntervalSecs: getSyncIntervalSecs(),
      keepInSync: keepInSyncEnabled(),
      autoCommit: autoCommitEnabled(),
      autoCommitMode: getAutoCommitMode(),
      autoCommitIntervalSecs: getAutoCommitIntervalSecs(),
      autoCommitAt: getAutoCommitAt(),
      autoCommitPull: autoCommitPullEnabled(),
      autoCommitPush: autoCommitPushEnabled(),
      autoUpdate: autoUpdateEnabled(),
      autoUpdateIntervalSecs: getAutoUpdateIntervalSecs(),
      autoScan: cfg.autoScan === true,
      loreServersEnabled: resolveLoreServersEnabled(cfg),
      portableMode: cfg.portableMode === true,
      hideTrayIcon: cfg.hideTrayIcon === true,
      mcpApprovalGate: approvalGateEnabled(),
      mcpApprovalTimeoutSecs: getApprovalTimeoutSecs(),
      defaultEditor: cfg.defaultEditor ?? null,
    });
  });

  // Open this daemon's own UI in a chromeless Chromium app window (msedge/chrome --app=URL)
  // instead of a browser tab. Fired the moment the owner flips the "Portable window" toggle
  // on, and available any time after (e.g. a manual re-open). Same auth/guard posture as every
  // other mutating route here — gated by the single /api/* auth middleware, nothing extra.
  app.post("/api/portable-window", async (c) => {
    // Prefer the pointer's recorded URL (the port the daemon ACTUALLY bound, which can differ
    // from the configured one — see writeInstanceInfo in cli/lifecycle.ts); fall back to the
    // URL this very request arrived on, since the daemon is always loopback-only.
    const url = readInstanceInfo()?.url ?? new URL(c.req.url).origin;
    // Dedicated profile (sibling of runtime.json) so the window remembers its own
    // size/position across launches instead of sharing the user's main browser profile.
    // Derived from instanceFilePath()'s dirname — the exact dir runtime.json itself lives
    // in — so this and the tray launcher (which reads the same runtime.json path) always
    // agree, and REPOYETI_HOME is honoured automatically.
    const profileDir = join(dirname(instanceFilePath()), "portable-profile");
    const result = await openPortableWindow(url, { profileDir });
    return c.json(result);
  });
}
