/**
 * On-demand "Scan for projects": find repositories on disk, cancellable and progress-reporting
 * over SSE. Two scopes, both driven by the dashboard's Scan modal:
 *   - `rescanMachine()` — sweep the whole machine (home + every drive), the default.
 *   - `rescanFolder(path)` — sweep a single folder the owner chose.
 * Each indexes → watches → status-reads every repo as it's found (mirroring boot discovery in
 * cli/lifecycle.ts) and reports its lifecycle so the modal can show a live "found N" with a Stop.
 *
 * Only ONE scan runs at a time (a second start while one is in flight is a no-op). Repos already
 * known before the scan started are NOT re-announced as "new" — `added` counts only genuinely-new
 * repositories, which drives the "N new projects found" notification.
 */
import { resolve } from "node:path";
import { broadcast } from "../bus.ts";
import { loadConfig } from "../config.ts";
import { getRepo, getRepos, upsertRepo } from "../db.ts";
import { discoverStream, machineScanRoots } from "../discovery.ts";
import { coalescedRefresh, watchOne } from "./watch.ts";
import { createJob } from "./job.ts";

/** Whether a scan is currently running. */
export function isScanning(): boolean {
  return scanJob.isRunning();
}

/** Abort the in-flight scan, if any. Returns whether a scan was actually running. */
export function cancelScan(): boolean {
  return scanJob.cancel();
}

/** How often (in repos found) to emit a progress heartbeat, so a huge tree can't flood SSE. */
const PROGRESS_EVERY = 10;

// Whole-machine / scoped scans reach far more of the disk than a targeted root, so they run with a
// generous repo cap, a deep limit, a wall-clock budget, and real concurrency — a serial walk would
// spend the entire budget on the first drive and never reach the next. Tuned to finish a typical
// machine well inside the budget while never hanging the daemon.
//
const MACHINE = { maxDepth: 12, budgetMs: 45_000, concurrency: 48 } as const;
const FOLDER = { maxDepth: 16, budgetMs: 30_000, concurrency: 24 } as const;

/**
 * Respect the same repository budget for explicit roots and broad scans. The old 5,000-repo
 * minimum defeated the owner's default 200-repo cap, then installed watchers and queued a status
 * hydration for every result. Owners who genuinely need more can still raise `maxRepos`.
 */
function effectiveMaxRepos(): number {
  const configured = loadConfig().maxRepos;
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 200;
}

export interface ScanSummary {
  found: number;
  added: number;
  cancelled: boolean;
}

// Single-flight, cancellable, and the source of the scan_* lifecycle events. Shared with the
// fetch-all job (service/job.ts) so the two cannot drift apart the way two hand-rolled copies do.
const scanJob = createJob<ScanSummary>("scan");

type ScanLimits = { maxDepth: number; maxRepos: number; budgetMs: number; concurrency: number };

/**
 * Shared scan runner: fire-and-forget from the route. Repos stream in live via `repo_added` (new
 * ones only), progress via `scan_progress`, and the run ends with `scan_done` or `scan_cancelled`.
 * A no-op returning a zeroed summary if a scan is already running (single-flight).
 */
async function runScan(scope: string, roots: string[], limits: ScanLimits): Promise<ScanSummary> {
  // Snapshot what we already knew, so we only announce/count genuinely-new repos (mirrors the
  // boot-discovery new-vs-known check in cli/lifecycle.ts).
  const knownIds = new Set(getRepos().map((r) => r.id));
  let found = 0;
  let added = 0;

  const summary = await scanJob.start({ scope, roots: roots.length }, async (run) => {
    await discoverStream(
      roots,
      limits.maxDepth,
      limits.maxRepos,
      (f) => {
        // Same index → watch → refresh sequence as boot/add-root discovery. `watchOne` and
        // `upsertRepo` are idempotent, so re-scanning an already-known repo just refreshes it.
        const id = upsertRepo(f.absPath, f.name, "auto", f.isSubmodule, f.vcs);
        // null → refused (path is under the OS temp dir); SKIP_DIRS already prunes these during
        // the walk, so this should essentially never fire, but never watch/broadcast a null id.
        if (!id) return;
        watchOne(id, f.absPath);
        coalescedRefresh(id, f.absPath);
        found++;
        if (!knownIds.has(id)) {
          const repo = getRepo(id);
          if (repo) {
            added++;
            broadcast("repo_added", { repo });
          }
        }
        if (found % PROGRESS_EVERY === 0) run.progress({ found, added });
      },
      run.signal,
      { budgetMs: limits.budgetMs, concurrency: limits.concurrency },
    );
    return { found, added, cancelled: run.cancelled };
  });
  // null = a scan was already in flight and this start was refused. The zeroed summary is the
  // long-standing answer for that, and the route ignores the value anyway.
  return summary ?? { found: 0, added: 0, cancelled: false };
}

/** Sweep the whole machine (home + every drive) for repositories. The dashboard's default scan. */
export function rescanMachine(): Promise<ScanSummary> {
  return runScan("machine", machineScanRoots(), {
    ...MACHINE,
    maxRepos: effectiveMaxRepos(),
  });
}

/** Sweep a single folder (and its subfolders) the owner chose. */
export function rescanFolder(folder: string): Promise<ScanSummary> {
  return runScan("folder", [resolve(folder)], {
    ...FOLDER,
    maxRepos: effectiveMaxRepos(),
  });
}
