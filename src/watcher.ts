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
}

export function watchRepo(absPath: string, onChange: () => void, debounceMs = 250): WatchHandle {
  const gitDir = join(absPath, ".git");
  const logsDir = join(gitDir, "logs");
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const addDir = (dir: string): void => {
    if (!existsSync(dir)) return;
    try {
      watchers.push(watch(dir, { persistent: true }, () => trigger()));
    } catch {
      /* watch unsupported / limit hit — degrade quietly (Phase 5 adds poll fallback) */
    }
  };

  addDir(gitDir);
  addDir(logsDir);

  return {
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
