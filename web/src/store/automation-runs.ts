import { ref } from "vue";
import { api, ApiError } from "../api";
import type {
  AutomationRoundState,
  AutomationRun,
  AutomationRunKind,
  AutomationRunOutcome,
  AutomationRunRepo,
  AutomationRunTrigger,
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
    if (payload === null || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    const kind: AutomationRunKind | null = p.kind === "auto_commit" || p.kind === "sync_check" ? p.kind : null;
    if (!kind) return;
    const runId = typeof p.runId === "string" ? p.runId : null;
    if (!runId) return;

    if (eventName === "automation_run_started") {
      liveRuns.value[kind] = {
        runId,
        done: 0,
        blocked: 0,
        total: typeof p.total === "number" ? p.total : 0,
        current: null,
      };
      activeRounds.value[kind] = { ...activeRounds.value[kind], running: true };
      return;
    }

    const live = liveRuns.value[kind];
    if (!live || live.runId !== runId) return; // straggler from a run this kind is no longer watching

    if (eventName === "automation_run_progress") {
      liveRuns.value[kind] = {
        runId,
        done: typeof p.done === "number" ? p.done : live.done,
        blocked: typeof p.blocked === "number" ? p.blocked : live.blocked,
        total: typeof p.total === "number" ? p.total : live.total,
        current: typeof p.current === "string" ? p.current : live.current,
      };
      return;
    }

    if (eventName !== "automation_run_done" && eventName !== "automation_run_cancelled") return;

    // Terminal: clear the live run and any optimistic "cancelling" flag for this kind.
    liveRuns.value[kind] = null;
    activeRounds.value[kind] = { running: false, cancelling: false };

    if (!runsReady.value) return; // nobody has loaded the history list — nothing to prepend into
    const trigger: AutomationRunTrigger = p.trigger === "manual" ? "manual" : "timer";
    const validOutcomes: AutomationRunOutcome[] = ["completed", "cancelled", "failed", "interrupted"];
    const outcome: AutomationRunOutcome =
      typeof p.outcome === "string" && (validOutcomes as string[]).includes(p.outcome)
        ? (p.outcome as AutomationRunOutcome)
        : eventName === "automation_run_cancelled"
          ? "cancelled"
          : "completed";
    const durationMs = typeof p.durationMs === "number" ? p.durationMs : 0;
    const endedAt = Date.now();
    const synthesized: AutomationRun = {
      id: runId,
      kind,
      trigger,
      startedAt: endedAt - durationMs,
      endedAt,
      outcome,
      reposTotal: typeof p.total === "number" ? p.total : 0,
      reposDone: typeof p.done === "number" ? p.done : 0,
      reposBlocked: typeof p.blocked === "number" ? p.blocked : 0,
      error: typeof p.error === "string" ? p.error : null,
    };
    // REPLACE, don't blindly prepend. A list loaded while this very round was in flight already
    // holds its row with a null outcome, and prepending would show the same run twice, once
    // "running" forever.
    const existing = runs.value.findIndex((run) => run.id === runId);
    if (existing >= 0) {
      const next = runs.value.slice();
      // Keep the started time the daemon actually recorded over the one derived from durationMs.
      next[existing] = { ...synthesized, startedAt: runs.value[existing]!.startedAt };
      runs.value = next;
    } else {
      runs.value = [synthesized, ...runs.value];
    }
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
