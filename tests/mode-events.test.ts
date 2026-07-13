import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createApp } from "../src/http/app.ts";
import { registerRepo, refreshRepo, stopWatching } from "../src/service/index.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { rmrf } from "./rmrf.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

// Closes E4: the PUT /api/mode start/stop toggle and the watcher→broadcast→SSE delivery path
// (a repo refresh reaching a live subscriber) had no test. tunnel.test.ts only covers the
// cloudflared resolver and watcher.test.ts only the health flag, so a regression in either of
// these would silently break remote-access enable/disable or live dashboard updates.

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const ownerCfg = (): RepoYetiConfig => ({
  roots: [],
  port: 7171,
  maxDepth: 6,
  maxRepos: 200,
  mode: "local",
  oauth: {
    issuer: "https://accounts.connections.icu",
    clientId: "test-client",
    redirectUri: "https://app.example.com/oauth/callback",
    ownerEmail: "owner@example.com",
  },
});

async function jsonReq(app: ReturnType<typeof createApp>, mode: unknown): Promise<Response> {
  return app.request("/api/mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
    headers: { "content-type": "application/json" },
  });
}

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

// ── PUT /api/mode (remote-access start/stop toggle) ──────────────────────────────────
// startManagedTunnel/stopManagedTunnel are inert here: the tunnel never starts because the
// runtime's serverPort is 0 in tests (setServerPort is only called once the daemon binds),
// so we exercise the route's guards + config mutation without spawning cloudflared.

test("PUT /api/mode rejects an unknown mode with BAD_MODE (400)", async () => {
  const res = await jsonReq(createApp(localCfg()), "sideways");
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("BAD_MODE");
});

test("PUT /api/mode → remote is refused until an owner is claimed (NEEDS_OWNER, 409)", async () => {
  const res = await jsonReq(createApp(localCfg()), "remote"); // no oauth owner
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("NEEDS_OWNER");
});

test("PUT /api/mode toggles remote↔local once an owner is configured", async () => {
  const cfg = ownerCfg();
  const app = createApp(cfg);

  // local → remote: allowed because the request is loopback and the mode is still local.
  const toRemote = await jsonReq(app, "remote");
  expect(toRemote.status).toBe(200);
  expect((await toRemote.json()).mode).toBe("remote");
  expect(cfg.mode).toBe("remote");

  // Remote is now enforced, so even a loopback request needs a session or the local bypass —
  // grab the loopback-only "continue local" cookie so we can drive the toggle back down.
  const cl = await app.request("/api/auth/continue-local", { method: "POST" });
  const cookie = (cl.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("=");

  const toLocal = await app.request("/api/mode", {
    method: "PUT",
    body: JSON.stringify({ mode: "local" }),
    headers: { "content-type": "application/json", cookie },
  });
  expect(toLocal.status).toBe(200);
  const body = await toLocal.json();
  expect(body.mode).toBe("local");
  expect(body.tunnelActive).toBe(false); // never started (no bound port)
  expect(cfg.mode).toBe("local");
});

// ── watcher → broadcast → SSE (a repo refresh reaches a live subscriber) ───────────────
// refreshRepo is exactly what the file watcher invokes on a change (watchOne →
// coalescedRefresh → refreshRepo). We drive it deterministically (write a file, then refresh)
// instead of waiting on a real fs event, then assert the resulting repo_state_changed frame
// lands on a GET /api/events subscriber.

test("a repo state change is delivered to a GET /api/events subscriber", async () => {
  const dir = mkScratchDir("ry-e4-");
  try {
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} -c user.name=T -c user.email=t@t.io commit -q --allow-empty -m init`.quiet();
    const reg = await registerRepo(dir);
    expect(reg.ok).toBe(true);
    const id = reg.repo!.id;

    const app = createApp(localCfg());
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await readUntil(reader, "hello", decoder); // subscriber is attached once the hello frame lands

      // Dirty the tree, then refresh — the same path the watcher fires on a change.
      writeFileSync(join(dir, "new.txt"), "hello\n");
      await refreshRepo(id, dir);

      const frame = await readUntil(reader, id, decoder);
      expect(frame).toContain("repo_state_changed");
      expect(frame).toContain(id);
    } finally {
      await reader.cancel();
    }
  } finally {
    stopWatching();
    await rmrf(dir);
  }
});
