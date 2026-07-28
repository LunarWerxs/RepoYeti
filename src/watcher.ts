/**
 * Per-repo filesystem watching — event-driven, never polling.
 *
 * The REQUIRED coverage still watches only Git's administrative directory, its logs, and the
 * small refs subtree — never the working tree. Those paths carry every signal we care about:
 *   • .git/index        → staging changes
 *   • .git/HEAD         → branch switch / detach
 *   • .git/logs/HEAD    → commits, checkouts, resets, merges, fetch/pull
 *   • common-dir/refs/** → external branch, remote-ref, and nested-tag changes
 *   • common-dir/packed-refs / reftable → packed ref changes
 * Linked worktrees are resolved through their `.git` and `commondir` files. The refs watcher
 * is recursive so nested tag/branch namespaces need only one descriptor; when the runtime or
 * OS cannot provide it, the handle reports unhealthy and the service falls back to polling.
 * That's still only ~3 descriptors for a normal repo, versus thousands if we naively watched
 * every directory in the working tree one by one.
 *
 * On top of that we add ONE more, BONUS (non-required) descriptor: a recursive watch on the
 * working-tree root itself, so a plain on-disk edit/delete that never touches .git (e.g.
 * deleting a file in Explorer) fires a refresh instead of waiting for the ~30-40s poll
 * fallback. Whether that single extra descriptor is actually cheap depends on the platform:
 *   • Windows — `fs.watch(root, { recursive: true })` is ONE ReadDirectoryChangesW handle.
 *     Same order of cost as the .git watches above. Enabled.
 *   • macOS — recursive fs.watch is backed by FSEvents, also one native handle. Enabled.
 *   • Linux — Node has no native recursive primitive; it emulates `recursive: true` by
 *     walking the tree and opening one inotify watch per directory, which is exactly the
 *     "thousands of descriptors" cost this file exists to avoid. Left disabled; Linux keeps
 *     the .git-only behavior above (a bare working-tree change still surfaces, just via the
 *     poll fallback instead of near-instantly).
 * Being non-required, an unsupported platform or a native failure never marks the handle
 * unhealthy — only the .git coverage above does that. Its listener filters BEFORE debouncing:
 * events under the VCS marker dir (.git/.lore) are dropped (the required watchers above
 * already cover that churn, so counting it again would just double-fire), and events under
 * common build/dependency dirs (node_modules, dist, build, out, target, .next, coverage,
 * __pycache__, .venv, .turbo, .cache) are dropped too, since those are almost always
 * gitignored and can't change repo status. It also gets its own, longer debounce than the
 * .git watchers: a build or checkout can touch hundreds of files in one burst, much noisier
 * than .git churn. REPOYETI_NO_WORKTREE_WATCH=1 disables this bonus watch entirely.
 */
import {
  watch,
  existsSync,
  readFileSync,
  statSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface WatchHandle {
  close(): void;
  /**
   * True when the primary `.git` watch was actually installed — i.e. live updates work.
   * False means `fs.watch` was unsupported or hit an OS limit (e.g. inotify budget); the
   * caller should fall back to polling instead of silently going stale.
   */
  readonly watching: boolean;
}

/** Narrow injectable seam for deterministic watcher-failure tests. Real `fs.watch` invokes the
 *  listener with (eventType, filename); the worktree watch below needs `filename` to filter,
 *  while the .git watchers ignore both and pass a zero-arg listener — both shapes fit here. */
export type WatchFactory = (
  path: string,
  options: { persistent: boolean; recursive: boolean },
  listener: (eventType?: string, filename?: string | null) => void,
) => FSWatcher;

// Build/dependency dirs that are almost always gitignored: an event under one of these can't
// change `git status`, so refreshing for it is pure waste. Checked as a whole path segment,
// not a substring, so a real directory like "outer" doesn't false-match "out".
const IGNORED_WORKTREE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  ".turbo",
  ".cache",
]);

// A build/checkout can touch hundreds of working-tree files within tens of milliseconds, and
// editors commonly write-then-rename (temp file + rename lands as two events ~50-150ms apart).
// 500ms — 2x the .git debounce — comfortably folds a whole burst into one refresh while still
// landing well inside the "feels live" ~1s window, and nowhere close to the 30s poll fallback.
// It is a per-EVENT delay on the shared timer (see trigger below), not a second timer.
const WORKTREE_DEBOUNCE_MS = 500;

const WORKTREE_WATCH_SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);

/**
 * True when `filename` (relative to the watched root, as fs.watch reports it) should be
 * ignored by the bonus worktree watch: either it's inside the VCS marker dir (already covered
 * by the required .git/.lore watchers above, so re-counting it would just double-fire) or
 * inside a build/dependency dir that can't affect repo status. `filename === null` (Node/Bun
 * sometimes can't determine it, e.g. under load or on some network filesystems) is treated
 * conservatively — NOT ignored — since we'd rather do one extra refresh than silently drop a
 * real change we can't identify.
 */
function isIgnoredWorktreeEvent(filename: string | null | undefined, marker: string): boolean {
  if (filename == null) return false;
  const segments = filename.split(/[\\/]/);
  // Build dirs are checked at EVERY depth, not just the first segment: a workspace repo has
  // `web/node_modules` and `services/*/dist` as well as root-level ones, and this repo itself
  // is one — a first-segment-only test let every `web/node_modules` write through, which is
  // precisely the churn the filter exists to stop.
  if (segments.some((s) => IGNORED_WORKTREE_DIRS.has(s))) return true;
  // The marker, though, only counts at the ROOT: `.git` deeper down is a SUBMODULE's admin dir,
  // and a submodule's HEAD moving does change the parent's `git status` ("modified: sub (new
  // commits)"), so dropping it at any depth would hide a real change.
  return segments[0] === marker;
}

interface MarkerLayout {
  markerPath: string;
  gitDir: string;
  commonDir: string;
  isGit: boolean;
}

/**
 * Resolve a normal checkout (`.git/`), linked worktree (`.git` file + `commondir`), or a
 * non-Git marker such as `.lore`. This is filesystem-only so installing a watcher never
 * starts another VCS process.
 */
function markerLayout(absPath: string, marker: string): MarkerLayout {
  const markerPath = join(absPath, marker);
  if (marker !== ".git") {
    return { markerPath, gitDir: markerPath, commonDir: markerPath, isGit: false };
  }

  let gitDir = markerPath;
  try {
    if (statSync(markerPath).isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(readFileSync(markerPath, "utf8"));
      if (match?.[1]) gitDir = resolve(dirname(markerPath), match[1]);
    }
  } catch {
    // Keep the unresolved marker path: addWatch below will report the watcher unhealthy.
  }

  let commonDir = gitDir;
  try {
    const value = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (value) commonDir = resolve(gitDir, value);
  } catch {
    // A normal checkout has no commondir file; its git dir is also its common dir.
  }
  return { markerPath, gitDir, commonDir, isGit: true };
}

export function watchRepo(
  absPath: string,
  onChange: () => void,
  marker = ".git",
  debounceMs = 250,
  onUnhealthy?: () => void,
  watchFactory: WatchFactory = watch as WatchFactory,
): WatchHandle {
  const layout = markerLayout(absPath, marker);
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let healthy = true;
  let unhealthyNotified = false;

  const closeWatchers = (): void => {
    for (const handle of watchers.values()) {
      try {
        handle.close();
      } catch {
        /* ignore */
      }
    }
    watchers.clear();
  };

  /**
   * ONE debounce timer for BOTH sources, with the delay chosen per event.
   *
   * Deliberately not a timer each. Every interesting git operation — checkout, merge, pull,
   * stash pop — touches .git AND rewrites a pile of working-tree files, so two independent
   * timers each fire their own onChange: one at 250ms, a second at 500ms. coalescedRefresh()
   * (src/service/watch.ts) folds a second call only while the first is still in flight, so once
   * the 250ms refresh finishes the 500ms one runs the whole status read again — the bonus watch
   * would have doubled the cost of every branch switch. A single timer, reset by whichever event
   * arrives last, is the actual debounce the two sources want.
   */
  const trigger = (delay = debounceMs): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  };

  const markUnhealthy = (): void => {
    healthy = false;
    // Once any required part of the native coverage fails, partial watchers only waste
    // descriptors and can duplicate the polling refreshes. Tear down the set as one unit.
    closeWatchers();
    // …including anything already armed. The caller is being told to switch to polling; a stray
    // onChange arriving after that is a refresh nobody is expecting from this handle any more.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (unhealthyNotified || closed) return;
    unhealthyNotified = true;
    try {
      onUnhealthy?.();
    } catch {
      // Never let an observer error escape an FSWatcher EventEmitter callback.
    }
  };

  const addWatch = (
    path: string,
    recursive = false,
    required = true,
    listener: (eventType?: string, filename?: string | null) => void = () => trigger(),
  ): boolean => {
    if (watchers.has(path)) return true;
    if (!existsSync(path)) return false;
    try {
      const handle = watchFactory(path, { persistent: true, recursive }, listener);
      // FSWatcher reports some native failures asynchronously. Consume the EventEmitter error
      // and move required coverage to the service's polling fallback instead of crashing or
      // silently leaving History stale.
      handle.on("error", () => {
        try {
          handle.close();
        } catch {
          /* ignore */
        }
        watchers.delete(path);
        if (required) markUnhealthy();
      });
      watchers.set(path, handle);
      return true;
    } catch {
      /* watch unsupported / limit hit — report unhealthy so the caller can poll */
      return false;
    }
  };

  // The resolved marker directory carries HEAD/index; the common directory carries packed
  // refs. Both are required for a linked worktree. The recursive refs watch covers nested
  // local/remote/tag namespaces. Logs and the indirection file are useful bonuses.
  const markerWatched = addWatch(layout.gitDir);
  const commonWatched = addWatch(layout.commonDir);
  const refsWatched = layout.isGit
    ? addWatch(join(layout.commonDir, "refs"), true)
    : true;
  addWatch(join(layout.gitDir, "logs"), false, false);
  // Watch the indirection file too, but don't make health depend on this bonus descriptor.
  if (layout.markerPath !== layout.gitDir) addWatch(layout.markerPath, false, false);
  // Bonus recursive working-tree watch — see the header comment for the platform/filter/
  // debounce rationale. Non-required: an unsupported platform or native failure here never
  // marks the whole handle unhealthy, it just means this one extra signal is unavailable.
  if (
    WORKTREE_WATCH_SUPPORTED_PLATFORMS.has(process.platform) &&
    process.env.REPOYETI_NO_WORKTREE_WATCH !== "1"
  ) {
    addWatch(absPath, true, false, (_eventType, filename) => {
      if (isIgnoredWorktreeEvent(filename, marker)) return;
      trigger(WORKTREE_DEBOUNCE_MS);
    });
  }
  healthy = markerWatched && commonWatched && refsWatched;
  // A missing/unsupported required descriptor is the same degraded state as an asynchronous
  // native error. The service sees `watching === false` and starts its polling fallback.
  if (!healthy) closeWatchers();

  return {
    get watching(): boolean {
      return healthy;
    },
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      closeWatchers();
    },
  };
}
