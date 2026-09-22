/**
 * Guards that keep the auto-updater from stepping on itself — the auto-update group's regression
 * file for three reviewed defects (F036/F037/F038):
 *
 *   · F036 — a MANUAL install (POST /api/updates/apply) took no shared slot, so `applying` stayed
 *     false for the minutes it spent pulling/installing/building and a "Restart to finish" shut the
 *     daemon down mid-install (half-applied checkout, UI reporting success).
 *   · F037 — `auto_update_restarting` was broadcast BEFORE the spawn outcome was known, so a failed
 *     spawn left every connected dashboard stuck on "Restarting…" (the reset only comes from an SSE
 *     reconnect that a daemon which never went down never triggers).
 *   · F038 — requestRelaunch had no re-entrancy guard: two taps inside the ~800ms handover spawned
 *     two successors racing for the same port.
 *
 * The decision logic lives in src/auto-update.ts; the HTTP shape in src/http/routes/updates.ts.
 * tests/auto-update.test.ts and tests/update-restart.test.ts cover the surrounding behaviour.
 */
import { test, expect, afterEach } from "bun:test";
import { addListener, removeListener, type BusListener } from "../src/bus.ts";
import {
  beginUpdateApply,
  releaseUpdateApply,
  requestRelaunch,
  runAutoUpdateOnce,
  setAutoUpdateEnabled,
  setUpdateNotifyEnabled,
  setAutoUpdateHooks,
  stopAutoUpdate,
} from "../src/auto-update.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

afterEach(() => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true);
  stopAutoUpdate();
  releaseUpdateApply();
  setAutoUpdateHooks({}); // restores real hooks (and clears the relaunch flag)
});

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

// biome-ignore lint/suspicious/noExplicitAny: loose fixture shape so overrides can merge freely
function status(over: Record<string, unknown>): any {
  return {
    ok: true,
    service: "repoyeti",
    currentVersion: "0.1.0",
    currentCommit: "aaaa",
    remoteCommit: "bbbb",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: true,
    canApply: true,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
// biome-ignore lint/suspicious/noExplicitAny: loose fixture shape so overrides can merge freely
function applyResult(over: Record<string, unknown>): any {
  return { ok: true, message: "updated", restartRequired: true, status: status({}), output: [], ...over };
}

/** Collect bus event names while `fn` (possibly async) runs. */
async function captureEvents(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const listener: BusListener = (event) => {
    seen.push(event);
  };
  addListener(listener);
  try {
    await fn();
  } finally {
    removeListener(listener);
  }
  return seen;
}

// ── F036: one apply slot, manual and unattended ───────────────────────────────────────────────

test("a manual apply holding the slot refuses a restart instead of being killed mid-install", async () => {
  let relaunched = 0;
  setAutoUpdateHooks({
    relaunch: () => {
      relaunched++;
      return true;
    },
    hasPendingApprovals: () => false,
    hasActiveOperations: () => false,
  });
  beginUpdateApply(); // as POST /api/updates/apply does for the whole install

  const res = await createApp(localCfg()).request("/api/updates/restart", { method: "POST" });

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("BUSY");
  expect(body.message).toContain("installing");
  expect(relaunched).toBe(0);
});

test("the manual apply route refuses a second concurrent install rather than running two", async () => {
  beginUpdateApply();
  // If the route did NOT take the slot this would fall through to the real applyUpdate() (git pull).
  const res = await createApp(localCfg()).request("/api/updates/apply", { method: "POST" });

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("BUSY");
  expect(body.message).toContain("already installing");
});

test("the unattended pass defers while a manual apply holds the slot", async () => {
  let applied = 0;
  setAutoUpdateEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({}),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => true,
  });
  beginUpdateApply();

  const r = await runAutoUpdateOnce();

  expect(r.reason).toBe("busy");
  expect(applied).toBe(0);
});

test("once the manual apply releases the slot, a restart goes through again", async () => {
  let relaunched = 0;
  setAutoUpdateHooks({
    relaunch: () => {
      relaunched++;
      return true;
    },
    hasPendingApprovals: () => false,
    hasActiveOperations: () => false,
  });
  beginUpdateApply();
  expect(requestRelaunch()).toEqual({ ok: false, reason: "update-in-flight" });

  releaseUpdateApply();

  expect(requestRelaunch()).toEqual({ ok: true });
  expect(relaunched).toBe(1);
});

// ── F037: announce the restart only once a successor exists ───────────────────────────────────

test("a failed unattended spawn broadcasts NO auto_update_restarting", async () => {
  setAutoUpdateEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({}),
    apply: async () => applyResult({ restartRequired: true }),
    relaunch: () => false, // lifecycle stays up rather than exit with no successor
  });

  let r!: Awaited<ReturnType<typeof runAutoUpdateOnce>>;
  const events = await captureEvents(async () => {
    r = await runAutoUpdateOnce();
  });

  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(false);
  expect(events).not.toContain("auto_update_restarting");
});

test("a successful unattended spawn still broadcasts auto_update_restarting", async () => {
  setAutoUpdateEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({}),
    apply: async () => applyResult({ restartRequired: true, message: "restarting to finish" }),
    relaunch: () => true,
  });

  let r!: Awaited<ReturnType<typeof runAutoUpdateOnce>>;
  const events = await captureEvents(async () => {
    r = await runAutoUpdateOnce();
  });

  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(events).toContain("auto_update_restarting");
});

// ── F038: a second restart while the first is still handing over ──────────────────────────────

test("a second restart inside the handover window is refused, not spawned twice", async () => {
  let spawns = 0;
  setAutoUpdateHooks({
    relaunch: () => {
      spawns++;
      return true; // the successor exists; shutdown is merely scheduled ~800ms out
    },
    hasPendingApprovals: () => false,
    hasActiveOperations: () => false,
  });

  expect(requestRelaunch()).toEqual({ ok: true });
  expect(requestRelaunch()).toEqual({ ok: false, reason: "already-restarting" });
  expect(spawns).toBe(1);
});

test("a failed spawn stays retryable — otherwise one transient failure would wall off restarts", () => {
  let spawns = 0;
  setAutoUpdateHooks({
    relaunch: () => {
      spawns++;
      return spawns > 1; // first attempt fails, the retry succeeds
    },
    hasPendingApprovals: () => false,
    hasActiveOperations: () => false,
  });

  expect(requestRelaunch()).toEqual({ ok: false, reason: "spawn-failed" });
  expect(requestRelaunch()).toEqual({ ok: true });
  expect(spawns).toBe(2);
});
