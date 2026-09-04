import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The app package root (the directory holding this app's own package.json and .git), found by
 * walking up from a starting path rather than hop-counting a fixed number of `..` segments.
 *
 * A fixed hop count silently rots when the file that computes it moves — one more or fewer
 * directory level and it points at the wrong place with no error, just a wrong answer. Walking up
 * to a marker survives that: the test can move anywhere under the repo and still find the root.
 *
 * `.git` is required alongside package.json so this stops at the APP root rather than climbing
 * past it into a workspace root that also has a package.json (this app is synced from
 * lunarwerx-ui as a kit app, so a parent package.json is a real possibility, not a hypothetical).
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(dir, "package.json")) && existsSync(resolve(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`findRepoRoot: no package.json + .git found above ${startDir}`);
    }
    dir = parent;
  }
}
