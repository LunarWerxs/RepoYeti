/**
 * Auto-update timer — "keep the app current for me, silently".
 *
 * A single daemon-wide timer asks src/updater.ts whether a newer version is available and
 * applicable. Source checkouts fast-forward/rebuild; compiled releases download and verify the
 * compressed platform archive. It then SELF-RELAUNCHES so the updated code takes over. The tray
 * (misc/RepoYeti-Tray.ps1) is a bare supervisor that
 * does NOT relaunch the daemon on exit, so the daemon must relaunch itself; the concrete relaunch
 * (spawn a detached copy of our launch command, then gracefully shut down) is injected from
 * src/cli/lifecycle.ts, which owns the shutdown handle. The tray then finds the successor via
 * ~/.repoyeti/runtime.json + /api/health exactly as it does after a manual "Restart".
 *
 * TWO settings share this one timer, because they need the same check and differ only in what
 * happens next:
 *   · cfg.updateNotify (absent = ON)  — announce an available update (SSE `update_available`) and
 *     let the owner decide. Nothing is installed.
 *   · cfg.autoUpdate   (absent = OFF) — additionally APPLY it and self-relaunch, unattended.
 * Those are different consents: being told you are out of date costs nothing, whereas restarting
 * the daemon out from under whoever is using it is a thing you opt into. So the timer runs when
 * EITHER is on, and only the second one ever applies.
 *
 * A dirty working tree is NEVER updated (`canApply` gates it), so uncommitted local work is safe.
 * Timer shape mirrors auto-commit.ts / remote-sync.ts: a self-rescheduling setTimeout (never
 * setInterval) so a slow apply can't stack. Primed + toggled live from src/http/app.ts + PUT
 * /api/settings; started/stopped in src/cli/lifecycle.ts.
 *
 * The apply half also DEFERS whenever work is in flight: a pending MCP approval
 * (src/approvals.ts) or an active op-queue entry (src/opqueue.ts) means an agent or the owner is
 * mid-operation on this daemon right now. A deferral retries in AUTO_UPDATE_BUSY_RETRY_S, not a
 * full check interval — "wait for idle" means keep looking for idle, not "try again in six hours".
 * The op-queue signal also counts routine background reads (watch-triggered refreshes), which on a
 * many-repo daemon can stay warm nearly continuously, so it is trusted for at most
 * AUTO_UPDATE_MAX_OPS_DEFERRALS consecutive retries before the apply proceeds anyway — an
 * unattended updater that can be starved forever is the worse bug. Pending approvals are exempt
 * from that cap: their own auto-deny timeout bounds them. Only the unattended apply defers this
 * way — the notify half above is never held back, since telling the owner an update exists is
 * always safe.
 */
import { broadcast } from "./bus.ts";
import { listPending } from "./approvals.ts";
import { hasActiveOperations } from "./opqueue.ts";
import { applyUpdate, checkForUpdate } from "./updater.ts";

/** Check cadence bounds (seconds): 15 min floor, 7 day ceiling, default 6 h. */
export const AUTO_UPDATE_INTERVAL_MIN_S = 900;
export const AUTO_UPDATE_INTERVAL_MAX_S = 604_800;
export const AUTO_UPDATE_INTERVAL_DEFAULT_S = 21_600;

/** Clamp a requested cadence into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampAutoUpdateInterval(secs: number): number {
  if (!Number.isFinite(secs)) return AUTO_UPDATE_INTERVAL_DEFAULT_S;
  return Math.min(AUTO_UPDATE_INTERVAL_MAX_S, Math.max(AUTO_UPDATE_INTERVAL_MIN_S, Math.round(secs)));
}

/** A busy-deferred apply retries this soon (capped by the configured interval when it's shorter). */
export const AUTO_UPDATE_BUSY_RETRY_S = 300;
/** Consecutive op-queue deferrals tolerated before applying anyway — see the header. */
export const AUTO_UPDATE_MAX_OPS_DEFERRALS = 6;

// ── injectable side-effects (real impls by default; lifecycle wires `relaunch`, tests swap all) ──
export interface AutoUpdateHooks {
  check: typeof checkForUpdate;
  apply: typeof applyUpdate;
  /** Restart the daemon so the freshly-pulled code takes over. Wired by src/cli/lifecycle.ts. */
  relaunch: () => void;
  /** Whether an agent has a mutating MCP call awaiting approval right now. Real impl reads
   *  src/approvals.ts; tests fake it so the busy-deferral case doesn't need a real pending approval. */
  hasPendingApprovals: () => boolean;
  /** Whether a git/file mutation is queued or running through the per-repo op-queue right now.
   *  Real impl reads src/opqueue.ts; tests fake it the same way as hasPendingApprovals. */
  hasActiveOperations: () => boolean;
}
function defaultRelaunch(): void {
  // No relaunch handler wired (e.g. createApp() in a test) — the update is applied on disk and takes
  // effect on the next manual restart. Never exit here; we don't own a successor.
  console.warn("repoyeti: auto-update applied, but no relaunch handler is wired — restart to apply the new code.");
}
const realHooks: AutoUpdateHooks = {
  check: checkForUpdate,
  apply: applyUpdate,
  relaunch: defaultRelaunch,
  hasPendingApprovals: () => listPending().length > 0,
  hasActiveOperations,
};
let hooks: AutoUpdateHooks = realHooks;
/** Override the side-effect hooks (lifecycle sets `relaunch`; tests inject fakes for all three so
 *  nothing pulls/spawns/exits). Passing `{}` restores the real hooks. */
export function setAutoUpdateHooks(h: Partial<AutoUpdateHooks>): void {
  hooks = { ...realHooks, ...h };
  // A fresh hook set is a fresh world (boot, or a test's arrange step) — no deferral history.
  opsDeferrals = 0;
}

// ── runtime state (mirrors cfg.autoUpdate*; primed at boot in app.ts, toggled on the settings route) ──
let enabled = false; // auto-APPLY: OFF by default — it restarts the daemon → opt-in
let notifyEnabled = true; // auto-NOTIFY: ON by default — it only tells you, and never acts
let intervalSecs = AUTO_UPDATE_INTERVAL_DEFAULT_S;
let started = false; // true only after the daemon finishes booting (startAutoUpdate)
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let applying = false; // an apply is in flight — never overlap checks/applies
let opsDeferrals = 0; // consecutive op-queue busy-deferrals — capped, see the header

export function autoUpdateEnabled(): boolean {
  return enabled;
}
export function updateNotifyEnabled(): boolean {
  return notifyEnabled;
}
/** Toggle "tell me about updates" (PUT /api/settings). Re-arms the shared timer. */
export function setUpdateNotifyEnabled(on: boolean): void {
  notifyEnabled = on;
  reconcile();
}
export function getAutoUpdateIntervalSecs(): number {
  return intervalSecs;
}

/** Outcome of one check→apply→relaunch pass. Returned (not just logged) so it's unit-testable. */
export interface AutoUpdateRunResult {
  checked: boolean;
  applied: boolean;
  relaunched: boolean;
  reason?: string;
}

/**
 * One check → maybe apply → maybe relaunch. Applies ONLY when the engine reports an update is
 * available AND applicable (`canApply`: clean tree, on a branch with an update remote) — so a dirty
 * working tree is never touched. On a successful apply that needs a restart, it fires the injected
 * relaunch. Exported + returns a result so the timer AND the test can drive it identically.
 */
export async function runAutoUpdateOnce(): Promise<AutoUpdateRunResult> {
  if (applying) return { checked: false, applied: false, relaunched: false, reason: "busy" };
  let status: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    status = await hooks.check();
  } catch {
    return { checked: false, applied: false, relaunched: false, reason: "check-failed" };
  }
  if (!status.ok) return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "check-error" };
  if (!status.updateAvailable) return { checked: true, applied: false, relaunched: false, reason: "up-to-date" };

  // An update exists. Unless the owner opted into silent installs, this is where it stops: say so
  // and let them choose. Announced even when `canApply` is false (dirty tree) — "an update is
  // waiting, commit your work to take it" is exactly the useful thing to know at that moment, and
  // the UI shows the reason.
  if (!enabled) {
    if (notifyEnabled) {
      broadcast("update_available", {
        from: status.currentCommit,
        to: status.remoteCommit,
        canApply: status.canApply,
        reason: status.reason ?? null,
      });
      return { checked: true, applied: false, relaunched: false, reason: "notified" };
    }
    return { checked: true, applied: false, relaunched: false, reason: "notify-off" };
  }

  // Hard gate: canApply is false on a dirty tree / detached HEAD / no update remote — never update then.
  if (!status.canApply) {
    // Still worth announcing: an update is waiting and something (usually a dirty tree) is in
    // the way, which is a thing the owner can resolve.
    if (notifyEnabled) {
      broadcast("update_available", {
        from: status.currentCommit,
        to: status.remoteCommit,
        canApply: false,
        reason: status.reason ?? null,
      });
    }
    return { checked: true, applied: false, relaunched: false, reason: status.reason ?? "cannot-apply" };
  }

  // Busy-deferral: never restart the daemon out from under work in flight. A pending MCP approval
  // means an agent has a mutating call waiting on this daemon RIGHT NOW — defer, uncapped, because
  // the approval's own auto-deny timeout bounds how long that state can last. An active op-queue
  // entry means a git/file op is running this instant; that signal also counts routine background
  // reads, which on a many-repo daemon can stay warm nearly continuously, so it is honored for at
  // most AUTO_UPDATE_MAX_OPS_DEFERRALS consecutive retries before the apply proceeds anyway (the
  // relaunch shuts down gracefully; an updater that can be starved forever is the worse bug).
  // Deferrals retry in AUTO_UPDATE_BUSY_RETRY_S (see runTick), not a full interval. Only reached
  // on the apply path (the notify branch above already returned), so this never delays telling the
  // owner an update exists — only the unattended relaunch waits.
  if (hooks.hasPendingApprovals()) {
    return { checked: true, applied: false, relaunched: false, reason: "deferred" };
  }
  if (hooks.hasActiveOperations() && opsDeferrals < AUTO_UPDATE_MAX_OPS_DEFERRALS) {
    opsDeferrals++;
    return { checked: true, applied: false, relaunched: false, reason: "deferred" };
  }
  opsDeferrals = 0;

  applying = true;
  try {
    broadcast("auto_update_applying", { from: status.currentCommit, to: status.remoteCommit });
    const res = await hooks.apply();
    if (!res.ok) return { checked: true, applied: false, relaunched: false, reason: "apply-failed" };
    if (res.restartRequired) {
      broadcast("auto_update_restarting", { message: res.message });
      hooks.relaunch();
      return { checked: true, applied: true, relaunched: true };
    }
    return { checked: true, applied: true, relaunched: false };
  } catch {
    return { checked: true, applied: false, relaunched: false, reason: "apply-threw" };
  } finally {
    applying = false;
  }
}

// ── timer plumbing (mirrors auto-commit.ts) ───────────────────────────────────────────────────
function schedule(delaySecs: number = intervalSecs): void {
  timer = setTimeout(() => void runTick(), delaySecs * 1000);
}
async function runTick(): Promise<void> {
  timer = null;
  ticking = true;
  let deferred = false;
  try {
    deferred = (await runAutoUpdateOnce()).reason === "deferred";
  } catch {
    /* a round failing is non-fatal — we just try again next window */
  } finally {
    ticking = false;
  }
  // A busy-deferred apply means "wait for idle", so look for idle SOON — waiting a whole check
  // interval (default 6h) would turn a 30-second busy blip into a half-day update delay.
  if (started && (enabled || notifyEnabled) && !timer) {
    schedule(deferred ? Math.min(AUTO_UPDATE_BUSY_RETRY_S, intervalSecs) : intervalSecs);
  }
}
/** Bring the timer in line with the current enabled/started state (idempotent). */
function reconcile(): void {
  if (!started) return;
  if ((enabled || notifyEnabled) && !timer && !ticking) schedule();
  else if (!enabled && !notifyEnabled && timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Re-arm a running loop with the current cadence (no-op when idle or mid-tick). */
function retime(): void {
  if (started && (enabled || notifyEnabled) && !ticking) {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }
}

/** Begin the loop once the daemon has booted (src/cli/lifecycle.ts). The first check is one interval
 *  out (never in the boot stampede, so a fresh launch is never interrupted by an immediate restart).
 *  No-op beyond arming when auto-update is disabled. */
export function startAutoUpdate(): void {
  started = true;
  reconcile();
}
/** Stop the loop (daemon shutdown). Safe to call when it was never started. */
export function stopAutoUpdate(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
/** Enable/disable (config at boot + PUT /api/settings). Starts/stops the timer live. */
export function setAutoUpdateEnabled(value: boolean): void {
  enabled = value;
  reconcile();
}
/** Set the check cadence in seconds (clamped). Re-times a running loop. Returns the clamped value. */
export function setAutoUpdateIntervalSecs(secs: number): number {
  intervalSecs = clampAutoUpdateInterval(secs);
  retime();
  return intervalSecs;
}
