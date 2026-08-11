/**
 * Anonymous install/update-check ping to the Connections Studio app-ping endpoint — the same
 * mechanism QuickDictate and AnatomyOf use in prod (see QuickDictate's src/update.rs for the
 * reference semantics this mirrors). `GET .../v1/app/repoyeti/latest` returns GitHub's
 * `releases/latest` JSON for LunarWerxs/RepoYeti verbatim, so it doubles as the update check:
 * src/github-updater.ts's `latestRelease()` fetches exactly this URL (see buildPingRequest
 * below), so the ping never costs a network call beyond the update check the app already makes.
 *
 * Boot-time firing lives in src/cli/lifecycle.ts's `start()` — the DAEMON boot path, not the web
 * dashboard — so a headless/tray-only daemon nobody ever dashboards into is still counted. That
 * call is throttled to at most one real network hit per 24h via the persisted
 * `cfg.appPing.lastPingAt` (see fireBootPing): repeated restarts (the tray's "Restart", the
 * auto-updater's own self-relaunch) must not re-ping every time. A dashboard-triggered or
 * auto-update-timer-triggered check that happens to land inside that window still counts (any
 * successful hit advances `lastPingAt` — see recordPingResult), so the boot ping only fires when
 * nothing else already has recently.
 *
 * Anonymity is the whole product: only the install id, the running version, and a coarse OS tag
 * are ever sent — never a hostname, username, path, or email. Opt out with REPOYETI_NO_PING=1;
 * disabled entirely under NODE_ENV=test, CI, or the daemon's own REPOYETI_DEV=1 dev-loop flag
 * (the same flag src/cli/lifecycle.ts's single-instance guard already uses).
 *
 * Replaces the old REPOYETI_PULSE_URL / CONNECTIONS_PULSE_URL "product pulse" that used to live in
 * src/http/routes/updates.ts (POST /api/pulse + a generic recordPulse(event, properties)): that
 * collector was never actually stood up anywhere, so in production it never sent a single real
 * event. This is the real thing, repointed onto the update check instead of a parallel mechanism.
 */
import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";
import { type RepoYetiConfig, VERSION, loadConfig, saveConfig } from "./config.ts";

/** Studio's app-ping proxy: relays GitHub's releases/latest JSON for LunarWerxs/RepoYeti verbatim. */
export const APP_PING_URL = "https://studio.connections.icu/v1/app/repoyeti/latest";

/** At most one real boot-ping network hit per this interval. */
export const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** True when the ping (install id + version + os) must never be sent: opted out via
 *  REPOYETI_NO_PING, or a dev/test/CI run rather than a real install being used. */
export function pingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.REPOYETI_NO_PING === "1" ||
    env.NODE_ENV === "test" ||
    !!env.CI ||
    env.REPOYETI_DEV === "1"
  );
}

/** Coarse OS tag: "win11-26100" / "win10-19045" style build tag on Windows (build >= 22000 is
 *  Windows 11 — the kernel version alone doesn't say so), else the bare platform name. Never
 *  anything more specific than that — no hostname, no machine id, no exact patch level beyond
 *  the build number GitHub Releases already segments assets by. */
export function osTag(
  platform: NodeJS.Platform = process.platform,
  release: string = osRelease(),
): string {
  if (platform === "win32") {
    const build = Number.parseInt(release.split(".")[2] ?? "", 10);
    if (!Number.isFinite(build)) return "windows";
    return `${build >= 22000 ? "win11" : "win10"}-${build}`;
  }
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return platform;
}

export interface PingRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the (URL, headers) for one app-ping / update-check request. Disabled → the bare URL with
 * no query and no headers (still a valid update check, just not identifiable to any install).
 * Enabled → `?v=` + `?os=` always, `X-Install-Id` once an id has been minted (see ensureInstallId),
 * and `&new=1` exactly once — the first time this install's ping ever succeeds (see
 * recordPingResult, which is what flips `reported`).
 */
export function buildPingRequest(
  cfg: RepoYetiConfig,
  env: NodeJS.ProcessEnv = process.env,
): PingRequest {
  if (pingDisabled(env)) return { url: APP_PING_URL, headers: {} };
  const url = new URL(APP_PING_URL);
  url.searchParams.set("v", VERSION);
  url.searchParams.set("os", osTag());
  const headers: Record<string, string> = {};
  const id = cfg.appPing?.installId;
  if (id) {
    headers["X-Install-Id"] = id;
    if (!cfg.appPing?.reported) url.searchParams.set("new", "1");
  }
  return { url: url.toString(), headers };
}

/**
 * Mint + persist this install's random id once, independent of whether any ping ever succeeds —
 * an id that failed to persist would change every launch and inflate the install count. Never
 * derived from hostname, username, or any other machine identifier.
 */
export function ensureInstallId(cfg: RepoYetiConfig): string {
  cfg.appPing ??= {};
  if (!cfg.appPing.installId) {
    cfg.appPing.installId = randomUUID();
    saveConfig(cfg);
  }
  return cfg.appPing.installId;
}

/**
 * Record that a ping attempt just happened, and — only on a genuine success — that this install
 * has been reported at least once (so `&new=1` never repeats, mirroring QuickDictate's
 * InstallReported: the flag is persisted only after success, never optimistically).
 */
export function recordPingResult(cfg: RepoYetiConfig, succeeded: boolean): void {
  cfg.appPing = {
    ...cfg.appPing,
    lastPingAt: Date.now(),
    reported: (cfg.appPing?.reported ?? false) || succeeded,
  };
  saveConfig(cfg);
}

/**
 * Boot-time fire-and-forget ping — call once from src/cli/lifecycle.ts's `start()`, passing a
 * zero-arg `check` that resolves once (github-updater.ts's checkForUpdate, called directly so a
 * source checkout — which has no api.github.com-based check of its own to repoint — still gets
 * pinged, not just compiled releases). Throttled to PING_INTERVAL_MS via the persisted
 * `appPing.lastPingAt`; every failure inside `check` is swallowed here too (belt and braces —
 * checkForUpdate already never throws); never awaited by the caller, so it cannot block boot; no
 * retry loop (a missed ping just waits for the next boot or the 24h window, whichever is first).
 */
export function fireBootPing(check: () => Promise<unknown>): void {
  if (pingDisabled()) return;
  const cfg = loadConfig();
  const last = cfg.appPing?.lastPingAt ?? 0;
  if (Date.now() - last < PING_INTERVAL_MS) return;
  void check().catch(() => {
    /* fire-and-forget: checkForUpdate already swallows its own errors, this is belt and braces */
  });
}
