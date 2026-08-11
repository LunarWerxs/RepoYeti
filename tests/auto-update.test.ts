import { test, expect, afterEach } from "bun:test";
import {
  runAutoUpdateOnce,
  setAutoUpdateHooks,
  setAutoUpdateEnabled,
  setUpdateNotifyEnabled,
  stopAutoUpdate,
  clampAutoUpdateInterval,
  AUTO_UPDATE_INTERVAL_MIN_S,
  AUTO_UPDATE_INTERVAL_MAX_S,
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
  AUTO_UPDATE_MAX_OPS_DEFERRALS,
} from "../src/auto-update.ts";

// The auto-update orchestrator's decision logic, driven through injected hooks so nothing actually
// pulls git / spawns / exits.
//
// Two settings share this pass and they are NOT the same consent:
//   · updateNotify (on by default) — announce an available update; install nothing.
//   · autoUpdate   (opt-in)        — additionally apply it and relaunch, unattended.
// So the apply-path cases below explicitly enable autoUpdate: without it, "nothing was applied"
// would pass for the wrong reason (the setting was off) rather than the reason under test.

// Reset the module's hooks + timer state after each case so they don't bleed across tests.
afterEach(() => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true); // module default
  stopAutoUpdate();
  setAutoUpdateHooks({}); // restore the real hooks
});

// A full UpdateStatus with sensible defaults; overrides tweak the fields under test.
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
    updateAvailable: false,
    canApply: false,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
// biome-ignore lint/suspicious/noExplicitAny: loose fixture shape so overrides can merge freely
function applyResult(over: Record<string, unknown>): any {
  return { ok: true, message: "updated", restartRequired: true, status: status({}), output: [], ...over };
}

test("applies + relaunches when an update is available and applicable", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: true });
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(applied).toBe(1);
  expect(relaunched).toBe(1);
});

test("does nothing when already up to date", async () => {
  let applied = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("up-to-date");
  expect(applied).toBe(0);
});

test("never applies on a dirty tree (canApply false)", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () =>
      status({ updateAvailable: true, canApply: false, dirty: true, reason: "local changes must be committed or stashed before updating" }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("does not relaunch when the apply fails", async () => {
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({ ok: false, message: "build failed" }),
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  expect(relaunched).toBe(0);
});

test("reports the reason when the check itself fails", async () => {
  setAutoUpdateHooks({
    check: async () => status({ ok: false, reason: "no update remote configured" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("no update remote configured");
});

test("clampAutoUpdateInterval bounds the cadence", () => {
  expect(clampAutoUpdateInterval(10)).toBe(AUTO_UPDATE_INTERVAL_MIN_S);
  expect(clampAutoUpdateInterval(9_999_999)).toBe(AUTO_UPDATE_INTERVAL_MAX_S);
  expect(clampAutoUpdateInterval(Number.NaN)).toBe(AUTO_UPDATE_INTERVAL_DEFAULT_S);
  expect(clampAutoUpdateInterval(3600)).toBe(3600);
});

// ── notify half: an update is announced, never installed ──────────────────────────────────

test("with auto-apply OFF it announces instead of installing", async () => {
  let applied = 0;
  let relaunched = 0;
  setUpdateNotifyEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("notified");
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  // The whole point: being told costs nothing and touches nothing.
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("announces even when the update cannot be applied (dirty tree)", async () => {
  // "An update is waiting, commit your work to take it" is exactly the useful thing to know.
  setUpdateNotifyEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: false, dirty: true, reason: "local changes" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("notified");
});

test("with both halves off it does nothing at all", async () => {
  let applied = 0;
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(false);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("notify-off");
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
});

test("nothing is announced or applied when already up to date", async () => {
  setUpdateNotifyEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("up-to-date");
});

// ── busy-deferral: never restart out from under work in flight ────────────────────────────

test("defers the apply when an MCP approval is pending", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
    hasPendingApprovals: () => true,
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("deferred");
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("defers the apply when the op-queue has an active operation", async () => {
  let applied = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
    hasActiveOperations: () => true,
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("deferred");
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
});

test("does not defer the notify path when work is in flight", async () => {
  // Busy-deferral only guards the unattended apply — being told about an update is always safe.
  setUpdateNotifyEnabled(true);
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({}),
    relaunch: () => {},
    hasPendingApprovals: () => true,
    hasActiveOperations: () => true,
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("notified");
});

test("applies once nothing is busy", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: true });
    },
    relaunch: () => {
      relaunched++;
    },
    hasPendingApprovals: () => false,
    hasActiveOperations: () => false,
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(applied).toBe(1);
  expect(relaunched).toBe(1);
});

test("op-queue busyness defers only AUTO_UPDATE_MAX_OPS_DEFERRALS times, then applies anyway", async () => {
  // Background read churn can keep the op-queue warm nearly continuously on a many-repo daemon;
  // an unattended updater that can be starved forever is the worse bug, so the cap wins.
  let applied = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
    hasPendingApprovals: () => false,
    hasActiveOperations: () => true, // never goes idle
  });
  for (let i = 0; i < AUTO_UPDATE_MAX_OPS_DEFERRALS; i++) {
    expect((await runAutoUpdateOnce()).reason).toBe("deferred");
    expect(applied).toBe(0);
  }
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(applied).toBe(1);
});

test("a pending approval defers past the ops cap — its own auto-deny timeout bounds it instead", async () => {
  let applied = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
    hasPendingApprovals: () => true,
    hasActiveOperations: () => false,
  });
  for (let i = 0; i < AUTO_UPDATE_MAX_OPS_DEFERRALS + 3; i++) {
    expect((await runAutoUpdateOnce()).reason).toBe("deferred");
  }
  expect(applied).toBe(0);
});

test("going idle resets the ops-deferral budget", async () => {
  // Defer twice busy, once idle (applies), then busy again — the counter must start over, not
  // remember the two spent deferrals from before the idle window.
  let busy = true;
  let applied = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
    hasPendingApprovals: () => false,
    hasActiveOperations: () => busy,
  });
  expect((await runAutoUpdateOnce()).reason).toBe("deferred");
  expect((await runAutoUpdateOnce()).reason).toBe("deferred");
  busy = false;
  expect((await runAutoUpdateOnce()).applied).toBe(true);
  busy = true;
  for (let i = 0; i < AUTO_UPDATE_MAX_OPS_DEFERRALS; i++) {
    expect((await runAutoUpdateOnce()).reason).toBe("deferred");
  }
  expect(applied).toBe(1);
});
