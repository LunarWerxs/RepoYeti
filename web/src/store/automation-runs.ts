import { ref } from "vue";
import { api, ApiError } from "../api";
import type {
  AutomationRoundState,
  AutomationRun,
  AutomationRunKind,
  AutomationRunOutcome,
  AutomationRunRepo,
} from "../types";

/** The in-flight progress of one loop's current round, kept live by `applyAutomationRunEvent`
 *  below rather than by polling. Null until an `automation_run_started` for that kind arrives. */
interface LiveAutomationRun {
  runId: string;
  done: number;
  blocked: number;
  total: number;
  current: string | null;
}

/** The two fields every `automation_run_*` branch needs before it can decide anything, plus the
 *  narrowed payload itself. Null when the event is not one of ours at all. */
interface RunEventRef {
  kind: AutomationRunKind;
  runId: string;
  fields: Record<string, unknown>;
}

/**
 * Narrow an unknown SSE payload into a `RunEventRef`, or null when it isn't an automation run
 * event. Never trusts a field: `kind` must be one of the two known loops and `runId` a string,
 * because both are used as state keys below.
 */
function asRunEvent(payload: unknown): RunEventRef | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const kind: AutomationRunKind | null = p.kind === "auto_commit" || p.kind === "sync_check" ? p.kind : null;
  if (!kind) return null;
  const runId = typeof p.runId === "string" ? p.runId : null;
  if (!runId) return null;
  return { kind, runId, fields: p };
}

const numOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const strOr = (v: unknown, fallback: string | null): string | null => (typeof v === "string" ? v : fallback);

/** The live run a `_started` event defines: payload counters start at whatever the daemon sent. */
function startedLiveRun(p: Record<string, unknown>, runId: string): LiveAutomationRun {
  return { runId, done: 0, blocked: 0, total: numOr(p.total, 0), current: null };
}

/** A `_progress` event merged over the live run: a field the payload omits keeps its held value. */
function progressedLiveRun(p: Record<string, unknown>, live: LiveAutomationRun): LiveAutomationRun {
  return {
    runId: live.runId,
    done: numOr(p.done, live.done),
    blocked: numOr(p.blocked, live.blocked),
    total: numOr(p.total, live.total),
    current: strOr(p.current, live.current),
  };
}

const AUTOMATION_OUTCOMES: readonly AutomationRunOutcome[] = ["completed", "cancelled", "failed", "interrupted"];

/** An explicitly valid `outcome` wins; otherwise a `_cancelled` event means cancelled and anything
 *  else terminal is reported as completed. */
function terminalOutcome(p: Record<string, unknown>, eventName: string): AutomationRunOutcome {
  const raw = p.outcome;
  if (typeof raw === "string" && (AUTOMATION_OUTCOMES as readonly string[]).includes(raw)) {
    return raw as AutomationRunOutcome;
  }
  return eventName === "automation_run_cancelled" ? "cancelled" : "completed";
}

/** The history row a terminal event synthesizes, so an open list updates without a refetch. */
function synthesizedTerminalRun(
  p: Record<string, unknown>,
  kind: AutomationRunKind,
  runId: string,
  eventName: string,
): AutomationRun {
  const durationMs = numOr(p.durationMs, 0);
  const endedAt = Date.now();
  return {
    id: runId,
    kind,
    trigger: p.trigger === "manual" ? "manual" : "timer",
    startedAt: endedAt - durationMs,
    endedAt,
    outcome: terminalOutcome(p, eventName),
    reposTotal: numOr(p.total, 0),
    reposDone: numOr(p.done, 0),
    reposBlocked: numOr(p.blocked, 0),
    error: strOr(p.error, null),
  };
}

/** REPLACE, don't blindly prepend: a list loaded while this very round was in flight already
 *  holds a row for it, and keeping its daemon-recorded start time over the one back-computed
 *  from `durationMs` is the whole point of settling in place rather than adding a second row. */
function settleRunRow(current: AutomationRun[], synthesized: AutomationRun): AutomationRun[] {
  const existing = current.findIndex((run) => run.id === synthesized.id);
  if (existing < 0) return [synthesized, ...current];
  const next = current.slice();
  next[existing] = { ...synthesized, startedAt: current[existing]!.startedAt };
  return next;
}

const isProgressEvent = (name: string): boolean => name === "automation_run_progress";
const isTerminalEvent = (name: string): boolean =>
  name === "automation_run_done" || name === "automation_run_cancelled";

/**
 * Automation run history + live round state (src/http/routes/automation.ts, src/automation-run.ts).
 *
 * The auto-commit incident ledger (store/incidents.ts) is a list of open PROBLEMS. This is a
 * different question: "what did the unattended loops actually do", including the rounds where the
 * answer was "nothing, in four seconds". Loaded on demand when Settings → Automation opens, same
 * as incidents; kept current afterward by the automation_run_* SSE broadcasts.
 *
 * Both scheduled loops (auto-commit, sync-check) share one SSE event family and are told apart
 * only by `kind`, and the two loops can run concurrently — so every piece of live state here is
 * keyed BY KIND, never a single global.
 */
export function useAutomationRuns() {
  const runs = ref<AutomationRun[]>([]);
  const runsReady = ref(false);
  const runsLoading = ref(false);

  function defaultActiveRounds(): { auto_commit: AutomationRoundState; sync_check: AutomationRoundState } {
    return {
      auto_commit: { running: false, cancelling: false },
      sync_check: { running: false, cancelling: false },
    };
  }
  const activeRounds = ref(defaultActiveRounds());

  const liveRuns = ref<Record<AutomationRunKind, LiveAutomationRun | null>>({
    auto_commit: null,
    sync_check: null,
  });

  async function loadAutomationRuns(): Promise<void> {
    if (runsLoading.value) return;
    runsLoading.value = true;
    try {
      const r = await api.automation.runs({ limit: 100 });
      runs.value = r.runs;
      activeRounds.value = { auto_commit: r.active.autoCommit, sync_check: r.active.syncCheck };
      // Adopt any round that is already in flight. Without this, a panel opened mid-round shows
      // "running" and then silently drops every progress event that follows, because the straggler
      // guard below has no live run to match them against. A run row with a null outcome is the
      // only thing that says "still going" - endedAt is null for an interrupted run too.
      for (const kind of ["auto_commit", "sync_check"] as const) {
        const inFlight = r.runs.find((run) => run.kind === kind && run.outcome === null);
        liveRuns.value[kind] = inFlight
          ? {
              runId: inFlight.id,
              done: inFlight.reposDone,
              blocked: inFlight.reposBlocked,
              total: inFlight.reposTotal,
              current: null,
            }
          : null;
      }
    } catch {
      runs.value = [];
      activeRounds.value = defaultActiveRounds();
    } finally {
      runsReady.value = true;
      runsLoading.value = false;
    }
  }

  /** One run's full detail, or null when it's past the row cap - genuinely gone, not a fault to
   *  surface (see AutomationRun.endedAt's note on how little a missing row implies). */
  async function loadAutomationRunDetail(
    id: string,
  ): Promise<{ run: AutomationRun; repos: AutomationRunRepo[] } | null> {
    try {
      return await api.automation.run(id);
    } catch (e) {
      if (e instanceof ApiError) return null;
      throw e;
    }
  }

  /**
   * Ask the in-flight round of one loop to stop starting new repositories (the repo being worked
   * on right now still finishes - see src/round-controller.ts). Optimistic, same shape as
   * cancelFetchAll/cancelScan: flips `cancelling` on immediately so the Stop control reacts on the
   * first frame, rolled back and rethrown if the request itself never reached the daemon.
   */
  async function cancelAutomationRound(kind: AutomationRunKind): Promise<void> {
    activeRounds.value[kind] = { ...activeRounds.value[kind], cancelling: true };
    try {
      await api.automation.cancel(kind);
    } catch (e) {
      activeRounds.value[kind] = { ...activeRounds.value[kind], cancelling: false };
      throw e;
    }
  }

  /**
   * Apply one `automation_run_*` broadcast (src/automation-run.ts).
   *
   * Never trusts a payload field - each is narrowed with typeof before use, same style as the
   * scan and ai_key_invalid handlers in store/index.ts.
   *
   * Rules (deliberately spelled out, since a hand-rolled version of this gets them wrong):
   *   - A `_progress` or terminal event whose `runId` doesn't match the live run CURRENTLY held for
   *     that kind is a straggler from a previous round (only possible right after a reconnect) and
   *     is ignored - except `_started`, which always adopts: it DEFINES the new live run.
   *   - A terminal event (`_done`/`_cancelled`) clears that kind's live run and its optimistic
   *     `cancelling` flag, and prepends a synthesized `AutomationRun` to `runs` so an open history
   *     list updates without a refetch - but only when `runsReady` is true; a list nobody has
   *     loaded stays empty rather than silently gaining one row out of a history it never fetched.
   *   - `automation_run_started` sets that kind's live run and `activeRounds[kind].running = true`;
   *     a terminal event sets it back to false.
   */
  function applyAutomationRunEvent(eventName: string, payload: unknown): void {
    const ev = asRunEvent(payload);
    if (!ev) return;
    const { kind, runId, fields } = ev;

    if (eventName === "automation_run_started") {
      liveRuns.value[kind] = startedLiveRun(fields, runId);
      activeRounds.value[kind] = { ...activeRounds.value[kind], running: true };
      return;
    }

    const live = liveRuns.value[kind];
    if (!live || live.runId !== runId) return; // straggler from a run this kind is no longer watching

    if (isProgressEvent(eventName)) {
      liveRuns.value[kind] = progressedLiveRun(fields, live);
      return;
    }
    if (!isTerminalEvent(eventName)) return;

    // Terminal: clear the live run and any optimistic "cancelling" flag for this kind.
    liveRuns.value[kind] = null;
    activeRounds.value[kind] = { running: false, cancelling: false };

    if (!runsReady.value) return; // nobody has loaded the history list — nothing to prepend into
    runs.value = settleRunRow(runs.value, synthesizedTerminalRun(fields, kind, runId, eventName));
  }

  return {
    runs,
    runsReady,
    runsLoading,
    activeRounds,
    liveRuns,
    loadAutomationRuns,
    loadAutomationRunDetail,
    cancelAutomationRound,
    applyAutomationRunEvent,
  };
}
