import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import { addListener, removeListener, broadcast } from "../src/bus.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// Closes the audit's P0 gap: the SSE bus + the GET /api/events live heartbeat (the dashboard's
// real-time channel) had no test. A regression here would silently kill live updates.

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// ── bus (pub/sub) ────────────────────────────────────────────────────────────────

test("broadcast delivers JSON-stringified payloads; removeListener stops delivery", () => {
  const got: Array<[string, string]> = [];
  const l = (e: string, d: string): void => void got.push([e, d]);
  addListener(l);
  broadcast("repo_state_changed", { id: "abc", n: 1 });
  expect(got).toEqual([["repo_state_changed", '{"id":"abc","n":1}']]);
  removeListener(l);
  broadcast("repo_state_changed", { id: "def" });
  expect(got.length).toBe(1); // removed → no further delivery
});

test("a throwing subscriber does not drop the event for other subscribers", () => {
  const delivered: string[] = [];
  const bad = (): void => {
    throw new Error("boom");
  };
  const good = (e: string): void => void delivered.push(e);
  addListener(bad);
  addListener(good);
  try {
    expect(() => broadcast("ping", {})).not.toThrow();
    expect(delivered).toEqual(["ping"]); // `good` still got it despite `bad` throwing
  } finally {
    removeListener(bad);
    removeListener(good);
  }
});

// ── SSE endpoint ───────────────────────────────────────────────────────────────────

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  decoder: TextDecoder,
  timeoutMs = 3000,
): Promise<string> {
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buf += decoder.decode(value, { stream: true });
    if (buf.includes(needle)) return buf;
  }
  return buf;
}

test("GET /api/events streams a hello frame and relays broadcasts to the subscriber", async () => {
  const app = createApp(localCfg());
  const res = await app.request("/api/events");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  try {
    expect(await readUntil(reader, "hello", decoder)).toContain("event: hello");

    broadcast("repo_state_changed", { id: "live-test", status: { dirty: 2 } });
    const frame = await readUntil(reader, "live-test", decoder);
    expect(frame).toContain("repo_state_changed");
    expect(frame).toContain("live-test");
  } finally {
    await reader.cancel(); // aborts the stream → server removes the listener
  }
});
