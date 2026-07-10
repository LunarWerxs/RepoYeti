/**
 * Per-repo filesystem watching — event-driven, never polling.
 *
 * We watch the `.git` directory and `.git/logs` directory (both non-recursive),
 * not the working tree. Those two directories carry every signal we care about:
 *   • .git/index        → staging changes
 *   • .git/HEAD         → branch switch / detach
 *   • .git/logs/HEAD    → commits, checkouts, resets, merges, fetch/pull
 * That's ~2 watch descriptors per repo (respecting Linux inotify limits), versus
 * thousands if we naively watched the whole tree. Bursts are debounced.
 */
import { watch, existsSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface WatchHandle {
  close(): void;
  /**
   * True when the primary `.git` watch was actually installed — i.e. live updates work.
   * False means `fs.watch` was unsupported or hit an OS limit (e.g. inotify budget); the
   * caller should fall back to polling instead of silently going stale.
   */
  readonly watching: boolean;
}

export function watchRepo(
  absPath: string,
  onChange: () => void,
  marker = ".git",
  debounceMs = 250,
): WatchHandle {
  const markerDir = join(absPath, marker);
  const logsDir = join(markerDir, "logs");
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const addDir = (dir: string): boolean => {
    if (!existsSync(dir)) return false;
    try {
      watchers.push(watch(dir, { persistent: true }, () => trigger()));
      return true;
    } catch {
      /* watch unsupported / limit hit — report unhealthy so the caller can poll */
      return false;
    }
  };

  // The marker dir (.git / .lore) carries the signals we care about; its `logs` subdir
  // (git only) is a bonus. Health hinges on the former — if even that couldn't be
  // installed, this repo needs polling. A missing logs dir (e.g. Lore) just no-ops.
  const gitWatched = addDir(markerDir);
  addDir(logsDir);

  return {
    watching: gitWatched,
    close(): void {
      if (timer) clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
