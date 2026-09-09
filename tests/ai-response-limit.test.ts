/**
 * The AI HTTP reader bounds the BYTES of a provider response, not just the time (audit item 14).
 *
 * `requestJson` used to `await res.text()` before parsing or truncating anything, so a wrong or
 * hostile configured endpoint could make the daemon allocate an arbitrarily large string; the
 * request timeout bounds how long that takes, not how much arrives. These tests stream a body
 * through the injectable fetch, so nothing depends on a Content-Length header a real server could
 * simply omit.
 */
import { expect, test } from "bun:test";
import { AiError, MAX_AI_RESPONSE_BYTES, requestJson } from "../src/ai/commit-message.ts";

const CHUNK = new Uint8Array(64 * 1024).fill(0x61); // 'a'

/** An endless body: every pull enqueues another chunk until the reader cancels it. */
function endlessBody(counters: { pulled: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      counters.pulled += CHUNK.byteLength;
      controller.enqueue(CHUNK);
    },
    cancel() {
      counters.cancelled = true;
    },
  });
}

test("a streamed success body past the ceiling is cancelled mid-stream and reported as a short error", async () => {
  const counters = { pulled: 0, cancelled: false };
  const fetchImpl = async () =>
    new Response(endlessBody(counters), { status: 200, headers: { "content-type": "application/json" } });

  const failure = await requestJson("https://ai.example/v1/chat", { method: "POST" }, fetchImpl).then(
    () => null,
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(AiError);
  expect((failure as AiError).code).toBe("AI_ERROR");
  expect((failure as AiError).message).toContain("exceeded");
  // The stream was cancelled at the limit, not drained: a bounded overshoot of a few chunks at most.
  expect(counters.cancelled).toBe(true);
  expect(counters.pulled).toBeLessThan(MAX_AI_RESPONSE_BYTES + 8 * CHUNK.byteLength);
});

test("an ERROR response past the ceiling is bounded the same way (error bodies used to be read whole too)", async () => {
  const counters = { pulled: 0, cancelled: false };
  const fetchImpl = async () => new Response(endlessBody(counters), { status: 500 });
  const failure = await requestJson("https://ai.example/v1/chat", { method: "POST" }, fetchImpl).then(
    () => null,
    (e: unknown) => e,
  );
  expect((failure as AiError).code).toBe("AI_ERROR");
  expect(counters.cancelled).toBe(true);
});

test("a normal-sized JSON body still parses, and a normal error still maps to its code", async () => {
  const ok = await requestJson(
    "https://ai.example/v1/chat",
    { method: "POST" },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "feat: x" } }] }), { status: 200 }),
  );
  expect((ok as { choices: unknown[] }).choices).toHaveLength(1);

  const denied = await requestJson(
    "https://ai.example/v1/chat",
    { method: "POST" },
    async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect((denied as AiError).code).toBe("AI_AUTH_FAILED");
});
