/**
 * One round of a scheduled loop, recorded durably (1.0 audit, item 23).
 *
 * WHY THIS EXISTS. The unattended loops broadcast what they did over SSE and nothing else. That
 * reaches whoever happened to have the dashboard open at the moment the timer fired, which for an
 * automation feature is close to nobody: the whole point of auto-commit is that it runs while the
 * owner is asleep. `auto_commit_incidents` covers half the gap, but only half and deliberately so
 * - it is a list of open PROBLEMS, upserted per (repo, reason) and acknowledged, so it can neither
 * record a successful commit nor say how long anything took without destroying the "needs
 * attention" badge it exists to feed. This module writes the other half: one row per round, one
 * child row per repository the round actually did something to.
 *
 * WHY IT IS NOT service/job.ts. Both are lifecycles, and they look alike on purpose, but they own
 * different things. `createJob` owns single-flight for a job the owner starts; these rounds
 * already have single-flight and a timer from round-controller.ts, and nesting a second
 * AbortController inside the first would mean two answers to "is it running" that can disagree.
 * So this wraps a round the controller has already admitted, and takes the cancellation signal
 * from it rather than minting one.
 *
 * WHAT IS AND IS NOT RECORDED. A round considers every opted-in repository; it records the ones
 * where something observable happened. A repository that was clean, up to date and had nothing to
 * push produces no row, because a history whose bulk is "nothing happened, 200 times" answers no
 * question and spends the row cap on silence. `reposTotal` still counts everything considered, so
 * "40 repos, 2 touched" is readable from the run row alone.
 *
 * FAILURE POSTURE. Nothing in here throws into the round. History is a reporting feature; a
 * storage hiccup must never stop the timer from committing the owner's work. The db layer returns
 * a null run id and logs, and every call below tolerates that null.
 */
import { randomUUID } from "node:crypto";
import { broadcast } from "./bus.ts";
import {
  beginAutomationRun,
  finishAutomationRun,
  recordAutomationRunRepo,
  type AutomationRepoOutcome,
  type AutomationRunKind,
  type AutomationRunTrigger,
} from "./db.ts";

/** The handle a round body uses to report what it did. */
export interface AutomationRunTracker {
  /** This run's id. Null when the history row could not be written; every method still works. */
  readonly id: string | null;
  /** How many repositories have produced an observable outcome so far. */
  readonly done: number;
  /** How many were blocked or errored so far. */
  readonly blocked: number;
  /**
   * Record one repository's outcome and emit a progress heartbeat. `durationMs` is how long that
   * repository took, which is the number that answers "why did last night's run take an hour".
   */
  repo(input: {
    repoId: string;
    repoName: string;
    durationMs: number;
    outcome: AutomationRepoOutcome;
    detail?: Record<string, unknown>;
  }): void;
  /** Revise the considered-repository count when it is only known partway through a round. */
  setTotal(total: number): void;
}

export interface AutomationRunSpec {
  kind: AutomationRunKind;
  trigger: AutomationRunTrigger;
  /** Repositories in scope. Revisable through `tracker.setTotal`. */
  reposTotal: number;
  /** Read at the end to decide `cancelled` vs `completed`. Supplied by the round controller. */
  cancelled: () => boolean;
}

/**
 * Run `body` as a recorded round.
 *
 * The terminal row and the terminal broadcast ALWAYS happen, including when the body throws, and
 * the row is closed before the event goes out. Same two rules as service/job.ts and for the same
 * reason: a client that reacts to the terminal event by asking the daemon what happened must not
 * be told the run is still in flight, and a round that died must not leave a row that the next
 * boot then reports as `interrupted` when in fact it failed here and we knew why.
 */
export async function withAutomationRun<T>(
  spec: AutomationRunSpec,
  body: (tracker: AutomationRunTracker) => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  const startedAt = Date.now();
  const runId = beginAutomationRun({
    id,
    kind: spec.kind,
    trigger: spec.trigger,
    reposTotal: spec.reposTotal,
  });
  let total = spec.reposTotal;
  let done = 0;
  let blocked = 0;

  const tracker: AutomationRunTracker = {
    id: runId,
    get done() {
      return done;
    },
    get blocked() {
      return blocked;
    },
    setTotal(next) {
      total = Math.max(0, Math.round(next));
    },
    repo(input) {
      if (input.outcome === "blocked" || input.outcome === "error") blocked++;
      else done++;
      recordAutomationRunRepo(runId, input);
      broadcast("automation_run_progress", {
        runId: id,
        kind: spec.kind,
        current: input.repoName,
        outcome: input.outcome,
        done,
        blocked,
        total,
      });
    },
  };

  broadcast("automation_run_started", {
    runId: id,
    kind: spec.kind,
    trigger: spec.trigger,
    total,
    startedAt,
  });

  let result: T | undefined;
  let failure: unknown;
  try {
    result = await body(tracker);
  } catch (err) {
    failure = err;
  }

  const cancelled = spec.cancelled();
  const error = failure ? (failure instanceof Error ? failure.message : String(failure)) : null;
  // `failed` wins over `cancelled`: a round that threw AND was cancelled has a reason worth
  // keeping, and "cancelled" would hide it behind something the owner did on purpose.
  const outcome = failure ? "failed" : cancelled ? "cancelled" : "completed";
  finishAutomationRun(runId, { outcome, reposTotal: total, reposDone: done, reposBlocked: blocked, error });
  broadcast(`automation_run_${cancelled && !failure ? "cancelled" : "done"}`, {
    runId: id,
    kind: spec.kind,
    trigger: spec.trigger,
    outcome,
    total,
    done,
    blocked,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  });

  if (failure) throw failure;
  return result as T;
}
