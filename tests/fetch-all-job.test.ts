/**
 * "Fetch all" as a cancellable, progress-reporting job (1.0 audit, item 24), and the shared job
 * lifecycle underneath it (service/job.ts).
 *
 * The behaviour that matters and had no cover before: the sweep can be STOPPED, stopping it does
 * not abandon the repository already in flight, a second start does not run a second sweep, and a
 * client that missed every event can still find out what happened.
 */
import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { setRepoStatus, type RepoStatus } from "../src/db.ts";
import { addListener, removeListener, type BusListener } from "../src/bus.ts";
import { createJob } from "../src/service/job.ts";
import {
  cancelFetchAll,
  fetchAllRepos,
  fetchAllState,
  isFetchingAll,
  startFetchAllJob,
} from "../src/service/fetch-all.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir, fileUrl } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses.
useSuiteTimeout();

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** Collect every bus event for the duration of `fn`. */
async function recording<T>(fn: () => Promise<T>): Promise<{ result: T; events: Array<[string, unknown]> }> {
  const events: Array<[string, unknown]> = [];
  const listener: BusListener = (event, _data, payload) => events.push([event, payload]);
  addListener(listener);
  try {
    return { result: await fn(), events };
  } finally {
    removeListener(listener);
  }
}

const statusWithRemote = (remote: string | null): RepoStatus => ({
  branch: "main",
  detached: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  remote,
  error: null,
  fetchedAt: null,
  updatedAt: Date.now(),
});

/**
 * A repo with a real file:// remote, so `fetchRepo` genuinely runs git.
 *
 * The cached status has to be seeded too: fetch-all picks its work from `getWatchableRepos()`
 * filtered on `status.remote`, and `upsertRepo` does not compute a status.
 */
async function repoWithRemote(prefix: string, name: string): Promise<string> {
  const root = mkScratchDir(prefix);
  const bare = join(root, `${name}.git`);
  mkdirSync(bare, { recursive: true });
  await $`git init -q --bare ${bare}`.quiet();
  const work = join(root, name);
  mkdirSync(work, { recursive: true });
  await $`git -c init.defaultBranch=main init -q ${work}`.quiet();
  await $`git -C ${work} -c user.name=S -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  await $`git -C ${work} remote add origin ${fileUrl(bare)}`.quiet();
  await $`git -C ${work} push -q origin main`.quiet();
  const id = mustUpsertRepo(work, name, "auto", false);
  setRepoStatus(id, statusWithRemote("origin"));
  return id;
}

/** Spin until the module-level single-flight job settles, so one test cannot leak into the next. */
async function waitIdle(): Promise<void> {
  for (let i = 0; i < 400 && isFetchingAll(); i++) await new Promise((r) => setTimeout(r, 10));
}

// ── the shared job lifecycle ─────────────────────────────────────────────────────

test("a job clears its handle BEFORE the terminal event, so a client that polls is told the truth", async () => {
  const job = createJob<{ n: number }>("gate_probe");
  // An array, not a `let`: TypeScript's control-flow analysis cannot see that the listener ran,
  // so a plain variable stays narrowed to its initial type at the assertion below.
  const runningWhenDone: boolean[] = [];
  const listener: BusListener = (event) => {
    if (event === "gate_probe_done") runningWhenDone.push(job.isRunning());
  };
  addListener(listener);
  try {
    await job.start({}, async () => ({ n: 1 }));
  } finally {
    removeListener(listener);
  }
  // The daemon has no event replay, so a client's answer to a missed terminal event is to poll
  // the status route. If the handle were still set here the two would disagree.
  expect(runningWhenDone).toEqual([false]);
});

test("a job that throws still emits a terminal event, with the reason", async () => {
  const job = createJob<{ n: number }>("gate_probe_fail");
  const { events } = await recording(async () => {
    await expect(
      job.start({}, async () => {
        throw new Error("the walk fell over");
      }),
    ).rejects.toThrow("the walk fell over");
  });
  const done = events.find(([name]) => name === "gate_probe_fail_done");
  expect(done).toBeDefined();
  expect((done![1] as { error?: string }).error).toBe("the walk fell over");
  expect(job.isRunning()).toBe(false);
});

test("a second start while one is in flight is refused, not queued", async () => {
  const job = createJob<{ n: number }>("gate_probe_single");
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const first = job.start({}, async () => {
    await gate;
    return { n: 1 };
  });
  const second = await job.start({}, async () => ({ n: 2 }));
  expect(second).toBeNull();
  release();
  expect(await first).toEqual({ n: 1 });
});

// ── fetch-all ────────────────────────────────────────────────────────────────────

test("an already-aborted signal fetches nothing and reports everything as skipped", async () => {
  await repoWithRemote("gm-fetchall-a-", "alpha");
  const controller = new AbortController();
  controller.abort();

  const result = await fetchAllRepos({ signal: controller.signal });
  expect(result.cancelled).toBe(true);
  expect(result.total).toBeGreaterThanOrEqual(1);
  expect(result.skipped).toBe(result.total);
  expect(result.ok).toBe(0);
  expect(result.failed).toEqual([]);
});

test("cancelling mid-sweep stops starting repositories but finishes the one in flight", async () => {
  await repoWithRemote("gm-fetchall-b-", "beta");
  await repoWithRemote("gm-fetchall-c-", "gamma");
  await repoWithRemote("gm-fetchall-d-", "delta");

  const controller = new AbortController();
  const seen: string[] = [];
  const result = await fetchAllRepos({
    signal: controller.signal,
    onRepo: ({ name }) => {
      seen.push(name);
      // Stop after the first repository is picked up. The one already in flight is allowed to
      // finish; only the ones after it are dropped.
      controller.abort();
    },
  });

  expect(seen.length).toBe(1);
  expect(result.cancelled).toBe(true);
  // Exactly one attempted, whatever its outcome, and the rest untouched.
  expect(result.ok + result.failed.length).toBe(1);
  expect(result.skipped).toBe(result.total - 1);
});

test("the job announces its start, its progress and its summary, all under one run id", async () => {
  await repoWithRemote("gm-fetchall-e-", "epsilon");
  const { events } = await recording(async () => {
    await startFetchAllJob();
    await waitIdle();
  });

  const started = events.find(([n]) => n === "fetch_all_started");
  const done = events.find(([n]) => n === "fetch_all_done");
  expect(started).toBeDefined();
  expect(done).toBeDefined();
  const jobId = (started![1] as { jobId: string }).jobId;
  expect(jobId).toBeTruthy();
  // Every event of the run carries the same id, so a late `done` for a previous run is
  // distinguishable from the one a client is waiting on.
  expect((done![1] as { jobId: string }).jobId).toBe(jobId);
  expect((started![1] as { total: number }).total).toBeGreaterThanOrEqual(1);
  expect((done![1] as { cancelled: boolean }).cancelled).toBe(false);
  const progress = events.filter(([n]) => n === "fetch_all_progress");
  expect(progress.length).toBeGreaterThanOrEqual(1);
  expect((progress[0]![1] as { current: string }).current).toBeTruthy();
});

test("the status route answers with the last run's counters, not just whether one is running", async () => {
  await repoWithRemote("gm-fetchall-f-", "zeta");
  await startFetchAllJob();
  await waitIdle();

  const app = createApp(localCfg());
  const res = await app.request("/api/repos/fetch-all");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { running: boolean; job: { total: number; done: number; running: boolean } | null };
  expect(body.running).toBe(false);
  // A phone that backgrounded mid-sweep missed every event; this is how it finds out what
  // happened rather than only that nothing is running now.
  expect(body.job).not.toBeNull();
  expect(body.job!.running).toBe(false);
  expect(body.job!.done).toBe(body.job!.total);
});

test("POST /api/repos/fetch-all acknowledges and streams, and a second POST does not start another", async () => {
  await repoWithRemote("gm-fetchall-g-", "eta");
  const app = createApp(localCfg());

  const first = await app.request("/api/repos/fetch-all", { method: "POST" });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { ok: boolean; started: boolean; running: boolean };
  expect(firstBody.ok).toBe(true);
  expect(firstBody.started).toBe(true);
  // The route returns immediately: the sweep itself is still going (or has just finished on a
  // one-repo fixture), and the summary arrives over SSE either way.
  const second = await app.request("/api/repos/fetch-all", { method: "POST" });
  const secondBody = (await second.json()) as { started: boolean };
  if (isFetchingAll()) expect(secondBody.started).toBe(false);
  await waitIdle();
});

test("POST /api/repos/fetch-all/cancel reports whether there was anything to stop", async () => {
  const app = createApp(localCfg());
  await waitIdle();
  const idle = await app.request("/api/repos/fetch-all/cancel", { method: "POST" });
  expect((await idle.json()) as { cancelled: boolean }).toEqual({ ok: true, cancelled: false } as never);
  expect(cancelFetchAll()).toBe(false);
  expect(fetchAllState().running).toBe(false);
});
