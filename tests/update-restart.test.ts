/**
 * POST /api/updates/restart — the daemon half of "Restart to finish" (issue #23).
 *
 * A MANUAL update installs the new build and deliberately does not relaunch; only the opt-in
 * unattended apply does that. So the version badge correctly read "Restart to finish" and that was
 * the end of it — a statement of what had to happen next, on a screen (an installed PWA, on a
 * phone) with no tray and no terminal beside it to go and do it.
 *
 * What this file pins is the shape of the answer, because the badge is a button now and every
 * outcome has to be legible from it: a refusal must arrive as a code the UI can act on rather than
 * a silent no-op, and a restart must never be claimed for a daemon that is staying put. The
 * decision logic itself lives in src/auto-update.ts (tests/auto-update.test.ts drives it directly).
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { setAutoUpdateHooks } from "../src/auto-update.ts";
import type { RepoYetiConfig } from "../src/config.ts";

// REPOYETI_HOME points at a throwaway dir (tests/setup.ts, bunfig preload).
const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
/** The marker POST /api/shutdown drops for the tray host — see src/instance.ts. */
const SENTINEL = join(process.env.REPOYETI_HOME as string, "shutdown.request");

afterEach(() => {
  setAutoUpdateHooks({}); // restore the real hooks
  rmSync(SENTINEL, { force: true });
});

/** Wire a relaunch handler that records calls instead of spawning anything. */
function stubRelaunch(spawns: boolean, busy: { approvals?: boolean; ops?: boolean } = {}) {
  const calls = { count: 0 };
  setAutoUpdateHooks({
    relaunch: () => {
      calls.count++;
      return spawns;
    },
    hasPendingApprovals: () => busy.approvals === true,
    hasActiveOperations: () => busy.ops === true,
  });
  return calls;
}

test("restarts the daemon through the auto-updater's own relaunch", async () => {
  const calls = stubRelaunch(true);

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls.count).toBe(1);
});

test("does NOT write the tray's full-shutdown sentinel — this is a restart, not a quit", async () => {
  // The distinction is the whole reason this route exists rather than reusing /api/shutdown: that
  // sentinel tells the tray host to dispose its notification icon, exit, and stand its auto-restart
  // watchdog down. Dropping it here would mean tapping "Restart to finish" quit RepoYeti.
  stubRelaunch(true);
  expect(existsSync(SENTINEL)).toBe(false);

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(200);
  expect(existsSync(SENTINEL)).toBe(false);
});

test("409 BUSY while a git operation is running, naming what is in the way", async () => {
  const calls = stubRelaunch(true, { ops: true });

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("BUSY");
  // The message IS the whole answer on a phone — it has to say what to do about it.
  expect(body.message).toContain("git operation");
  expect(calls.count).toBe(0);
});

test("409 BUSY while an agent is waiting on an MCP approval", async () => {
  const calls = stubRelaunch(true, { approvals: true });

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("BUSY");
  expect(calls.count).toBe(0);
});

test("409 NOT_CONFIGURED when no relaunch handler is wired, rather than a hollow ok", async () => {
  // createApp() outside the daemon has only the warn-only default (src/auto-update.ts). Answering
  // 200 here would leave the dashboard showing "Restarting…" for a daemon that never went down.
  setAutoUpdateHooks({});

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("NOT_CONFIGURED");
});

test("500 when the successor could not be spawned — the old daemon is still serving", async () => {
  // lifecycle's handler catches a failed spawn and stays up on purpose: exiting without a successor
  // leaves the machine with zero daemons. That is a real failure to report, not a restart.
  const calls = stubRelaunch(false);

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(500);
  expect((await res.json()).code).toBe("ERROR");
  expect(calls.count).toBe(1);
});
