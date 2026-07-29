import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, unlinkSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { watchRepo, type WatchFactory } from "../src/watcher.ts";

// The bonus recursive worktree watch (see watcher.ts's header comment) is only installed on
// platforms where a single native descriptor covers the whole tree; gate the tests that depend
// on it so they stay meaningful (not silently-vacuous) on Linux CI too.
const WORKTREE_WATCH_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-watch-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for filesystem watcher");
    await Bun.sleep(20);
  }
}

test("watchRepo reports healthy when the .git directory can be watched", async () => {
  const dir = await gitRepo();
  const h = watchRepo(dir, () => {});
  try {
    expect(h.watching).toBe(true);
  } finally {
    h.close();
  }
});

test("watchRepo uses one recursive descriptor for the entire nested refs tree", async () => {
  const dir = await gitRepo();
  await $`git -C ${dir} update-ref refs/tags/releases/2026/alpha HEAD`.quiet();
  const installed: Array<{ path: string; recursive: boolean }> = [];
  const handles: Array<FSWatcher & { closed: boolean }> = [];
  const factory: WatchFactory = (path, options) => {
    const handle = new EventEmitter() as FSWatcher & { closed: boolean };
    handle.closed = false;
    handle.close = () => {
      handle.closed = true;
    };
    handle.ref = () => handle;
    handle.unref = () => handle;
    installed.push({ path, recursive: options.recursive });
    handles.push(handle);
    return handle;
  };

  const watcher = watchRepo(dir, () => {}, ".git", 20, undefined, factory);
  try {
    expect(watcher.watching).toBe(true);
    const wantRecursive = WORKTREE_WATCH_SUPPORTED
      ? [
          { path: join(dir, ".git", "refs"), recursive: true },
          { path: dir, recursive: true }, // the bonus worktree watch on the repo root
        ]
      : [{ path: join(dir, ".git", "refs"), recursive: true }];
    expect(installed.filter((entry) => entry.recursive)).toEqual(wantRecursive);
    // .git, refs, logs, plus the bonus worktree watch where the platform supports it. A nested
    // ref namespace never adds one descriptor per directory either way.
    expect(installed).toHaveLength(WORKTREE_WATCH_SUPPORTED ? 4 : 3);
  } finally {
    watcher.close();
  }
  expect(handles.every((handle) => handle.closed)).toBe(true);
});

test.skipIf(!WORKTREE_WATCH_SUPPORTED)(
  "the bonus worktree watch filters .git churn and build dirs before debouncing, but lets real edits through",
  async () => {
    // A real repo (not a bare dir) so the required .git/refs coverage succeeds and `healthy`
    // stays true — otherwise closeWatchers() tears the bonus watch's handle down mid-test and
    // muddies what's being proven here, which is the filter logic alone.
    const dir = await gitRepo();
    const installed = new Map<string, (eventType?: string, filename?: string | null) => void>();
    const factory: WatchFactory = (path, _options, listener) => {
      installed.set(path, listener);
      const handle = new EventEmitter() as FSWatcher & { closed: boolean };
      handle.closed = false;
      handle.close = () => {
        handle.closed = true;
      };
      handle.ref = () => handle;
      handle.unref = () => handle;
      return handle;
    };
    let changes = 0;
    const watcher = watchRepo(dir, () => changes++, ".git", 20, undefined, factory);
    try {
      const worktreeListener = installed.get(dir);
      expect(worktreeListener).toBeDefined();
      worktreeListener?.("change", ".git\\index"); // already covered by the required .git watch
      worktreeListener?.("change", "node_modules\\pkg\\index.js"); // gitignored, can't affect status
      worktreeListener?.("change", ".testtmp\\generated-repo\\objects\\pack"); // test scratch churn
      // Give the worktree debounce a chance to fire if it was (wrongly) armed by either
      // filtered event above, before asserting neither reached onChange.
      await Bun.sleep(1_700);
      expect(changes).toBe(0);

      worktreeListener?.("rename", undefined); // filename unknown — treated conservatively
      await waitFor(() => changes > 0, 3_000);
      expect(changes).toBe(1); // a change we can't identify is NOT dropped

      worktreeListener?.("change", "src\\app.ts"); // an ordinary working-tree edit
      await waitFor(() => changes > 1, 3_000);
      expect(changes).toBe(2);
    } finally {
      watcher.close();
    }
  },
  9_000,
);

test("nested loose tag create, move, and delete each trigger the recursive watcher", async () => {
  const dir = await gitRepo();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m second`.quiet();
  const oldOid = (await $`git -C ${dir} rev-parse HEAD~1`.text()).trim();
  const newOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  let changes = 0;
  const watcher = watchRepo(dir, () => {
    changes++;
  }, ".git", 30);
  try {
    let before = changes;
    await $`git -C ${dir} update-ref refs/tags/releases/2026/alpha ${oldOid}`.quiet();
    await waitFor(() => changes > before);

    before = changes;
    await $`git -C ${dir} update-ref refs/tags/releases/2026/alpha ${newOid}`.quiet();
    await waitFor(() => changes > before);

    before = changes;
    await $`git -C ${dir} update-ref -d refs/tags/releases/2026/alpha`.quiet();
    await waitFor(() => changes > before);
  } finally {
    watcher.close();
  }
});

test("packed-refs create, move, and delete each trigger the common-directory watcher", async () => {
  const dir = await gitRepo();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m second`.quiet();
  const oldOid = (await $`git -C ${dir} rev-parse HEAD~1`.text()).trim();
  const newOid = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  const packedRefs = join(dir, ".git", "packed-refs");
  const header = "# pack-refs with: peeled fully-peeled sorted\n";
  let changes = 0;
  const watcher = watchRepo(dir, () => {
    changes++;
  }, ".git", 30);
  try {
    let before = changes;
    writeFileSync(packedRefs, `${header}${oldOid} refs/tags/packed-only\n`);
    await waitFor(() => changes > before);

    before = changes;
    writeFileSync(packedRefs, `${header}${newOid} refs/tags/packed-only\n`);
    await waitFor(() => changes > before);

    before = changes;
    writeFileSync(packedRefs, header);
    await waitFor(() => changes > before);
  } finally {
    watcher.close();
  }
});

test("a required runtime watcher error tears down native coverage and reports unhealthy once", async () => {
  const dir = await gitRepo();
  const handles: Array<FSWatcher & { closed: boolean }> = [];
  const factory: WatchFactory = () => {
    const handle = new EventEmitter() as FSWatcher & { closed: boolean };
    handle.closed = false;
    handle.close = () => {
      handle.closed = true;
    };
    handle.ref = () => handle;
    handle.unref = () => handle;
    handles.push(handle);
    return handle;
  };
  let unhealthy = 0;
  const watcher = watchRepo(dir, () => {}, ".git", 20, () => {
    unhealthy++;
  }, factory);

  expect(watcher.watching).toBe(true);
  handles[1]?.emit("error", new Error("simulated native watcher failure"));
  handles[1]?.emit("error", new Error("duplicate failure"));

  expect(watcher.watching).toBe(false);
  expect(unhealthy).toBe(1);
  expect(handles.every((handle) => handle.closed)).toBe(true);
  watcher.close();
});

test("watchRepo reports unhealthy when there is no .git to watch", () => {
  const bare = mkdtempSync(join(tmpdir(), "gm-watch-bare-")); // plain dir, no .git
  const h = watchRepo(bare, () => {});
  try {
    expect(h.watching).toBe(false);
  } finally {
    h.close();
  }
});

// ── working-tree deletes (the bug this file's header comment describes) ──
// Track D's reported symptom: the owner deleted a file in Explorer and the Changes view took
// ~10s to notice, because a plain on-disk edit/delete touches no path the .git-only watchers
// cover. These two tests measure that gap directly with a real fs.watch (no injected factory,
// no git command) rather than asserting against the implementation.

test.skipIf(!WORKTREE_WATCH_SUPPORTED)(
  "before: with the bonus watch disabled, deleting a file with plain fs never fires onChange",
  async () => {
    const dir = await gitRepo();
    const file = join(dir, "plain.txt");
    writeFileSync(file, "hello");
    const prev = process.env.REPOYETI_NO_WORKTREE_WATCH;
    process.env.REPOYETI_NO_WORKTREE_WATCH = "1"; // reproduces pre-fix behavior for comparison
    let changes = 0;
    const watcher = watchRepo(dir, () => changes++, ".git", 250);
    try {
      // `gitRepo()`'s seed commit can deliver its own fs event to the native watcher with a
      // few hundred ms of OS-level delay (observed on Windows: the "logs" dir's mtime bump
      // from writing logs/HEAD arrives up to ~200ms after the writing process already exited).
      // Settle well past that before taking the baseline, so this test measures the *delete*,
      // not leftover setup churn.
      await Bun.sleep(600);
      const before = changes;
      unlinkSync(file); // plain fs delete — no git command touches .git at all
      await Bun.sleep(1_500); // well past both debounces; nothing should ever fire
      expect(changes).toBe(before);
    } finally {
      watcher.close();
      if (prev === undefined) delete process.env.REPOYETI_NO_WORKTREE_WATCH;
      else process.env.REPOYETI_NO_WORKTREE_WATCH = prev;
    }
  },
  4_000,
);

test.skipIf(!WORKTREE_WATCH_SUPPORTED)(
  "after: deleting a file with plain fs (no git command) fires after the quiet debounce",
  async () => {
    const dir = await gitRepo();
    const file = join(dir, "plain.txt");
    writeFileSync(file, "hello");
    let changes = 0;
    const watcher = watchRepo(dir, () => changes++, ".git", 250);
    try {
      // Same settle rationale as the "before" test above: drain the seed commit's delayed fs
      // event first, so `before` reflects a quiet baseline and the timer below measures only
      // the delete's latency.
      await Bun.sleep(600);
      const before = changes;
      const start = Date.now();
      unlinkSync(file); // plain fs delete — no git command touches .git at all
      await waitFor(() => changes > before, 3_000);
      const elapsedMs = Date.now() - start;
      console.log(`worktree delete -> onChange latency: ${elapsedMs}ms`); // measured, not asserted-away
      expect(elapsedMs).toBeLessThan(2_500);
    } finally {
      watcher.close();
    }
  },
  6_000,
);

// ── the two sources share ONE debounce timer ──
// Every interesting git operation touches .git AND rewrites a pile of working-tree files. With a
// timer per source that is two onChange calls per checkout (one at 250ms, another later), and
// coalescedRefresh only folds the second while the first is still in flight — so the bonus watch
// would have doubled the cost of every branch switch. Driven through an injected factory so the
// assertion is about the debounce, not about how many fs events an OS chooses to deliver.
test("a burst touching both .git and the working tree fires exactly one onChange", async () => {
  const dir = await gitRepo();
  const listeners: Array<(eventType?: string, filename?: string | null) => void> = [];
  const factory: WatchFactory = (_path, _opts, listener) => {
    const handle = new EventEmitter() as FSWatcher;
    handle.close = () => {};
    handle.ref = () => handle;
    handle.unref = () => handle;
    listeners.push(listener);
    return handle;
  };
  let changes = 0;
  const watcher = watchRepo(dir, () => changes++, ".git", 40, undefined, factory);
  try {
    // Fire every installed watcher's listener, .git ones and (where installed) the worktree one,
    // exactly as a checkout would. The worktree listener needs a non-ignored filename to pass
    // its filter; the .git listeners ignore their arguments entirely.
    for (const fire of listeners) fire("change", "src/app.ts");
    await Bun.sleep(1_700); // past BOTH the 40ms .git debounce and the worktree one
    expect(changes).toBe(1);
  } finally {
    watcher.close();
  }
});

test.skipIf(!WORKTREE_WATCH_SUPPORTED)(
  "a filtered-out working-tree event never arms the timer",
  async () => {
    const dir = await gitRepo();
    const listeners: Array<(eventType?: string, filename?: string | null) => void> = [];
    const paths: string[] = [];
    const factory: WatchFactory = (path, _opts, listener) => {
      const handle = new EventEmitter() as FSWatcher;
      handle.close = () => {};
      handle.ref = () => handle;
      handle.unref = () => handle;
      paths.push(path);
      listeners.push(listener);
      return handle;
    };
    let changes = 0;
    const watcher = watchRepo(dir, () => changes++, ".git", 40, undefined, factory);
    try {
      const worktreeIndex = paths.indexOf(dir);
      expect(worktreeIndex).toBeGreaterThanOrEqual(0); // the injected factory installs it on every platform
      const fire = listeners[worktreeIndex]!;
      // Nested build dirs, not just root-level ones: this repo has web/node_modules alongside the
      // root one, and a first-segment-only filter let every write in there through.
      fire("change", "node_modules/x/index.js");
      fire("change", "web/node_modules/x/index.js");
      fire("change", "services/api/dist/bundle.js");
      fire("change", ".testtmp/generated-repo/index");
      fire("change", "tmp/generated.log");
      fire("change", ".git/index");
      await Bun.sleep(1_700);
      expect(changes).toBe(0);

      // A null filename can't be classified, so it is treated conservatively and DOES refresh.
      fire("change", null);
      await Bun.sleep(1_700);
      expect(changes).toBe(1);
    } finally {
      watcher.close();
    }
  },
);
