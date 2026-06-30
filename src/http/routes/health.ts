import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { VERSION, accessMode, redactTunnel, saveConfig } from "../../config.ts";
import { getTunnelUrl, tunnelActive } from "../../runtime.ts";
import { broadcast } from "../../bus.ts";
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

export function register(app: Hono, { cfg }: Deps): void {
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
    }),
  );

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
    return c.json({
      ok: true,
      diffStats: diffStatsEnabled(),
      remoteEditing: cfg.remoteEditing !== false,
      diffPatchBytes: getDiffPatchBytes(),
      diffPatchEnabled: getDiffPatchEnabled(),
      syncCheck: syncCheckEnabled(),
      syncIntervalSecs: getSyncIntervalSecs(),
      keepInSync: keepInSyncEnabled(),
    });
  });
}
