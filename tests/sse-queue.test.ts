import { expect, test } from "bun:test";
import {
  BoundedSseQueue,
  MAX_SSE_QUEUE,
  MAX_SSE_QUEUE_BYTES,
} from "../src/http/routes/events.ts";

test("SSE queue evicts old events by count", () => {
  const queue = new BoundedSseQueue();
  for (let i = 0; i < MAX_SSE_QUEUE + 25; i++) {
    expect(queue.push({ event: "tick", data: String(i) })).toBe(true);
  }
  expect(queue.items).toHaveLength(MAX_SSE_QUEUE);
  expect(queue.items[0]?.data).toBe("25");
});

test("SSE queue retains at most its byte budget", () => {
  const queue = new BoundedSseQueue();
  const data = "x".repeat(128 * 1024);
  for (let i = 0; i < 40; i++) {
    expect(queue.push({ event: "snapshot", data })).toBe(true);
  }
  expect(queue.bytes).toBeLessThanOrEqual(MAX_SSE_QUEUE_BYTES);
  expect(queue.items.length).toBeLessThan(40);
  expect(queue.drain()).not.toHaveLength(0);
  expect(queue.bytes).toBe(0);
});

test("SSE queue rejects a single event larger than its byte budget", () => {
  const queue = new BoundedSseQueue();
  expect(
    queue.push({ event: "snapshot", data: "x".repeat(MAX_SSE_QUEUE_BYTES + 1) }),
  ).toBe(false);
  expect(queue.items).toHaveLength(0);
  expect(queue.bytes).toBe(0);
});
