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
import { refreshRepo } from "./core.ts";
import { watchOne } from "./watch.ts";

// The in-flight scan's abort controller, or null when idle. Guards single-flight + cancel.
let active: AbortController | null = null;

/** Whether a scan is currently running. */
export function isScanning(): boolean {
  return active !== null;
}

/** Abort the in-flight scan, if any. Returns whether a scan was actually running. */
export function cancelScan(): boolean {
  if (!active) return false;
  active.abort();
  return true;
}

/** How often (in repos found) to emit a progress heartbeat, so a huge tree can't flood SSE. */
const PROGRESS_EVERY = 10;

// Whole-machine / scoped scans reach far more of the disk than a targeted root, so they run with a
// generous repo cap, a deep limit, a wall-clock budget, and real concurrency — a serial walk would
// spend the entire budget on the first drive and never reach the next. Tuned to finish a typical
// machine well inside the budget while never hanging the daemon.
//
// The repo cap here is intentionally NOT the same field as the owner-configured `cfg.maxRepos`
// (that knob guards the inotify/fs-watch budget for a single explicit root; see discoverRoot).
// A whole-machine/folder sweep needs its own much higher floor so a large machine isn't silently
// truncated; `effectiveMaxRepos` lets an owner who deliberately raises `cfg.maxRepos` above this
// floor actually get the larger cap everywhere, instead of the two limits silently diverging.
const MACHINE_MAX_REPOS_FLOOR = 5000;
const FOLDER_MAX_REPOS_FLOOR = 5000;
const MACHINE = { maxDepth: 12, budgetMs: 45_000, concurrency: 48 } as const;
const FOLDER = { maxDepth: 16, budgetMs: 30_000, concurrency: 24 } as const;

/** cfg.maxRepos if the owner raised it above the built-in floor, else the floor itself. */
function effectiveMaxRepos(floor: number): number {
  const configured = loadConfig().maxRepos;
  return Number.isFinite(configured) && configured > floor ? configured : floor;
}

export interface ScanSummary {
  found: number;
  added: number;
  cancelled: boolean;
}

type ScanLimits = { maxDepth: number; maxRepos: number; budgetMs: number; concurrency: number };

/**
 * Shared scan runner: fire-and-forget from the route. Repos stream in live via `repo_added` (new
 * ones only), progress via `scan_progress`, and the run ends with `scan_done` or `scan_cancelled`.
 * A no-op returning a zeroed summary if a scan is already running (single-flight).
 */
async function runScan(scope: string, roots: string[], limits: ScanLimits): Promise<ScanSummary> {
  if (active) return { found: 0, added: 0, cancelled: false };
  const controller = new AbortController();
  active = controller;

  // Snapshot what we already knew, so we only announce/count genuinely-new repos (mirrors the
  // boot-discovery new-vs-known check in cli/lifecycle.ts).
  const knownIds = new Set(getRepos().map((r) => r.id));
  let found = 0;
  let added = 0;

  broadcast("scan_started", { scope, roots: roots.length });
  try {
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
        void refreshRepo(id, f.absPath).catch(() => {});
        found++;
        if (!knownIds.has(id)) {
          const repo = getRepo(id);
          if (repo) {
            added++;
            broadcast("repo_added", { repo });
          }
        }
        if (found % PROGRESS_EVERY === 0) broadcast("scan_progress", { found, added });
      },
      controller.signal,
      { budgetMs: limits.budgetMs, concurrency: limits.concurrency },
    );
  } finally {
    active = null;
  }

  const cancelled = controller.signal.aborted;
  broadcast(cancelled ? "scan_cancelled" : "scan_done", { found, added, cancelled });
  return { found, added, cancelled };
}

/** Sweep the whole machine (home + every drive) for repositories. The dashboard's default scan. */
export function rescanMachine(): Promise<ScanSummary> {
  return runScan("machine", machineScanRoots(), {
    ...MACHINE,
    maxRepos: effectiveMaxRepos(MACHINE_MAX_REPOS_FLOOR),
  });
}

/** Sweep a single folder (and its subfolders) the owner chose. */
export function rescanFolder(folder: string): Promise<ScanSummary> {
  return runScan("folder", [resolve(folder)], {
    ...FOLDER,
    maxRepos: effectiveMaxRepos(FOLDER_MAX_REPOS_FLOOR),
  });
}
