import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { getRepo, setRepoStatus, type RepoStatus } from "../src/db.ts";
import { addListener, removeListener, type BusListener } from "../src/bus.ts";
import { enqueue } from "../src/opqueue.ts";
import {
  coalescedRefresh,
  getChanges,
  refreshQueueHealth,
  refreshRepo,
  registerRepo,
  watchOne,
  stopWatching,
  unwatchOne,
  watcherHealth,
  MAX_ACTIVE_REPO_WATCHES,
  MAX_CHANGED_FILES,
} from "../src/service/index.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { setDiffStatsEnabled } from "../src/read/diffstat.ts";

const tmp = (): string => mkScratchDir("gm-svc-");

async function gitRepo(prefix = "gm-svc-repo-"): Promise<string> {
  const dir = mkScratchDir(prefix);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  return dir;
}

const status = (fetchedAt: number | null): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 1,
  remote: "origin",
  error: null,
  fetchedAt,
  updatedAt: Date.now(),
});

test("refreshRepo preserves fetchedAt on non-fetch refreshes", async () => {
  const dir = await gitRepo();
  const id = mustUpsertRepo(dir, "repo", "auto", false);
  setRepoStatus(id, status(12345));

  await refreshRepo(id, dir);

  expect(getRepo(id)?.status?.fetchedAt).toBe(12345);
});

test("a fetch refresh reuses the existing working-tree diff", async () => {
  const dir = await gitRepo("gm-svc-fetch-diff-");
  const path = join(dir, "dirty.txt");
  writeFileSync(path, "original\n");
  await $`git -C ${dir} add dirty.txt`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m tracked`.quiet();
  writeFileSync(path, "changed\n");
  const id = mustUpsertRepo(dir, "repo-fetch-diff", "auto", false);

  setDiffStatsEnabled(true);
  try {
    await refreshRepo(id, dir);
    const before = getRepo(id)?.status?.diff;
    expect(before).not.toBeNull();

    // Fetch cannot alter HEAD/index/worktree, so this mode updates refs/ahead/behind without
    // reopening every dirty/untracked file merely to recompute the identical aggregate.
    await refreshRepo(id, dir, true, true);
    expect(getRepo(id)?.status?.diff).toEqual(before);
    expect(getRepo(id)?.status?.fetchedAt).toBeGreaterThan(0);
  } finally {
    setDiffStatsEnabled(false);
  }
});

test("refreshRepo broadcasts a clean external commit when counters remain unchanged", async () => {
  const dir = await gitRepo("gm-svc-head-");
  const id = mustUpsertRepo(dir, "repo-head", "auto", false);
  const events: Array<{ id: string; status: RepoStatus }> = [];
  const listener: BusListener = (event, _data, payload) => {
    if (event === "repo_state_changed" && (payload as { id?: string }).id === id) {
      events.push(payload as { id: string; status: RepoStatus });
    }
  };
  addListener(listener);
  try {
    await refreshRepo(id, dir);
    const before = getRepo(id)?.status;
    events.length = 0;

    await $`git -C ${dir} -c user.name=External -c user.email=external@example.com commit -q --allow-empty -m external`.quiet();
    await refreshRepo(id, dir);
    const after = getRepo(id)?.status;

    expect(after?.headOid).not.toBe(before?.headOid);
    expect(after && before ? [after.branch, after.detached, after.dirty, after.ahead, after.behind] : null)
      .toEqual(before ? [before.branch, before.detached, before.dirty, before.ahead, before.behind] : null);
    expect(events).toHaveLength(1);
    expect(events[0]?.status.headOid).toBe(after?.headOid);
  } finally {
    removeListener(listener);
  }
});

test("refreshRepo broadcasts a changed path when the dirty count stays unchanged", async () => {
  const dir = await gitRepo("gm-svc-worktree-");
  const id = mustUpsertRepo(dir, "repo-worktree", "auto", false);
  const events: Array<{ id: string; status: RepoStatus }> = [];
  const listener: BusListener = (event, _data, payload) => {
    if (event === "repo_state_changed" && (payload as { id?: string }).id === id) {
      events.push(payload as { id: string; status: RepoStatus });
    }
  };
  addListener(listener);
  try {
    writeFileSync(join(dir, "first.txt"), "first\n");
    await refreshRepo(id, dir);
    const first = getRepo(id)?.status;
    events.length = 0;

    await $`git -C ${dir} clean -q -f -- first.txt`.quiet();
    writeFileSync(join(dir, "second.txt"), "second\n");
    await refreshRepo(id, dir);
    const second = getRepo(id)?.status;

    expect(first?.dirty).toBe(1);
    expect(second?.dirty).toBe(1);
    expect(second?.worktreeStateHash).not.toBe(first?.worktreeStateHash);
    expect(events).toHaveLength(1);
    expect(events[0]?.status.worktreeStateHash).toBe(second?.worktreeStateHash);
  } finally {
    removeListener(listener);
  }
});

test("refreshRepo broadcasts when a staged blob changes but its path/status tuple does not", async () => {
  const dir = await gitRepo("gm-svc-index-blob-");
  const id = mustUpsertRepo(dir, "repo-index-blob", "auto", false);
  const events: Array<{ id: string; status: RepoStatus }> = [];
  const listener: BusListener = (event, _data, payload) => {
    if (event === "repo_state_changed" && (payload as { id?: string }).id === id) {
      events.push(payload as { id: string; status: RepoStatus });
    }
  };
  addListener(listener);
  try {
    const path = join(dir, "staged.txt");
    writeFileSync(path, "staged version one\n");
    await $`git -C ${dir} add staged.txt`.quiet();
    const porcelainBefore = await $`git -C ${dir} status --porcelain=v1`.text();
    await refreshRepo(id, dir);
    const first = getRepo(id)?.status;
    events.length = 0;

    writeFileSync(path, "staged version two\n");
    await $`git -C ${dir} add staged.txt`.quiet();
    const porcelainAfter = await $`git -C ${dir} status --porcelain=v1`.text();
    await refreshRepo(id, dir);
    const second = getRepo(id)?.status;

    expect(porcelainAfter).toBe(porcelainBefore);
    expect(first?.dirty).toBe(1);
    expect(second?.dirty).toBe(1);
    expect(second?.worktreeStateHash).not.toBe(first?.worktreeStateHash);
    expect(events).toHaveLength(1);
    expect(events[0]?.status.worktreeStateHash).toBe(second?.worktreeStateHash);
  } finally {
    removeListener(listener);
  }
});

test("getChanges waits behind the per-repo operation queue", async () => {
  const dir = await gitRepo();
  writeFileSync(join(dir, "x.txt"), "dirty");
  const id = mustUpsertRepo(dir, "repo-queued", "auto", false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = enqueue(id, () => gate);

  let settled = false;
  const changes = getChanges(id).then((result) => {
    settled = true;
    return result;
  });
  await Bun.sleep(50);
  expect(settled).toBe(false);

  release();
  await blocker;
  const result = await changes;
  expect(result.ok).toBe(true);
  expect(result.files?.some((f) => f.path === "x.txt")).toBe(true);
});

test("manual registration preserves .git file actionability semantics", async () => {
  const root = tmp();
  const dir = join(root, "subm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), "gitdir: ../.git/modules/subm");

  const result = await registerRepo(dir);

  expect(result.ok).toBe(true);
  expect(result.repo?.isSubmodule).toBe(true);
});

test("explicit registration upgrades an auto-discovered repo source", async () => {
  const dir = await gitRepo("gm-svc-source-");
  const id = mustUpsertRepo(dir, "repo-source", "auto", false);

  const result = await registerRepo(dir);

  expect(result.ok).toBe(true);
  expect(result.repo?.id).toBe(id);
  expect(getRepo(id)?.source).toBe("pinned");
});

test("getChanges caps an oversized changed-file list and flags truncation", async () => {
  const dir = await gitRepo("gm-svc-cap-");
  const extra = 5;
  for (let i = 0; i < MAX_CHANGED_FILES + extra; i++) {
    writeFileSync(join(dir, `f${i}.txt`), "x"); // untracked → shows up in git status
  }
  const id = mustUpsertRepo(dir, "repo-cap", "auto", false);

  const result = await getChanges(id);

  expect(result.ok).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.total).toBe(MAX_CHANGED_FILES + extra);
  expect(result.files?.length).toBe(MAX_CHANGED_FILES);
});

test("a watcher-driven ref-only change broadcasts the new History ref identity", async () => {
  const dir = await gitRepo("gm-svc-ref-watch-");
  const id = mustUpsertRepo(dir, "repo-ref-watch", "auto", false);
  await refreshRepo(id, dir);
  const before = getRepo(id)?.status?.historyRefsHash;
  let notify!: () => void;
  watchOne(id, dir, (_path, onChange) => {
    notify = onChange;
    return {
      watching: true,
      close: () => {},
    };
  });

  let resolveEvent!: (status: RepoStatus) => void;
  const eventStatus = new Promise<RepoStatus>((resolve) => {
    resolveEvent = resolve;
  });
  const listener: BusListener = (event, _data, payload) => {
    const update = payload as { id?: string; status?: RepoStatus };
    if (
      event === "repo_state_changed" &&
      update.id === id &&
      update.status &&
      update.status.historyRefsHash !== before
    ) {
      resolveEvent(update.status);
    }
  };
  addListener(listener);
  try {
    await $`git -C ${dir} update-ref refs/tags/external-only HEAD`.quiet();
    notify();
    const emitted = await Promise.race([
      eventStatus,
      Bun.sleep(5_000).then(() => {
        throw new Error("timed out waiting for watcher-driven repo_state_changed");
      }),
    ]);

    expect(emitted.headOid).toBe(getRepo(id)?.status?.headOid);
    expect(emitted.historyRefsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emitted.historyRefsHash).not.toBe(before);
  } finally {
    removeListener(listener);
    unwatchOne(id);
  }
});

test("a runtime native-watcher failure switches exactly once to polling", () => {
  const dir = tmp();
  const id = "runtime-watch-fallback";
  const before = watcherHealth();
  let fail!: () => void;
  watchOne(id, dir, (_path, _onChange, _marker, _debounce, onUnhealthy) => {
    let live = true;
    fail = () => {
      live = false;
      onUnhealthy?.();
    };
    return {
      get watching() {
        return live;
      },
      close: () => {
        live = false;
      },
    };
  });

  expect(watcherHealth().watched).toBe(before.watched + 1);
  expect(watcherHealth().polling).toBe(before.polling);
  fail();
  fail();

  expect(watcherHealth().watched).toBe(before.watched);
  expect(watcherHealth().polling).toBe(before.polling + 1);
  expect(watcherHealth().unhealthy).toContain(id);
  unwatchOne(id);
  expect(watcherHealth().polling).toBe(before.polling);
});

test("background refresh scheduling bounds pending promise chains across repos", async () => {
  // Keep this scheduler accounting isolated from legitimate filesystem events emitted by
  // repositories registered in earlier service tests.
  stopWatching();
  const bare = tmp();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const ids = Array.from({ length: 20 }, (_, index) => `refresh-bound-${index}`);
  const blockers = ids.map((id) => enqueue(id, () => gate));

  for (const id of ids) coalescedRefresh(id, bare);
  await Bun.sleep(20);

  expect(refreshQueueHealth()).toEqual({ active: 16, queued: 4 });
  release();
  await Promise.all(blockers);
  for (let i = 0; i < 300 && refreshQueueHealth().active + refreshQueueHealth().queued > 0; i++) {
    await Bun.sleep(10);
  }
  expect(refreshQueueHealth()).toEqual({ active: 0, queued: 0 });
  for (const id of ids) unwatchOne(id);
});

test("repository watcher retention is capped when a broad scan finds thousands of repos", () => {
  stopWatching();
  const installer = () => ({ watching: true, close: () => {} });
  for (let i = 0; i < MAX_ACTIVE_REPO_WATCHES + 17; i++) {
    watchOne(`watch-cap-${i}`, `D:/deferred/${i}`, installer);
  }

  const health = watcherHealth();
  expect(health.watched).toBe(MAX_ACTIVE_REPO_WATCHES);
  expect(health.deferred).toBe(17);
  stopWatching();
});

// NOTE: stopWatching() here clears the global watch registry, so this must stay LAST.
test("watchOne falls back to polling when the filesystem watch can't be installed", () => {
  stopWatching(); // clean slate — earlier tests registered live watchers via registerRepo
  const bare = mkScratchDir("gm-svc-nowatch-"); // no .git → watch unhealthy

  watchOne("poll-fallback", bare);

  const health = watcherHealth();
  expect(health.polling).toBe(1);
  expect(health.unhealthy).toContain("poll-fallback");

  stopWatching();
  expect(watcherHealth().polling).toBe(0);
});
