/**
 * One in-flight round, one armed timer: the self-scheduling controller behind the auto-commit and
 * remote-sync loops (src/auto-commit.ts, src/remote-sync.ts).
 *
 * Both modules used to carry a hand-rolled copy of the same plumbing: a `timer` handle, a
 * `ticking` boolean, `schedule()`, `runTick()`, `reconcile()`, `retime()`. The two copies had the
 * same hole (1.0 audit, item 10): the MANUAL entry point checked `ticking` before starting, but
 * the TIMER entry point set it without checking. A timer that fired while a manual round was
 * still awaiting the AI or the network started a second pass over every repository at once —
 * planning, status scans, fetches, baselines and incident rows all duplicated (the per-repo
 * op-queue still serialised the actual mutations, which is why it was never a data-loss bug) —
 * and whichever round finished first cleared the shared boolean while the other was still
 * running, opening the door to a third.
 *
 * The rules, in one place:
 *   - At most ONE round is in flight. A timer firing during a round starts nothing; a manual
 *     `runNow()` during a round returns null (the callers keep their "already running" answers).
 *   - At most ONE timer is armed. A round ending re-arms only if nothing is armed, so a manual
 *     round does not disturb the cadence, and a timer that fired into a busy round is replaced
 *     exactly once when that round ends.
 *   - `setEnabled(false)` mid-round disarms the timer and lets the round finish; the round's tail
 *     then re-arms nothing. `setEnabled(true)` mid-round arms nothing until the round ends, and
 *     then exactly once. Stopping the daemon (`stop()`) disarms permanently.
 *   - `delayMs` is a thunk read at arm time, so a cadence or mode change (`retime()`) takes
 *     effect on the next arm; mid-round it is picked up by the round's own tail.
 *
 * CANCELLATION (1.0 audit, item 23) is a SEPARATE verb from disabling, and deliberately so. The
 * rule above — disabling lets the in-flight round finish — is load-bearing for the timer: a
 * cadence or mode change must not abandon work halfway. But an owner who switches auto-commit
 * OFF while an unattended round is still walking their repositories means "stop", and until this
 * the round kept going for every repository after the one in flight. So `cancel()` was added
 * NEXT TO `setEnabled`, not inside it: the controller's own contract is unchanged, and the loops
 * that want the owner's toggle to mean stop call both (auto-commit.ts, remote-sync.ts).
 *
 * Cancelling is COOPERATIVE. It aborts the round's signal; it kills nothing. A round mid-`git
 * fetch` or mid-commit finishes that unit of work and then stops before it starts the next
 * repository. Same reasoning as service/job.ts: killing a git process mid-transfer is how an
 * index.lock is left behind for the owner to find later. A round body that ignores the signal
 * simply runs to completion, which is why adding this could not break the existing rounds.
 *
 * Timer functions are injectable so the ordering rules can be tested against a controlled clock
 * rather than the 30s / 60s cadence floors the real loops enforce.
 */

/** The live round handed to a round body. Older bodies that take no argument still typecheck. */
export interface RoundRun {
  /** Why this round started: the armed timer, or an explicit `runNow()`. Recorded on the run row
   *  so history can tell an unattended pass from one the owner asked for. */
  readonly trigger: "timer" | "manual";
  readonly signal: AbortSignal;
  /** Whether the owner has asked this round to stop. Check BETWEEN units of work, never mid-git. */
  readonly cancelled: boolean;
}

export interface RoundControllerOptions<T> {
  /** The work of one round. Rejections from a TIMER-fired round are swallowed (a round failing
   *  is non-fatal; the loop tries again next time); rejections from `runNow()` propagate. */
  round: (run: RoundRun) => Promise<T>;
  /** Delay until the next timer-fired round, read at arm time. */
  delayMs: () => number;
  /** Test seams; default to the real timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RoundController<T> {
  /** Run a round now. Resolves null (without running anything) when a round is already in flight. */
  runNow(): Promise<T | null>;
  /** The daemon has booted: arm the timer if enabled. */
  start(): void;
  /** Daemon shutdown: disarm and stay disarmed until `start()` again. */
  stop(): void;
  /** Config toggle: arm or disarm live. */
  setEnabled(on: boolean): void;
  /** Cadence/mode changed: re-arm a running, idle loop with the fresh `delayMs()`. */
  retime(): void;
  /**
   * Ask the in-flight round to stop after the unit of work it is on. Returns whether there was
   * one to ask. Does NOT disarm the timer (that is `setEnabled(false)`/`stop()`) and does not
   * make the round reject: a cancelled round still resolves, with whatever it completed.
   */
  cancel(): boolean;
  readonly inFlight: boolean;
  readonly armed: boolean;
  readonly enabled: boolean;
  /** True while a round is in flight and has been asked to stop. */
  readonly cancelling: boolean;
}

export function createRoundController<T>(opts: RoundControllerOptions<T>): RoundController<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let started = false;
  let enabled = false;
  let inFlight = false;
  let timer: unknown = null;
  /** The in-flight round's cancellation handle, or null when idle. */
  let running: AbortController | null = null;

  function disarm(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }
  function arm(): void {
    timer = setTimer(fire, opts.delayMs());
  }
  /** Arm exactly when the loop should be waiting: started, enabled, idle, and not already armed. */
  function reconcile(): void {
    if (!started) return;
    if (enabled && timer === null && !inFlight) arm();
    else if (!enabled) disarm();
  }
  async function runRound(trigger: "timer" | "manual"): Promise<T> {
    inFlight = true;
    const controller = new AbortController();
    running = controller;
    const run: RoundRun = {
      trigger,
      signal: controller.signal,
      get cancelled() {
        return controller.signal.aborted;
      },
    };
    try {
      return await opts.round(run);
    } finally {
      inFlight = false;
      running = null;
      // Exactly one re-arm, and only if nothing is armed: a timer that fired into this round
      // consumed itself (timer === null), a timer still pending from before a manual round is
      // left alone, and a loop disabled or stopped mid-round arms nothing.
      reconcile();
    }
  }
  function fire(): void {
    timer = null; // the handle has spent itself whether or not a round starts
    if (inFlight) return; // the running round's tail re-arms; never a second concurrent pass
    void runRound("timer").catch(() => {
      /* a timer-fired round failing is non-fatal; the tail already re-armed */
    });
  }

  return {
    runNow: () => (inFlight ? Promise.resolve(null) : runRound("manual")),
    start: () => {
      started = true;
      reconcile();
    },
    stop: () => {
      started = false;
      disarm();
    },
    setEnabled: (on) => {
      enabled = on;
      reconcile();
    },
    retime: () => {
      if (started && enabled && !inFlight) {
        disarm();
        arm();
      }
    },
    cancel: () => {
      if (!running) return false;
      running.abort();
      return true;
    },
    get inFlight() {
      return inFlight;
    },
    get cancelling() {
      return running?.signal.aborted ?? false;
    },
    get armed() {
      return timer !== null;
    },
    get enabled() {
      return enabled;
    },
  };
}
