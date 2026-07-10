/**
 * Live filesystem watching: install/tear-down per-repo watchers, coalesce the bursty
 * fire-and-forget refreshes they trigger, and fall back to low-frequency polling when a
 * native watch can't be installed. The user-facing paths (runAction, forceRefresh) still
 * await refreshRepo directly in core.ts, so their returned result stays exact.
 */
import { getRepo, getWatchableRepos } from "../db.ts";
import { backendFor } from "../vcs/index.ts";
import { watchRepo, type WatchHandle } from "../watcher.ts";
import { forgetQueue } from "../opqueue.ts";
import { refreshRepo, lastStatusSig } from "./core.ts";

// ── watcher registry (lets repos registered/created at runtime get watched live) ──
const watchHandles = new Map<string, WatchHandle>();
// Repos whose fs.watch couldn't be installed run a low-frequency polling fallback so
// they don't silently go stale; the timer ids live here keyed by repo id.
const pollHandles = new Map<string, ReturnType<typeof setTimeout>>();
// Repo ids whose live watch is unhealthy (watch failed → polling). For diagnostics.
const unhealthyWatch = new Set<string>();

// Watcher/poll refreshes are fire-and-forget and bursty; collapse them per repo to at most
// one in-flight + one trailing pass, so a flurry of fs events (or refreshes piling up behind
// a slow 30s git read) can't stack into a deep queue of soon-obsolete status reads. The
// user-facing paths (runAction, forceRefresh) still await refreshRepo directly, so their
// returned result stays exact.
const refreshBusy = new Set<string>();
const refreshAgain = new Set<string>();

export function coalescedRefresh(repoId: string, absPath: string): void {
  if (refreshBusy.has(repoId)) {
    refreshAgain.add(repoId); // a read is already running for this repo — fold into a trailing pass
    return;
  }
  refreshBusy.add(repoId);
  void refreshRepo(repoId, absPath).finally(() => {
    refreshBusy.delete(repoId);
    if (refreshAgain.delete(repoId)) coalescedRefresh(repoId, absPath);
  });
}

/**
 * Re-read every watched repo (coalesced, fire-and-forget). Used when the diff-stats
 * setting flips, so each card's aggregate stat appears/clears right away instead of
 * waiting for the next filesystem event.
 */
export function refreshAllRepos(): void {
  for (const r of getWatchableRepos()) coalescedRefresh(r.id, r.absPath);
}

/** Base/jitter for the watch-failure poll fallback — slow and spread out, since this is
 *  a degraded path, not the primary signal. Jitter avoids a synchronized poll stampede. */
const POLL_BASE_MS = 30_000;
const POLL_JITTER_MS = 10_000;
const nextPollDelay = (): number => POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS);

function startPollFallback(repoId: string, absPath: string): void {
  if (pollHandles.has(repoId)) return;
  unhealthyWatch.add(repoId);
  console.warn(
    `repoyeti: filesystem watch unavailable for ${absPath} — using ~${Math.round(POLL_BASE_MS / 1000)}s polling. ` +
      `Live updates may lag; check OS watch limits (e.g. fs.inotify.max_user_watches on Linux).`,
  );
  const tick = (): void => {
    coalescedRefresh(repoId, absPath);
    pollHandles.set(repoId, setTimeout(tick, nextPollDelay())); // self-reschedule with fresh jitter
  };
  pollHandles.set(repoId, setTimeout(tick, nextPollDelay()));
}

export function watchOne(repoId: string, absPath: string): void {
  if (watchHandles.has(repoId)) return;
  // Watch the VCS's marker dir (.git / .lore) so a Lore repo's metadata changes still tick.
  const marker = backendFor(getRepo(repoId)?.vcs ?? "git").marker;
  const handle = watchRepo(absPath, () => coalescedRefresh(repoId, absPath), marker);
  watchHandles.set(repoId, handle);
  if (!handle.watching) startPollFallback(repoId, absPath);
}
/** Tear down a single repo's watcher/poll/registries (used when a scan root is removed). */
export function unwatchOne(repoId: string): void {
  const h = watchHandles.get(repoId);
  if (h) {
    h.close();
    watchHandles.delete(repoId);
  }
  const t = pollHandles.get(repoId);
  if (t) {
    clearTimeout(t);
    pollHandles.delete(repoId);
  }
  unhealthyWatch.delete(repoId);
  refreshBusy.delete(repoId);
  refreshAgain.delete(repoId);
  lastStatusSig.delete(repoId);
  forgetQueue(repoId); // drop the op-queue chain too, so `chains` doesn't leak per removed repo
}
export function startWatching(repos: Array<{ id: string; absPath: string }>): void {
  for (const r of repos) watchOne(r.id, r.absPath);
}
export function stopWatching(): void {
  for (const h of watchHandles.values()) h.close();
  watchHandles.clear();
  for (const t of pollHandles.values()) clearTimeout(t);
  pollHandles.clear();
  unhealthyWatch.clear();
  refreshBusy.clear();
  refreshAgain.clear();
}

/** Watcher health snapshot for diagnostics/tests: how many repos are watched live vs
 *  degraded to polling, and which ids are degraded. */
export function watcherHealth(): { watched: number; polling: number; unhealthy: string[] } {
  return { watched: watchHandles.size, polling: pollHandles.size, unhealthy: [...unhealthyWatch] };
}
