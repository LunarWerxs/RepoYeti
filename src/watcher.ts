/**
 * Per-repo filesystem watching — event-driven, never polling.
 *
 * We watch Git's administrative directory, its logs, and the small refs subtree — never
 * the working tree. Those paths carry every signal we care about:
 *   • .git/index        → staging changes
 *   • .git/HEAD         → branch switch / detach
 *   • .git/logs/HEAD    → commits, checkouts, resets, merges, fetch/pull
 *   • common-dir/refs/** → external branch, remote-ref, and nested-tag changes
 *   • common-dir/packed-refs / reftable → packed ref changes
 * Linked worktrees are resolved through their `.git` and `commondir` files. The refs watcher
 * is recursive so nested tag/branch namespaces need only one descriptor; when the runtime or
 * OS cannot provide it, the handle reports unhealthy and the service falls back to polling.
 * That's still only ~3 descriptors for a normal repo, versus thousands if we naively watched
 * the working tree. Bursts are debounced.
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

/** Narrow injectable seam for deterministic watcher-failure tests. */
export type WatchFactory = (
  path: string,
  options: { persistent: boolean; recursive: boolean },
  listener: () => void,
) => FSWatcher;

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

  const trigger = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const markUnhealthy = (): void => {
    healthy = false;
    // Once any required part of the native coverage fails, partial watchers only waste
    // descriptors and can duplicate the polling refreshes. Tear down the set as one unit.
    closeWatchers();
    if (unhealthyNotified || closed) return;
    unhealthyNotified = true;
    try {
      onUnhealthy?.();
    } catch {
      // Never let an observer error escape an FSWatcher EventEmitter callback.
    }
  };

  const addWatch = (path: string, recursive = false, required = true): boolean => {
    if (watchers.has(path)) return true;
    if (!existsSync(path)) return false;
    try {
      const handle = watchFactory(path, { persistent: true, recursive }, () => trigger());
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
