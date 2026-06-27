import { test, expect } from "bun:test";
import { enqueue } from "../src/opqueue.ts";

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
