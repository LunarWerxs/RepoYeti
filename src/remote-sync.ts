/**
 * Background remote-sync check — the "you're behind" early-warning loop.
 *
 * RepoYeti's `behind` count is read straight from `git status`, which only reflects the LAST
 * fetch — a watch event never touches the network (see src/status.ts). So without a periodic
 * fetch the dashboard silently goes stale: a teammate pushes and you'd never know until you
 * fetched by hand. This module runs ONE daemon-wide timer that periodically calls
 * `fetchAllRepos()` (already bounded by the netGate + per-repo op-queue — no new concurrency),
 * which refreshes every repo's ahead/behind and streams it to clients as `repo_state_changed`.
 *
 * On top of that it detects when a repo has *newly* fallen behind — its `behind` rose since the
 * previous check — and broadcasts a single `repo_behind` event so the web UI can warn the owner
 * (an amber card chip, a toast, and, opt-in, a desktop notification). The baseline is seeded from
 * each repo's CURRENT count the first time we see it, so repos that were already behind at boot
 * don't all fire a warning — only genuinely new remote commits do, mirroring how a "git sync"
 * notifier behaves.
 *
 * Enable + cadence are owner settings (cfg.syncCheck / cfg.syncIntervalSecs). The timer is a
 * self-rescheduling setTimeout (never setInterval) so a slow fetch round can't stack overlapping
 * runs. Wired up in src/index.ts (startRemoteSync after boot hydration; stopRemoteSync on
 * shutdown) and toggled live by PUT /api/settings (src/daemon.ts). VCS-agnostic: fetchAllRepos
 * dispatches per backend, and Lore's fetch is a benign no-op (it's centralized), so a Lore repo
 * simply never reports "behind" here.
 */
import { fetchAllRepos, pullRepo } from "./service/index.ts";
import { getWatchableRepos } from "./db.ts";
import { broadcast } from "./bus.ts";
import type { RepoStatus } from "./db.ts";

/** Cadence bounds (seconds): fast enough to be useful, slow enough to be a courteous poll. */
export const SYNC_INTERVAL_MIN_S = 30;
export const SYNC_INTERVAL_MAX_S = 3600;
export const SYNC_INTERVAL_DEFAULT_S = 120;

/** Clamp a requested cadence into [MIN, MAX]; a non-finite value falls back to the default. */
export function clampSyncInterval(secs: number): number {
  if (!Number.isFinite(secs)) return SYNC_INTERVAL_DEFAULT_S;
  return Math.min(SYNC_INTERVAL_MAX_S, Math.max(SYNC_INTERVAL_MIN_S, Math.round(secs)));
}

// ── runtime state (mirrors cfg.syncCheck / cfg.syncIntervalSecs; set at boot + on the toggle) ──
let enabled = true; // absent config = on (matches `cfg.syncCheck !== false` in daemon.ts)
// "Keep in sync": after the check, auto fast-forward repos that can safely take new commits.
// Off by default — auto-pulling mutates the working copy, so it's strictly opt-in.
let keepInSync = false;
let intervalSecs = SYNC_INTERVAL_DEFAULT_S;
let started = false; // true only after the daemon finishes booting (startRemoteSync)
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false; // a fetch round is in flight — don't let a reschedule double-arm the timer
/** repoId → behind count at the previous check, so we only warn on a FRESH fall-behind. */
const lastBehind = new Map<string, number>();

export function syncCheckEnabled(): boolean {
  return enabled;
}
export function keepInSyncEnabled(): boolean {
  return keepInSync;
}
export function getSyncIntervalSecs(): number {
  return intervalSecs;
}

/** One repo that just fell further behind its remote (payload of the `repo_behind` SSE event). */
export interface BehindRepo {
  id: string;
  name: string;
  branch: string | null;
  behind: number;
}

/** One repo the "keep in sync" auto-pull just fast-forwarded (payload of `repo_synced`). */
export interface SyncedRepo {
  id: string;
  name: string;
  /** Commits pulled in (the behind count at fetch time). */
  pulled: number;
}

/**
 * Whether a repo can be safely fast-forwarded with no risk of a conflict or merge: it has a
 * remote, isn't errored/detached, is genuinely behind, has NO local commits to diverge
 * (ahead === 0), and a clean working tree. This mirrors gitPullFfOnly's own preflight, so we
 * never even attempt a pull that the action would refuse — and a real `git pull --ff-only`
 * still self-guards if the tree changed between the check and the pull.
 */
export function canAutoPull(s: RepoStatus | null | undefined): boolean {
  return (
    !!s && !!s.remote && !s.error && !s.detached && s.behind > 0 && s.ahead === 0 && s.dirty === 0
  );
}

/** Minimal repo shape `computeNewlyBehind` reads (a subset of db.ts RepoView). */
interface RepoBehindView {
  id: string;
  name: string;
  status: { behind: number; branch: string | null } | null;
}

/**
 * Pure transition detector (exported for testing). Given the repo lists before and after a fetch
 * plus the running baseline, return the repos that NEWLY fell behind and update the baseline in
 * place: unseen repos are seeded from their pre-fetch count (so a repo already behind at boot
 * doesn't warn), and vanished repos (scan root removed, etc.) are forgotten.
 */
export function computeNewlyBehind(
  pre: RepoBehindView[],
  post: RepoBehindView[],
  baseline: Map<string, number>,
): BehindRepo[] {
  for (const r of pre) if (!baseline.has(r.id)) baseline.set(r.id, r.status?.behind ?? 0);
  const newly: BehindRepo[] = [];
  const seen = new Set<string>();
  for (const r of post) {
    seen.add(r.id);
    const before = baseline.get(r.id) ?? 0;
    const after = r.status?.behind ?? 0;
    if (after > before && after > 0) {
      newly.push({ id: r.id, name: r.name, branch: r.status?.branch ?? null, behind: after });
    }
    baseline.set(r.id, after);
  }
  for (const id of [...baseline.keys()]) if (!seen.has(id)) baseline.delete(id);
  return newly;
}

async function tick(): Promise<void> {
  const pre = getWatchableRepos();
  // Fetch every repo with a remote (bounded by netGate + the per-repo op-queue). Each repo's
  // refreshed ahead/behind already streams to clients as `repo_state_changed` inside this call.
  await fetchAllRepos();
  let post = getWatchableRepos();

  // "Keep in sync": auto fast-forward the repos that can safely take the new commits, then
  // re-read so the behind-warning below only fires for repos we COULDN'T auto-resolve (dirty,
  // diverged, detached) — i.e. the ones that genuinely need the owner's attention.
  if (keepInSync) {
    const pullable = post.filter((r) => canAutoPull(r.status));
    if (pullable.length > 0) {
      const results = await Promise.allSettled(pullable.map((r) => pullRepo(r.id)));
      const synced: SyncedRepo[] = [];
      results.forEach((res, i) => {
        const r = pullable[i]!;
        if (res.status === "fulfilled" && res.value.ok) {
          synced.push({ id: r.id, name: r.name, pulled: r.status?.behind ?? 0 });
        }
      });
      if (synced.length > 0) broadcast("repo_synced", { repos: synced });
      post = getWatchableRepos(); // reflect the fast-forwards before deciding what to warn about
    }
  }

  const newly = computeNewlyBehind(pre, post, lastBehind);
  if (newly.length > 0) broadcast("repo_behind", { repos: newly });
}

function schedule(): void {
  timer = setTimeout(() => void runTick(), intervalSecs * 1000);
}

async function runTick(): Promise<void> {
  timer = null;
  ticking = true;
  try {
    await tick();
  } catch {
    /* a fetch round failing is non-fatal — we just try again next interval */
  } finally {
    ticking = false;
  }
  if (started && enabled && !timer) schedule();
}

/** Bring the timer in line with the current enabled/started state (idempotent). */
function reconcile(): void {
  if (!started) return;
  if (enabled && !timer && !ticking) schedule();
  else if (!enabled && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Begin the loop once the daemon has booted — called from src/index.ts after boot hydration.
 *  No-op (beyond arming) when the check is disabled in config. */
export function startRemoteSync(): void {
  started = true;
  reconcile();
}

/** Stop the loop (daemon shutdown). Safe to call when it was never started. */
export function stopRemoteSync(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  lastBehind.clear();
}

/** Enable/disable the check (config at boot + PUT /api/settings). Starts/stops the timer live. */
export function setSyncCheckEnabled(value: boolean): void {
  enabled = value;
  reconcile();
}

/** Enable/disable auto fast-forward ("keep in sync"). Takes effect on the next tick; no timer
 *  change needed — it only gates what `tick` does, not whether it runs. */
export function setKeepInSync(value: boolean): void {
  keepInSync = value;
}

/** Set the cadence in seconds (clamped). Re-times a running loop. Returns the clamped value. */
export function setSyncIntervalSecs(secs: number): number {
  intervalSecs = clampSyncInterval(secs);
  // Apply the new cadence to a running loop immediately; if a tick is in flight, runTick's tail
  // reschedules with the updated interval, so we leave the rearm to it.
  if (started && enabled && !ticking) {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule();
  }
  return intervalSecs;
}
