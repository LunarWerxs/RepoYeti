import { test, expect } from "bun:test";
import { createSemaphore } from "../src/gitgate.ts";

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
