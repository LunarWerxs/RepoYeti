import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { watchRepo, type WatchFactory } from "../src/watcher.ts";

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
    expect(installed.filter((entry) => entry.recursive)).toEqual([
      { path: join(dir, ".git", "refs"), recursive: true },
    ]);
    // .git, refs, and logs. A nested namespace never adds one descriptor per directory.
    expect(installed).toHaveLength(3);
  } finally {
    watcher.close();
  }
  expect(handles.every((handle) => handle.closed)).toBe(true);
});

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
