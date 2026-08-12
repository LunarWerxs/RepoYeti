import { test, expect } from "bun:test";
import { enqueue, hasActiveOperations } from "../src/opqueue.ts";

test("serializes operations on the same key (no races)", async () => {
  const order: number[] = [];
  const p1 = enqueue("a", async () => {
    await Bun.sleep(25);
    order.push(1);
  });
  const p2 = enqueue("a", async () => {
    order.push(2);
  });
  await Promise.all([p1, p2]);
  expect(order).toEqual([1, 2]); // p2 waited for the slower p1
});

test("the chain survives a rejected operation", async () => {
  await enqueue("b", async () => {
    throw new Error("boom");
  }).catch(() => {});
  const r = await enqueue("b", async () => 42);
  expect(r).toBe(42);
});

test("different keys run independently", async () => {
  const order: string[] = [];
  const slow = enqueue("k1", async () => {
    await Bun.sleep(25);
    order.push("slow");
  });
  const fast = enqueue("k2", async () => {
    order.push("fast");
  });
  await Promise.all([slow, fast]);
  expect(order[0]).toBe("fast"); // k2 not blocked by k1
});

/** Wait for `cond`, rather than demanding it of one instant. Throws rather than hanging. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition never held within ${ms}ms`);
    await Bun.sleep(5);
  }
}

test("hasActiveOperations reflects an op queued or running, and clears once it settles", async () => {
  // The counter is module state, and bun shares one module graph across every test file in the
  // process, so this is NOT a private fixture: any op another file has in flight is counted here
  // too, including ones nobody awaited (the watcher enqueues status reads off a debounce). Demanding
  // that this exact instant be idle is therefore a race, and it lost on macOS on 2026-08-12, on a
  // commit that touched none of this. Drain first, then the assertions below mean what they say.
  await until(() => !hasActiveOperations());
  expect(hasActiveOperations()).toBe(false);
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const p = enqueue("busy-key", async () => {
    await gate;
  });
  expect(hasActiveOperations()).toBe(true);
  release();
  await p;
  expect(hasActiveOperations()).toBe(false);
});
