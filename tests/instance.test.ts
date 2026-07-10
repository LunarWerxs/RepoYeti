import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  clearInstanceInfo,
  findLiveInstance,
  instanceFilePath,
  readInstanceInfo,
  writeInstanceInfo,
} from "../src/instance.ts";

// REPOYETI_HOME is pointed at a throwaway dir by tests/setup.ts, so these never touch
// the real ~/.repoyeti/runtime.json.

test("writeInstanceInfo / readInstanceInfo roundtrip, then clear", () => {
  writeInstanceInfo(7777);
  const info = readInstanceInfo();
  expect(info?.port).toBe(7777);
  expect(info?.url).toBe("http://127.0.0.1:7777");
  expect(info?.pid).toBe(process.pid);
  expect(existsSync(instanceFilePath())).toBe(true);

  clearInstanceInfo();
  expect(readInstanceInfo()).toBeNull();
  expect(existsSync(instanceFilePath())).toBe(false);
});

test("findLiveInstance: null when there's no pointer", async () => {
  clearInstanceInfo();
  expect(await findLiveInstance(300)).toBeNull();
});

test("findLiveInstance: null for a stale pointer (nobody listening)", async () => {
  // Grab a real free port, then release it so the probe is guaranteed to be refused.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const deadPort = probe.port!;
  probe.stop(true);

  writeInstanceInfo(deadPort);
  expect(await findLiveInstance(300)).toBeNull();
  clearInstanceInfo();
});

test("findLiveInstance: returns the pointer when a repoyeti daemon answers /api/health", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/health")
        return Response.json({ ok: true, service: "repoyeti", version: "test" });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    writeInstanceInfo(server.port!);
    const live = await findLiveInstance(1000);
    expect(live?.port).toBe(server.port);
  } finally {
    server.stop(true);
    clearInstanceInfo();
  }
});

test("findLiveInstance: null when the port is held by a NON-repoyeti server", async () => {
  const other = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, service: "something-else" }),
  });
  try {
    writeInstanceInfo(other.port!);
    expect(await findLiveInstance(1000)).toBeNull();
  } finally {
    other.stop(true);
    clearInstanceInfo();
  }
});
