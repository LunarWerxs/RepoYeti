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
