/**
 * Recursive git-repo discovery (BFS, depth-limited).
 *
 * Finds directories containing a `.git`. A `.git` *directory* is a real repo; a
 * `.git` *file* is a submodule/worktree pointer — we record it but flag it so the
 * watcher skips it (it would otherwise burn the watch budget and double-count).
 * We do NOT descend into a repo's working tree (no scanning node_modules etc.),
 * and we skip the usual heavy/irrelevant directories.
 */
import { readdirSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "Library",
  "AppData",
]);

export interface FoundRepo {
  absPath: string;
  name: string;
  isSubmodule: boolean;
}

export function discover(roots: string[], maxDepth: number, maxRepos: number): FoundRepo[] {
  const found: FoundRepo[] = [];
  const seen = new Set<string>();

  const visit = (dir: string, depth: number): void => {
    if (found.length >= maxRepos) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / vanished — skip silently
    }

    const gitEntry = entries.find((e) => e.name === ".git");
    if (gitEntry) {
      if (!seen.has(dir)) {
        seen.add(dir);
        found.push({ absPath: dir, name: basename(dir) || dir, isSubmodule: gitEntry.isFile() });
      }
      // A repo is a leaf for discovery purposes — don't recurse into its tree.
      return;
    }

    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue; // hidden dirs (incl. already-handled .git)
      if (SKIP_DIRS.has(e.name)) continue;
      visit(join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    if (existsSync(root)) visit(root, 0);
  }
  return found;
}

/**
 * Async, non-blocking discovery — identical leaf/skip/depth/cap semantics to `discover()`,
 * but built on `fs.promises.readdir` so the BFS yields to the event loop between directory
 * reads instead of stalling it. The daemon uses this so a large or slow root (a deep home
 * dir, an external drive, a network share) never delays the HTTP server from coming up:
 * each repo is reported via `onFound` the instant it's seen, and the caller indexes/watches
 * it live. Returns the number of repos found (after the `maxRepos` cap).
 */
export async function discoverStream(
  roots: string[],
  maxDepth: number,
  maxRepos: number,
  onFound: (repo: FoundRepo) => void,
): Promise<number> {
  let count = 0;
  const seen = new Set<string>();

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (count >= maxRepos) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / vanished — skip silently
    }

    const gitEntry = entries.find((e) => e.name === ".git");
    if (gitEntry) {
      if (!seen.has(dir)) {
        seen.add(dir);
        count++;
        onFound({ absPath: dir, name: basename(dir) || dir, isSubmodule: gitEntry.isFile() });
      }
      return; // a repo is a discovery leaf — don't recurse into its tree
    }

    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (count >= maxRepos) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      await visit(join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) {
    if (existsSync(root)) await visit(root, 0);
  }
  return count;
}
