/**
 * One long-running background job at a time, cancellable, with a lifecycle the dashboard can
 * follow and reconcile against after a dropped connection.
 *
 * WHY THIS EXISTS. The project scan already had this shape: a module-level AbortController that
 * doubles as the single-flight guard, a `started` broadcast, periodic `progress` heartbeats, and
 * a terminal `done` or `cancelled`. "Fetch all" needed the same thing (1.0 audit item 24) and
 * automation runs will need it again, and three hand-rolled copies of a lifecycle is how two of
 * them end up subtly different — one forgetting to clear its handle before the terminal
 * broadcast, so a client that reacts to `done` by asking "are you still running?" is told yes.
 *
 * THE ORDER IS LOAD-BEARING, and it is the one the scan established: the handle is cleared BEFORE
 * the terminal event goes out. The daemon has no event replay, so a client's answer to a missed
 * terminal event is to poll the status route, and the two must never disagree.
 *
 * CANCELLATION IS COOPERATIVE, and deliberately so. `cancel()` aborts the signal; it does not
 * kill anything. A job that is mid-`git fetch` gets to finish that fetch and then stop before it
 * starts the next one. Killing a git process mid-transfer is how you leave an index.lock behind
 * for the owner to find later.
 */
import { randomUUID } from "node:crypto";
import { broadcast } from "../bus.ts";

/** The live run handed to a job body. */
export interface JobRun {
  /** This run's id. Carried on every event and by the status route, so a client can tell a
   *  stale `done` for the previous run from the one it is waiting on. */
  readonly id: string;
  readonly signal: AbortSignal;
  /** Whether the owner has asked to stop. Check between units of work, never mid-operation. */
  readonly cancelled: boolean;
  /** Emit a `<name>_progress` heartbeat. The run id is added for you. */
  progress(payload: Record<string, unknown>): void;
}

export interface JobState {
  running: boolean;
  /** The id of the run in flight, or null when idle. */
  jobId: string | null;
}

export interface Job<S extends object> {
  isRunning(): boolean;
  state(): JobState;
  /** Ask the in-flight run to stop. Returns whether there was one. */
  cancel(): boolean;
  /**
   * Run `body` as this job, unless one is already in flight — in which case this returns null
   * without disturbing it. The caller decides what a refused start means; nothing is broadcast.
   */
  start(started: Record<string, unknown>, body: (run: JobRun) => Promise<S>): Promise<S | null>;
}

/**
 * @param name event prefix: `<name>_started`, `<name>_progress`, `<name>_done`, `<name>_cancelled`.
 */
export function createJob<S extends object>(name: string): Job<S> {
  let active: AbortController | null = null;
  let activeId: string | null = null;

  function isRunning(): boolean {
    return active !== null;
  }

  return {
    isRunning,
    state: () => ({ running: active !== null, jobId: activeId }),
    cancel(): boolean {
      if (!active) return false;
      active.abort();
      return true;
    },
    async start(started, body): Promise<S | null> {
      if (active) return null;
      const controller = new AbortController();
      const id = randomUUID();
      active = controller;
      activeId = id;
      const run: JobRun = {
        id,
        signal: controller.signal,
        get cancelled() {
          return controller.signal.aborted;
        },
        progress: (payload) => broadcast(`${name}_progress`, { jobId: id, ...payload }),
      };
      broadcast(`${name}_started`, { jobId: id, ...started });
      let summary: S | null = null;
      let failure: unknown;
      try {
        summary = await body(run);
      } catch (err) {
        failure = err;
      } finally {
        // Cleared before the terminal event, so a client that polls on hearing it is told the
        // truth. See the header.
        active = null;
        activeId = null;
      }
      const cancelled = controller.signal.aborted;
      // A terminal event ALWAYS goes out, including when the body threw. Without this a crashed
      // job left the dashboard's spinner running until the next reconnect happened to reconcile
      // it, which for a job nobody restarts is forever. The error text rides along so the client
      // can say what went wrong instead of showing an empty summary.
      broadcast(`${name}_${cancelled ? "cancelled" : "done"}`, {
        jobId: id,
        ...(summary ?? {}),
        cancelled,
        ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
      });
      if (failure) throw failure;
      return summary as S;
    },
  };
}
