/**
 * Git-repo discovery — a bounded, cancellable directory walk.
 *
 * Finds directories containing a `.git`. A `.git` *directory* is a real repo; a
 * `.git` *file* is a submodule/worktree pointer — we record it but flag it so the
 * watcher skips it (it would otherwise burn the watch budget and double-count).
 * We do NOT descend into a repo's working tree (a repo is a discovery leaf), and we
 * skip the usual heavy/irrelevant directories plus OS/system trees so a whole-drive
 * scan doesn't drown in `Windows` / `Program Files` / game libraries.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { isLoreEnabled } from "./vcs/index.ts";
import type { VcsKind } from "./vcs/types.ts";

// Directories we never descend into. Compared case-insensitively (Windows folder names
// vary in case). Dotdirs (incl. `.git`, `.next`, `.venv`) are skipped separately, so they
// don't need listing here. Kept broad on purpose: at whole-machine scale, walking these
// trees is pure waste — none of them hold a source repo we'd want to surface.
const SKIP_DIRS = new Set(
  [
    // build / dependency / cache output
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "venv",
    "__pycache__",
    "bower_components",
    ".cache",
    ".turbo",
    ".next",
    ".nuxt",
    ".parcel-cache",
    "coverage",
    // transient/temp trees, wherever they live (not just under AppData; a custom TEMP/TMP env
    // or a stray top-level "Temp"/"tmp" folder on any drive should never be walked either; this
    // is what let test-fixture directories like `%TEMP%\gm-*` get indexed by whole-machine scans
    // run under a different TEMP location than the default AppData one).
    "temp",
    "tmp",
    // OS + user-data trees
    "library",
    "appdata",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "perflogs",
    "windowsapps",
    "msocache",
    "$windows.~bt",
    "$windows.~ws",
    // game / storefront libraries (huge, never repos)
    "steamlibrary",
    "steamapps",
    "epic games",
    "gog galaxy",
    "riot games",
    "battle.net",
    "origin games",
    "ea games",
    "ubisoft",
    "xboxgames",
  ].map((s) => s.toLowerCase()),
);

export interface FoundRepo {
  absPath: string;
  name: string;
  isSubmodule: boolean;
  /** Which VCS this working copy belongs to (".git" → git, ".lore" → lore). */
  vcs: VcsKind;
}

/** Tuning knobs for a walk. Defaults preserve the original serial, unbounded-time behavior. */
export interface DiscoverOptions {
  /** Wall-clock ceiling for the whole walk (ms). Omit or 0 = no time limit. */
  budgetMs?: number;
  /** Max directories read concurrently. Default 1 (serial). Higher = far faster on big trees. */
  concurrency?: number;
}

/**
 * Roots for a whole-machine scan: the user's home dir first (most repos live under it, so
 * they surface fast), then every existing fixed drive root. On non-Windows: home + "/".
 * Overlap (home lives under a drive root) is de-duped by the walk, so listing both is safe.
 */
export function machineScanRoots(): string[] {
  const home = homedir();
  const roots = [home];
  if (process.platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (existsSync(root)) roots.push(root);
    }
  } else {
    roots.push("/");
  }
  return roots;
}

/**
 * Discover git repos under `roots`, reporting each via `onFound` the instant it's seen so the
 * caller can index/watch it live. Built on `fs.promises.readdir` (yields to the event loop) with
 * a bounded work-pool that interleaves all roots — so a whole-machine scan makes progress on
 * every drive within the time budget instead of spending it all on the first drive (a serial
 * depth-first walk would never reach `D:\` if `C:\` is large).
 *
 * Bounding is by `maxDepth`, the `maxRepos` cap, an optional wall-clock `budgetMs`, and an
 * optional `AbortSignal` (the "Scan for projects" modal's Stop). Repos already reported before a
 * stop stay reported; the walk simply stops descending. Returns the number of repos found.
 */
export async function discoverStream(
  roots: string[],
  maxDepth: number,
  maxRepos: number,
  onFound: (repo: FoundRepo) => void,
  signal?: AbortSignal,
  opts: DiscoverOptions = {},
): Promise<number> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const deadline =
    opts.budgetMs && opts.budgetMs > 0 ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const lore = isLoreEnabled();
  let count = 0;

  const seenRepos = new Set<string>(); // dedupe reported repos
  const seenDirs = new Set<string>(); // dedupe traversal (overlapping roots: home ⊂ C:\)
  const dirKey = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

  const queue: Array<{ dir: string; depth: number }> = [];
  let queueHead = 0;
  const enqueue = (dir: string, depth: number): void => {
    const k = dirKey(dir);
    if (seenDirs.has(k)) return;
    seenDirs.add(k);
    queue.push({ dir, depth });
  };
  for (const root of roots) {
    if (existsSync(root)) enqueue(root, 0);
  }

  const stop = (): boolean =>
    count >= maxRepos || signal?.aborted === true || Date.now() >= deadline;

  // Read one directory: report it as a repo (a leaf — we don't descend) or enqueue its children.
  const processDir = async (dir: string, depth: number): Promise<void> => {
    if (stop()) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / vanished — skip silently
    }
    // Another concurrent read may have reached the repo cap (or the caller may have
    // cancelled) while this directory was in flight.
    if (stop()) return;

    const gitEntry = entries.find((e) => e.name === ".git");
    const loreEntry = lore ? entries.find((e) => e.name === ".lore" && e.isDirectory()) : undefined;
    if (gitEntry || loreEntry) {
      if (!seenRepos.has(dir)) {
        seenRepos.add(dir);
        count++;
        onFound({
          absPath: dir,
          name: basename(dir) || dir,
          isSubmodule: gitEntry ? gitEntry.isFile() : false,
          vcs: gitEntry ? "git" : "lore",
        });
      }
      return; // a repo is a discovery leaf — don't recurse into its tree
    }

    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue; // symlinked dirs report isDirectory()===false → never followed
      if (e.name.startsWith(".")) continue; // hidden dirs (incl. already-handled .git)
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      enqueue(join(dir, e.name), depth + 1);
    }
  };

  // Bounded work-pool: keep up to `concurrency` readdirs in flight until the frontier drains
  // or a stop condition trips.
  await new Promise<void>((resolveWalk) => {
    let inFlight = 0;
    let settled = false;
    let abortListener: (() => void) | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      resolveWalk();
    };

    // A mapped/removable drive can leave readdir pending indefinitely. Enforce the advertised
    // whole-walk deadline independently of completions, and likewise stop immediately on abort.
    if (Number.isFinite(deadline)) {
      deadlineTimer = setTimeout(settle, Math.max(0, deadline - Date.now()));
      deadlineTimer.unref?.();
    }
    if (signal) {
      abortListener = settle;
      if (signal.aborted) settle();
      else signal.addEventListener("abort", abortListener, { once: true });
    }

    const pump = (): void => {
      if (settled) return;
      if (inFlight === 0 && (queueHead >= queue.length || stop())) {
        settle();
        return;
      }
      while (inFlight < concurrency && queueHead < queue.length && !stop()) {
        // Indexed FIFO avoids Array.shift() copying the entire machine-scan frontier for
        // every directory visited.
        const job = queue[queueHead++]!;
        inFlight++;
        void processDir(job.dir, job.depth).finally(() => {
          inFlight--;
          pump();
        });
      }
    };
    pump();
  });

  return count;
}
