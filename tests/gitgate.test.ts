import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { asForeground, createSemaphore, isForeground, readGate } from "../src/gitgate.ts";
import { createApp } from "../src/http/app.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

test("createSemaphore never runs more than `max` tasks at once", async () => {
  const sem = createSemaphore(2);
  let concurrent = 0;
  let peak = 0;
  const task = async (): Promise<void> => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await Bun.sleep(15);
    concurrent--;
  };

  await Promise.all(Array.from({ length: 8 }, () => sem.run(task)));

  expect(peak).toBe(2);
  expect(sem.active).toBe(0);
  expect(sem.waiting).toBe(0);
});

test("createSemaphore releases its slot even when a task throws", async () => {
  const sem = createSemaphore(1);

  await expect(
    sem.run(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  // If the slot leaked, this second task would hang forever instead of resolving.
  const ran = await sem.run(async () => "ok");
  expect(ran).toBe("ok");
  expect(sem.active).toBe(0);
});

test("createSemaphore preserves FIFO order for queued tasks", async () => {
  const sem = createSemaphore(1);
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      sem.run(async () => {
        await Bun.sleep(5);
        order.push(n);
      }),
    ),
  );
  expect(order).toEqual([1, 2, 3]);
});

test("createSemaphore never deadlocks on a fractional positive limit", async () => {
  const sem = createSemaphore(0.5);

  expect(await sem.run(async () => "ok")).toBe("ok");
  expect(sem.active).toBe(0);
  expect(sem.waiting).toBe(0);
});

// ── foreground lane ───────────────────────────────────────────────────────────
// The whole point of the split: a card expand must not wait behind a boot/watcher sweep that
// queued first. These pin the ordering guarantee, not just "it runs eventually".

test("asForeground marks the async context, and only inside it", async () => {
  expect(isForeground()).toBe(false);
  await asForeground(async () => {
    expect(isForeground()).toBe(true);
    // Survives an await boundary — the reads it gates are several awaits deep.
    await Bun.sleep(1);
    expect(isForeground()).toBe(true);
  });
  expect(isForeground()).toBe(false);
});

test("a foreground task jumps ahead of already-queued background tasks", async () => {
  const sem = createSemaphore(1);
  const order: string[] = [];
  const run = (tag: string): Promise<void> =>
    sem.run(async () => {
      await Bun.sleep(5);
      order.push(tag);
    });

  // Occupy the only slot, then queue three background tasks behind it...
  const holder = run("holder");
  const background = [run("bg1"), run("bg2"), run("bg3")];
  // ...and only then does the "user" arrive. It must still go first.
  const foregroundTask = asForeground(() => run("fg"));

  await Promise.all([holder, foregroundTask, ...background]);

  expect(order).toEqual(["holder", "fg", "bg1", "bg2", "bg3"]);
  expect(sem.active).toBe(0);
  expect(sem.waiting).toBe(0);
});

test("foreground tasks stay FIFO among themselves", async () => {
  const sem = createSemaphore(1);
  const order: number[] = [];
  const hold = sem.run(() => Bun.sleep(5));
  const queued = [1, 2, 3].map((n) =>
    asForeground(() =>
      sem.run(async () => {
        order.push(n);
      }),
    ),
  );

  await Promise.all([hold, ...queued]);

  expect(order).toEqual([1, 2, 3]);
});

test("waitingForeground counts only the foreground lane", async () => {
  const sem = createSemaphore(1);
  const hold = sem.run(() => Bun.sleep(10));
  const bg = sem.run(async () => {});
  const fg = asForeground(() => sem.run(async () => {}));

  expect(sem.waiting).toBe(2);
  expect(sem.waitingForeground).toBe(1);

  await Promise.all([hold, bg, fg]);
  expect(sem.waitingForeground).toBe(0);
});

test("the read gate is wide enough for one card expand's four reads", () => {
  // Expanding a repo card issues changes + branches + stashes + recent-messages at once
  // (web/src/components/RepoCard.vue). At the old width of 2 a single click could not fill even
  // its own request in one pass, which is half the stall this default was raised to remove.
  expect(readGate.limit).toBeGreaterThanOrEqual(4);
  // …and still bounded: the Git-for-Windows process tree is ~3× this number.
  expect(readGate.limit).toBeLessThanOrEqual(8);
});

// The lane split is only worth anything if the marker actually reaches the reads a request
// makes — it rides an AsyncLocalStorage through Hono's middleware chain and several awaits, so
// "it propagates" is an assumption worth failing loudly rather than a false green.
test("a real API read lands in the git gate's FOREGROUND lane", async () => {
  const dir = mkScratchDir("gm-fg-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  writeFileSync(join(dir, "dirty.txt"), "x");
  const id = mustUpsertRepo(dir, "repo", "auto", false);
  const app = createApp({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

  // Hold every slot with BACKGROUND work, so the request below has no choice but to queue.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holders = Array.from({ length: readGate.limit }, () => readGate.run(() => held));
  await Bun.sleep(5);
  expect(readGate.active).toBe(readGate.limit);

  // GET /api/repos/:id/changes reaches readChanges → readGate.run several awaits deep. If the
  // AsyncLocalStorage marker set at the /api/* boundary did not survive that chain, this read
  // would queue in the background lane and waitingForeground would stay 0.
  const request = app.request(`/api/repos/${id}/changes`);
  await Bun.sleep(50); // let it get all the way down to the gate

  expect(readGate.waitingForeground).toBe(1);

  release();
  const res = await request;
  await Promise.all(holders);
  expect(res.status).toBe(200);
}, 30_000);

test("background work outside a request is not marked foreground", () => {
  // Boot hydration, the watcher and the sync check never touch Hono, so they must read false —
  // otherwise everything is 'priority' and the lane split silently does nothing.
  expect(isForeground()).toBe(false);
});

test("createSemaphore reports its clamped limit", () => {
  expect(createSemaphore(6).limit).toBe(6);
  expect(createSemaphore(0.5).limit).toBe(1); // fractional-positive clamp, never 0
  expect(createSemaphore(0).limit).toBe(1);
  expect(createSemaphore(Number.NaN).limit).toBe(1);
});
