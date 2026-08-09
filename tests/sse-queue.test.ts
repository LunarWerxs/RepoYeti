/**
 * The per-client SSE queue's bounding, and what its return value MEANS.
 *
 * `push()` returns false for "this stream can no longer be kept coherent — close it". There are
 * two ways that happens and only one of them used to be reported. An oversized single message was
 * refused; a client too slow to drain had its OLDEST queued events silently evicted and push()
 * still said true. The connection then stayed open looking perfectly healthy while individual
 * repo_state_changed events evaporated, and since the stream has no replay and the client has no
 * way to detect a gap, the affected repo's card stayed wrong until something else happened to
 * change it. A dropped event is a desync; closing the stream makes EventSource reconnect, and the
 * client resyncs on reconnect.
 */
import { expect, test } from "bun:test";
import {
  BoundedSseQueue,
  MAX_SSE_QUEUE,
  MAX_SSE_QUEUE_BYTES,
} from "../src/http/routes/events.ts";

test("SSE queue evicts old events by count, and reports the drop", () => {
  const queue = new BoundedSseQueue();
  // Everything up to the cap is queued cleanly.
  for (let i = 0; i < MAX_SSE_QUEUE; i++) {
    expect(queue.push({ event: "tick", data: String(i) })).toBe(true);
  }
  // The first push past it evicts, and says so.
  for (let i = MAX_SSE_QUEUE; i < MAX_SSE_QUEUE + 25; i++) {
    expect(queue.push({ event: "tick", data: String(i) })).toBe(false);
  }
  // The bound itself still holds, and it is the OLDEST events that went.
  expect(queue.items).toHaveLength(MAX_SSE_QUEUE);
  expect(queue.items[0]?.data).toBe("25");
});

test("SSE queue retains at most its byte budget, and reports the drop", () => {
  const queue = new BoundedSseQueue();
  const data = "x".repeat(128 * 1024);
  let dropped = 0;
  for (let i = 0; i < 40; i++) {
    if (!queue.push({ event: "snapshot", data })) dropped++;
  }
  expect(dropped).toBeGreaterThan(0);
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

test("a queue that never exceeds its bounds never asks to be closed", () => {
  // The regression that matters in the other direction: if push() started returning false on
  // ordinary traffic, every healthy client would be disconnected on every event.
  const queue = new BoundedSseQueue();
  for (let i = 0; i < MAX_SSE_QUEUE; i++) {
    expect(queue.push({ event: "repo_state_changed", data: `{"id":"${i}"}` })).toBe(true);
  }
  expect(queue.items).toHaveLength(MAX_SSE_QUEUE);
});
