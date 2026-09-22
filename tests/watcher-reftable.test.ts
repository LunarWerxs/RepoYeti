import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, rmSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

import { watchRepo, type WatchFactory } from "../src/watcher.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

/**
 * A git repo using the reftable ref backend, or null when the local git predates
 * `--ref-format=reftable` (git 2.45). Every assertion here is meaningless without that backend, so
 * callers skip rather than silently pass on an older git.
 */
async function reftableRepo(): Promise<string | null> {
  const dir = mkScratchDir("gm-reftable-");
  try {
    await $`git -c init.defaultBranch=main init -q --ref-format=reftable ${dir}`.quiet();
  } catch {
    return null;
  }
  if (!existsSync(join(dir, ".git", "reftable"))) return null;
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

test("a reftable repo installs a recursive required watch on the reftable store", async () => {
  const dir = await reftableRepo();
  if (!dir) return; // git too old for the reftable backend

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
    // Regression: the old code watched only common-dir/refs, so reftable repos — whose loose refs
    // live under common-dir/reftable — never fired for an external tag/fetch/update-ref. That
    // directory must now be a required recursive descriptor.
    expect(installed).toContainEqual({ path: join(dir, ".git", "reftable"), recursive: true });
  } finally {
    watcher.close();
  }
  expect(handles.every((handle) => handle.closed)).toBe(true);
});

test("a reftable repo that omits the refs directory is not degraded to polling", async () => {
  const dir = await reftableRepo();
  if (!dir) return; // git too old for the reftable backend
  // A reftable checkout is not required to keep a refs/ directory; when it is missing the old code
  // treated the refs watch as a failed required descriptor and tore down every watcher, forcing
  // HEAD/index coverage onto the slower poll fallback.
  rmSync(join(dir, ".git", "refs"), { recursive: true, force: true });

  const h = watchRepo(dir, () => {});
  try {
    expect(h.watching).toBe(true);
  } finally {
    h.close();
  }
});

test("an external ref write in a reftable repo reaches onChange", async () => {
  const dir = await reftableRepo();
  if (!dir) return; // git too old for the reftable backend

  let changes = 0;
  const watcher = watchRepo(dir, () => {
    changes++;
  }, ".git", 30);
  try {
    expect(watcher.watching).toBe(true);
    const before = changes;
    await $`git -C ${dir} update-ref refs/tags/reftable-only HEAD`.quiet();
    const deadline = Date.now() + 5_000;
    while (changes === before && Date.now() < deadline) await Bun.sleep(20);
    expect(changes).toBeGreaterThan(before);
  } finally {
    watcher.close();
  }
});
