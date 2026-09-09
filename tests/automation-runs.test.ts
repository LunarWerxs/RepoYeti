/**
 * Durable automation run history and safe cancellation (1.0 audit, item 23).
 *
 * The behaviours worth pinning are the ones that are wrong in every hand-rolled version of this:
 * a run that died with the daemon must not read as still in flight forever; a run that threw must
 * still be closed, and must not be filed as "the owner stopped it"; cancelling must stop the loop
 * STARTING repositories without aborting the one it is on; and disabling a loop mid-round must
 * now actually stop it, which is the defect the audit found, while the round controller's own
 * tested rule (disabling alone lets a round finish) stays exactly as it was.
 */
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import {
  beginAutomationRun,
  finishAutomationRun,
  getAutomationRun,
  listAutomationRunRepos,
  listAutomationRuns,
  markInterruptedAutomationRuns,
  recordAutomationRunRepo,
  setRepoAutoCommit,
  setRepoStatus,
  upsertRepo,
} from "../src/db.ts";
import { withAutomationRun } from "../src/automation-run.ts";
import { createRoundController, type RoundRun } from "../src/round-controller.ts";
import { addListener, removeListener, type BusListener } from "../src/bus.ts";
import {
  autoCommitRoundState,
  cancelAutoCommitRound,
  runAutoCommitNow,
  setAutoCommitEnabled,
} from "../src/auto-commit.ts";
import { cancelSyncCheckRound, syncCheckRoundState } from "../src/remote-sync.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

useSuiteTimeout(); // the cancellation round reaches real (fast-failing) git spawns

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

/** Collect every bus event for the duration of `fn`. */
async function recording<T>(fn: () => Promise<T>): Promise<{ result: T; events: Array<[string, unknown]> }> {
  const events: Array<[string, unknown]> = [];
  const listener: BusListener = (event, _data, payload) => events.push([event, payload]);
  addListener(listener);
  try {
    return { result: await fn(), events };
  } finally {
    removeListener(listener);
  }
}

/** Open a run row directly, bypassing withAutomationRun, for the db-layer tests. */
function openRun(kind: "auto_commit" | "sync_check" = "auto_commit"): string {
  const id = randomUUID();
  const written = beginAutomationRun({ id, kind, trigger: "timer", reposTotal: 3 });
  expect(written).toBe(id);
  return id;
}

// ── the persistence layer ───────────────────────────────────────────────────────────────────

test("a run round-trips: open, per-repo rows, close, read back", () => {
  const id = openRun();
  recordAutomationRunRepo(id, {
    repoId: "r1",
    repoName: "widget",
    durationMs: 1200,
    outcome: "committed",
    detail: { commits: 2, pulled: true, pushed: true },
  });
  recordAutomationRunRepo(id, {
    repoId: "r2",
    repoName: "gadget",
    durationMs: 40,
    outcome: "blocked",
    detail: { reason: "CONFLICT" },
  });
  finishAutomationRun(id, { outcome: "completed", reposDone: 1, reposBlocked: 1 });

  const run = getAutomationRun(id);
  expect(run).not.toBeNull();
  expect(run!.outcome).toBe("completed");
  expect(run!.trigger).toBe("timer");
  expect(run!.reposDone).toBe(1);
  expect(run!.reposBlocked).toBe(1);
  expect(run!.endedAt).not.toBeNull();

  const repos = listAutomationRunRepos(id);
  expect(repos.map((r) => r.repoName)).toEqual(["widget", "gadget"]);
  expect(repos[0]!.detail).toEqual({ commits: 2, pulled: true, pushed: true });
  expect(repos[0]!.durationMs).toBe(1200);
  expect(repos[1]!.outcome).toBe("blocked");
});

test("a run with no history row still lets the caller record and close without throwing", () => {
  // beginAutomationRun returns null when the row could not be written; every downstream call has
  // to tolerate it, because the round must not fail over its own reporting.
  expect(() =>
    recordAutomationRunRepo(null, { repoId: "r", repoName: "n", durationMs: 1, outcome: "synced" }),
  ).not.toThrow();
  expect(() => finishAutomationRun(null, { outcome: "completed", reposDone: 0, reposBlocked: 0 })).not.toThrow();
});

test("an unfinished run is marked interrupted on the next boot, with no invented end time", () => {
  const id = openRun();
  expect(getAutomationRun(id)!.outcome).toBeNull(); // in flight
  const closed = markInterruptedAutomationRuns();
  expect(closed).toBeGreaterThanOrEqual(1);

  const run = getAutomationRun(id)!;
  expect(run.outcome).toBe("interrupted");
  // Deliberately still null: we know it never reported ending, not WHEN it stopped. Stamping the
  // boot time would claim a round that died last week ended this morning.
  expect(run.endedAt).toBeNull();
  // Idempotent: a second boot with nothing open closes nothing.
  expect(markInterruptedAutomationRuns()).toBe(0);
});

test("a corrupt detail blob costs that row its detail, not the whole list", () => {
  const id = openRun();
  recordAutomationRunRepo(id, { repoId: "r1", repoName: "ok", durationMs: 5, outcome: "synced", detail: { a: 1 } });
  recordAutomationRunRepo(id, { repoId: "r2", repoName: "bad", durationMs: 5, outcome: "synced" });
  finishAutomationRun(id, { outcome: "completed", reposDone: 2, reposBlocked: 0 });

  const rows = listAutomationRunRepos(id);
  expect(rows.length).toBe(2);
  expect(rows[0]!.detail).toEqual({ a: 1 });
  // A row written with no detail reads as null rather than throwing or vanishing.
  expect(rows[1]!.detail).toBeNull();
});

test("listAutomationRuns is newest first and narrows by kind", () => {
  const commitRun = openRun("auto_commit");
  finishAutomationRun(commitRun, { outcome: "completed", reposDone: 0, reposBlocked: 0 });
  const syncRun = openRun("sync_check");
  finishAutomationRun(syncRun, { outcome: "completed", reposDone: 0, reposBlocked: 0 });

  const all = listAutomationRuns({ limit: 300 });
  expect(all.findIndex((r) => r.id === syncRun)).toBeLessThan(all.findIndex((r) => r.id === commitRun));

  const onlySync = listAutomationRuns({ limit: 300, kind: "sync_check" });
  expect(onlySync.some((r) => r.id === syncRun)).toBe(true);
  expect(onlySync.some((r) => r.id === commitRun)).toBe(false);
});

// ── the round wrapper ───────────────────────────────────────────────────────────────────────

test("withAutomationRun emits the lifecycle and records what the body reported", async () => {
  const { result, events } = await recording(() =>
    withAutomationRun(
      { kind: "auto_commit", trigger: "manual", reposTotal: 2, cancelled: () => false },
      async (history) => {
        history.repo({ repoId: "r1", repoName: "alpha", durationMs: 10, outcome: "committed" });
        history.repo({ repoId: "r2", repoName: "beta", durationMs: 20, outcome: "blocked" });
        return "done" as const;
      },
    ),
  );

  expect(result).toBe("done");
  const names = events.map(([n]) => n);
  expect(names.filter((n) => n === "automation_run_started").length).toBe(1);
  expect(names.filter((n) => n === "automation_run_progress").length).toBe(2);
  expect(names.filter((n) => n === "automation_run_done").length).toBe(1);

  const terminal = events.find(([n]) => n === "automation_run_done")![1] as Record<string, unknown>;
  expect(terminal.kind).toBe("auto_commit");
  expect(terminal.trigger).toBe("manual");
  expect(terminal.outcome).toBe("completed");
  expect(terminal.done).toBe(1);
  expect(terminal.blocked).toBe(1);

  const stored = getAutomationRun(String(terminal.runId))!;
  expect(stored.outcome).toBe("completed");
  expect(stored.reposDone).toBe(1);
  expect(stored.reposBlocked).toBe(1);
  expect(listAutomationRunRepos(stored.id).map((r) => r.repoName)).toEqual(["alpha", "beta"]);
});

test("a cancelled round is recorded as cancelled, not as a failure", async () => {
  const { events } = await recording(() =>
    withAutomationRun(
      { kind: "sync_check", trigger: "timer", reposTotal: 5, cancelled: () => true },
      async (history) => {
        history.repo({ repoId: "r1", repoName: "alpha", durationMs: 10, outcome: "synced" });
      },
    ),
  );

  const terminal = events.find(([n]) => n === "automation_run_cancelled");
  expect(terminal).toBeDefined();
  const payload = terminal![1] as Record<string, unknown>;
  expect(payload.outcome).toBe("cancelled");
  expect(getAutomationRun(String(payload.runId))!.outcome).toBe("cancelled");
});

test("a round that throws is still closed, and 'failed' wins over 'cancelled'", async () => {
  let runId = "";
  const listener: BusListener = (event, _data, payload) => {
    if (event === "automation_run_done") runId = String((payload as { runId: string }).runId);
  };
  addListener(listener);
  try {
    await expect(
      withAutomationRun(
        // Cancelled AND throwing: the reason it died is the more useful of the two answers, and
        // filing it as "the owner stopped it" would hide a real error behind a deliberate act.
        { kind: "auto_commit", trigger: "timer", reposTotal: 1, cancelled: () => true },
        async () => {
          throw new Error("the planner went away");
        },
      ),
    ).rejects.toThrow("the planner went away");
  } finally {
    removeListener(listener);
  }

  expect(runId).not.toBe("");
  const stored = getAutomationRun(runId)!;
  expect(stored.outcome).toBe("failed");
  expect(stored.error).toBe("the planner went away");
  expect(stored.endedAt).not.toBeNull();
});

// ── cancellation in the shared round controller ─────────────────────────────────────────────

/** A round the test releases by hand, which reports the signal it was handed. */
function deferredRound() {
  let release: (() => void) | null = null;
  let seen: RoundRun | null = null;
  const round = (run: RoundRun) =>
    new Promise<string>((resolve) => {
      seen = run;
      release = () => resolve("finished");
    });
  return {
    round,
    get run(): RoundRun | null {
      return seen;
    },
    release: () => {
      release?.();
      release = null;
    },
  };
}

test("cancel() aborts the in-flight round's signal and the round still resolves", async () => {
  const d = deferredRound();
  const ctl = createRoundController({ round: d.round, delayMs: () => 1000, setTimer: () => 1, clearTimer: () => {} });
  const pending = ctl.runNow();
  await Promise.resolve();

  expect(ctl.inFlight).toBe(true);
  expect(ctl.cancelling).toBe(false);
  expect(ctl.cancel()).toBe(true);
  expect(ctl.cancelling).toBe(true);
  expect(d.run!.cancelled).toBe(true);
  expect(d.run!.signal.aborted).toBe(true);

  d.release();
  // Cancelling asks; it does not reject. The round reports what it managed to do.
  await expect(pending).resolves.toBe("finished");
  expect(ctl.cancelling).toBe(false);
  expect(ctl.cancel()).toBe(false); // nothing in flight any more
});

test("the round body is told whether the timer or the owner started it", async () => {
  const seen: string[] = [];
  const clock: Array<() => void> = [];
  const ctl = createRoundController({
    round: async (run) => {
      seen.push(run.trigger);
    },
    delayMs: () => 1000,
    setTimer: (fn) => {
      clock.push(fn);
      return clock.length;
    },
    clearTimer: () => {},
  });
  await ctl.runNow();
  ctl.start();
  ctl.setEnabled(true);
  clock.pop()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(seen).toEqual(["manual", "timer"]);
});

test("setEnabled(false) alone still lets an in-flight round finish uncancelled", async () => {
  // The controller's original contract, unchanged. Cancelling is a separate verb; the LOOPS call
  // both (see setAutoCommitEnabled), but the controller itself must not, because the timer rules
  // depend on a cadence or mode change never abandoning work.
  const d = deferredRound();
  const ctl = createRoundController({ round: d.round, delayMs: () => 1000, setTimer: () => 1, clearTimer: () => {} });
  const pending = ctl.runNow();
  await Promise.resolve();

  ctl.setEnabled(false);
  expect(d.run!.cancelled).toBe(false);
  expect(ctl.cancelling).toBe(false);
  d.release();
  await pending;
});

// ── the loops' own cancel surface ───────────────────────────────────────────────────────────

test("cancelling an idle loop is a no-op answer, not an error", () => {
  expect(cancelAutoCommitRound()).toBe(false);
  expect(cancelSyncCheckRound()).toBe(false);
  expect(autoCommitRoundState()).toEqual({ running: false, cancelling: false });
  expect(syncCheckRoundState()).toEqual({ running: false, cancelling: false });
});

test("switching auto-commit off mid-round stops it walking the rest of the repositories", async () => {
  // THE defect item 23 names: disabling the schedule cleared a future timeout and nothing else,
  // so an unattended pass carried on committing and pushing every remaining repository after the
  // owner had switched the feature off.
  //
  // Four repositories at paths that do not exist. hasConflict's `git status` fails against each,
  // which is auto-commit.ts's "couldn't read the tree, safest to skip" branch: a real, fast,
  // observable per-repo outcome with no git fixture (same trick as the incidents suite).
  const mine: string[] = [];
  for (let i = 0; i < 4; i++) {
    const absPath = resolve("/", `repoyeti-cancel-test-missing-${randomUUID()}`);
    const id = upsertRepo(absPath, `cancel-test-${i}`, "created", false)!;
    expect(id).toBeTruthy();
    setRepoAutoCommit(id, true);
    setRepoStatus(id, {
      branch: "main",
      detached: false,
      dirty: 1, // enough for the round to consider it, with no remote needed
      ahead: 0,
      behind: 0,
      remote: null,
      error: null,
      fetchedAt: null,
      diff: null,
      updatedAt: Date.now(),
    });
    mine.push(id);
  }

  setAutoCommitEnabled(true); // never started, so this arms no timer; it only sets the flag

  // Pull the switch the instant the first repository reports, which is synchronous inside the
  // round's own progress broadcast. The loop's next cancellation check is the top of the very
  // next iteration, so this is deterministic rather than a sleep-and-hope.
  let terminal: Record<string, unknown> | null = null;
  const listener: BusListener = (event, _data, payload) => {
    if (event === "automation_run_progress" && !terminal) setAutoCommitEnabled(false);
    if (event === "automation_run_done" || event === "automation_run_cancelled") {
      terminal = payload as Record<string, unknown>;
    }
  };
  addListener(listener);
  try {
    await runAutoCommitNow();
  } finally {
    removeListener(listener);
    setAutoCommitEnabled(false);
    for (const id of mine) setRepoAutoCommit(id, false);
  }

  expect(terminal).not.toBeNull();
  const payload = terminal! as Record<string, unknown>;
  expect(payload.outcome).toBe("cancelled");
  // It stopped: exactly the one repository it had already picked up was processed, and the rest
  // were never started. The one in flight was allowed to finish, which is the whole point of
  // cooperative cancellation.
  expect(Number(payload.done) + Number(payload.blocked)).toBe(1);
  expect(Number(payload.total)).toBeGreaterThanOrEqual(4);

  const stored = getAutomationRun(String(payload.runId))!;
  expect(stored.outcome).toBe("cancelled");
  expect(stored.trigger).toBe("manual"); // runAutoCommitNow, not the timer
  expect(listAutomationRunRepos(stored.id).length).toBe(1);
});

// ── the HTTP surface ────────────────────────────────────────────────────────────────────────

test("GET /api/automation/runs lists history and says what is running now", async () => {
  const id = openRun("sync_check");
  finishAutomationRun(id, { outcome: "completed", reposDone: 0, reposBlocked: 0 });

  const app = createApp(localCfg());
  const res = await app.request("/api/automation/runs?limit=300");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    runs: Array<{ id: string }>;
    active: { autoCommit: { running: boolean }; syncCheck: { running: boolean } };
  };
  expect(body.runs.some((r) => r.id === id)).toBe(true);
  expect(body.active.autoCommit.running).toBe(false);
  expect(body.active.syncCheck.running).toBe(false);

  const narrowed = await app.request("/api/automation/runs?kind=auto_commit&limit=300");
  const only = (await narrowed.json()) as { runs: Array<{ id: string; kind: string }> };
  expect(only.runs.every((r) => r.kind === "auto_commit")).toBe(true);
});

test("GET /api/automation/runs/:id returns the per-repo breakdown, and 404s once it is gone", async () => {
  const id = openRun();
  recordAutomationRunRepo(id, {
    repoId: "r1",
    repoName: "alpha",
    durationMs: 7,
    outcome: "committed",
    detail: { commits: 1 },
  });
  finishAutomationRun(id, { outcome: "completed", reposDone: 1, reposBlocked: 0 });

  const app = createApp(localCfg());
  const res = await app.request(`/api/automation/runs/${id}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { run: { id: string }; repos: Array<{ repoName: string }> };
  expect(body.run.id).toBe(id);
  expect(body.repos.map((r) => r.repoName)).toEqual(["alpha"]);

  // A run past the row cap is genuinely gone, and "not found" reads very differently from a run
  // that touched nothing.
  const missing = await app.request(`/api/automation/runs/${randomUUID()}`);
  expect(missing.status).toBe(404);
});

test("POST /api/automation/cancel validates the loop name and answers honestly when idle", async () => {
  const app = createApp(localCfg());

  const bad = await app.request("/api/automation/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "everything" }),
  });
  expect(bad.status).toBe(400);

  const ok = await app.request("/api/automation/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "auto_commit" }),
  });
  expect(ok.status).toBe(200);
  // No round in flight: a successful "there was nothing to stop", which is what a second tap on a
  // Stop button finds.
  expect(await ok.json()).toEqual({ ok: true, kind: "auto_commit", cancelled: false });
});
