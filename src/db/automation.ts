/**
 * Automation persistence: the auto-commit incident ledger and the durable run history
 * (1.0 audit, items 23 and 27).
 *
 * Two tables that look alike and answer different questions, which is exactly why they are one
 * module rather than two rows in one table:
 *
 *   auto_commit_incidents answers "what is WRONG right now" - one row per open (repo, reason)
 *   problem, upserted while it persists, acknowledged by the owner and then closed.
 *
 *   automation_runs answers "what HAPPENED while I was away" - one row per round of a scheduled
 *   loop, with a child row per repository it actually did something to.
 *
 * Self-contained: nothing here reaches into another domain's tables. Schema creation still lives
 * in db.ts's initDb, which owns the boot sequence.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "./connection.ts";

// ── auto-commit incidents ────────────────────────────────────────────────────────
//
// Adapted from Hermes Agent cron/incidents.py (MIT, Copyright Nous Research) for RepoYeti - the
// incident-tracking DATA SHAPE only (one row per failed/skipped scheduled run, reviewable and
// acknowledgeable), reimplemented against this repo's own SQLite/db.ts conventions, not ported
// line-for-line.

/**
 * One repo the auto-commit timer could not fully handle on a round: a hard skip (`CONFLICT`,
 * `AI_UNAVAILABLE`, `ERROR`, …) or a sync note on an otherwise-successful round (e.g.
 * `NON_FAST_FORWARD`). See the table comment in initDb() for why this is persisted rather than
 * left to the SSE broadcast alone.
 */
export interface AutoCommitIncident {
  id: string;
  repoId: string;
  /** Repo name as of the most recent occurrence - a later rename/removal must not blank a
   *  historic row (repoId is deliberately not a FK, same reasoning as ShareEvent above). */
  repoName: string;
  /** Ms of the most recent occurrence. A repeat of the same (repoId, reason) while still unacked
   *  bumps this forward on the SAME row instead of minting a new one - see
   *  recordAutoCommitIncident - so this is "last seen", not "first seen". */
  at: number;
  /** Mirrors AutoCommitBlockedRepo.reason / AutoCommittedRepo.note (auto-commit.ts). */
  reason: string;
  /** Ms the owner acknowledged it, or null while still unreviewed. */
  ackedAt: number | null;
}

interface AutoCommitIncidentRow {
  id: string;
  repo_id: string;
  repo_name: string;
  at: number;
  reason: string;
  acked_at: number | null;
}

/** Housekeeping bound, mirrors SHARE_EVENT_CAP - a stuck timer retrying every minute forever must
 *  not grow the DB forever. One shared cap across all repos (there is one timer, not one
 *  row-owner per repo the way a share link owns its own audit trail). */
const AUTO_COMMIT_INCIDENT_CAP = 500;

function rowToAutoCommitIncident(r: AutoCommitIncidentRow): AutoCommitIncident {
  return {
    id: r.id,
    repoId: r.repo_id,
    repoName: r.repo_name,
    at: r.at,
    reason: r.reason,
    ackedAt: r.acked_at,
  };
}

/**
 * Record one incident and prune back to the cap. Called from auto-commit.ts's tick() for every
 * blocked repo and every done repo that still carries a sync `note`. Deliberately never throws:
 * a storage hiccup here must not stop the timer from finishing its round; it reports instead
 * (mirrors migrateAddColumn's non-fatal-but-loud posture above).
 *
 * Upserts on (repoId, reason) while unacked: a repo stuck in the same failure mode (e.g. an
 * unresolved CONFLICT, exactly the case this feature exists to surface) would otherwise mint a
 * fresh row every tick forever, and the 500-row cap is shared across ALL repos, so one repo
 * stuck long enough would evict every OTHER repo's un-acknowledged incidents out from under them.
 * Bumping the existing row's `at` instead keeps one row per open problem regardless of how many
 * ticks it has survived, so the cap is spent on distinct problems, not repeat ticks of the same
 * one. Once a row is acked, the next occurrence of the same (repoId, reason) is a fresh insert -
 * a problem recurring after the owner dismissed it is new news, not a bump of old news.
 */
export function recordAutoCommitIncident(input: { repoId: string; repoName: string; reason: string }): void {
  try {
    const db2 = getDb();
    const existing = db2
      .query(`SELECT id FROM auto_commit_incidents WHERE repo_id = ? AND reason = ? AND acked_at IS NULL`)
      .get(input.repoId, input.reason) as { id: string } | null;
    if (existing) {
      db2
        .query(`UPDATE auto_commit_incidents SET at = ?, repo_name = ? WHERE id = ?`)
        .run(Date.now(), input.repoName, existing.id);
      return; // same row bumped, so the cap below only needs to run when a row is newly added.
    }
    db2
      .query(
        `INSERT INTO auto_commit_incidents (id, repo_id, repo_name, at, reason, acked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(randomUUID(), input.repoId, input.repoName, Date.now(), input.reason);
    db2
      .query(
        // Same OFFSET cap-1 shape as logShareEvent's prune, pruned by rowid (not `at`, which is
        // millisecond-resolution and ties within one round) so "newest" stays unambiguous.
        `DELETE FROM auto_commit_incidents
         WHERE rowid < (SELECT rowid FROM auto_commit_incidents ORDER BY rowid DESC LIMIT 1 OFFSET ?)`,
      )
      .run(AUTO_COMMIT_INCIDENT_CAP - 1);
  } catch (e) {
    console.error("[repoyeti] failed to record auto-commit incident:", e);
  }
}

/** Most recent incidents first (rowid tiebreak, same reasoning as listShareEvents).
 *  `unackedOnly` narrows to rows the owner hasn't reviewed yet: what the dashboard's default
 *  "needs attention" view reads from. */
export function listAutoCommitIncidents(
  opts: { limit?: number; unackedOnly?: boolean } = {},
): AutoCommitIncident[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, AUTO_COMMIT_INCIDENT_CAP));
  const where = opts.unackedOnly ? "WHERE acked_at IS NULL" : "";
  return (
    getDb()
      .query(
        `SELECT id, repo_id, repo_name, at, reason, acked_at FROM auto_commit_incidents
         ${where} ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as AutoCommitIncidentRow[]
  ).map(rowToAutoCommitIncident);
}

/** How many incidents the owner hasn't acknowledged yet: the dashboard badge count. */
export function countUnackedAutoCommitIncidents(): number {
  const r = getDb()
    .query(`SELECT count(*) AS n FROM auto_commit_incidents WHERE acked_at IS NULL`)
    .get() as { n: number };
  return r.n;
}

/** Mark one incident reviewed. Returns false when `id` doesn't exist (the route treats that as a
 *  404). Acking an already-acked row is a no-op success rather than a fresh timestamp, so a
 *  double-click (or two dashboard tabs) can't shuffle the review time. */
export function ackAutoCommitIncident(id: string): boolean {
  const existing = getDb().query(`SELECT acked_at FROM auto_commit_incidents WHERE id = ?`).get(id) as
    | { acked_at: number | null }
    | null;
  if (!existing) return false;
  if (existing.acked_at == null) {
    getDb().query(`UPDATE auto_commit_incidents SET acked_at = ? WHERE id = ?`).run(Date.now(), id);
  }
  return true;
}

// ── automation run history (1.0 audit, item 23) ───────────────────────────────────────────────
//
// See the table definitions in initDb for why this is a separate model from auto_commit_incidents
// rather than more rows in it.

/** Which scheduled loop a run belongs to. */
export type AutomationRunKind = "auto_commit" | "sync_check";

/** Why a run started. `manual` covers the dashboard's "run now" and the CLI verbs. */
export type AutomationRunTrigger = "timer" | "manual";

/**
 * How a run ended.
 *   completed   - the round walked its whole list.
 *   cancelled   - the owner stopped it; repos after the one in flight were never started.
 *   failed      - the round body threw. `error` carries the message.
 *   interrupted - the daemon went away mid-round. Written at the NEXT boot, never by the run.
 */
export type AutomationRunOutcome = "completed" | "cancelled" | "failed" | "interrupted";

/** What one loop did to one repository in one round. */
export type AutomationRepoOutcome = "committed" | "synced" | "blocked" | "error";

export interface AutomationRunRepo {
  id: string;
  runId: string;
  repoId: string;
  /** Name as of the run - a later rename must not blank the history (as with incidents above). */
  repoName: string;
  at: number;
  durationMs: number;
  outcome: AutomationRepoOutcome;
  /** Per-outcome facts (commits, pulled, pushed, note, reason). Parsed defensively: a row written
   *  by a future build in a shape this one cannot read must not fail the whole list. */
  detail: Record<string, unknown> | null;
}

export interface AutomationRun {
  id: string;
  kind: AutomationRunKind;
  trigger: AutomationRunTrigger;
  startedAt: number;
  /** Null while in flight, and permanently null for an `interrupted` run - see the table note. */
  endedAt: number | null;
  /** Null while in flight. */
  outcome: AutomationRunOutcome | null;
  reposTotal: number;
  reposDone: number;
  reposBlocked: number;
  error: string | null;
}

interface AutomationRunRow {
  id: string;
  kind: string;
  trigger: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  repos_total: number;
  repos_done: number;
  repos_blocked: number;
  error: string | null;
}

interface AutomationRunRepoRow {
  id: string;
  run_id: string;
  repo_id: string;
  repo_name: string;
  at: number;
  duration_ms: number;
  outcome: string;
  detail: string | null;
}

/**
 * Housekeeping bound. Sized from the cadence rather than copied from the incidents cap: the two
 * loops fire on their own schedules (auto-commit every 15 minutes by default, the sync check
 * every 5), so 300 runs is on the order of a day of both together. History further back than
 * that is not what this feature is for - the question it answers is "what happened while I was
 * asleep", and the incidents table is what carries an unresolved problem forward indefinitely.
 */
const AUTOMATION_RUN_CAP = 300;

function rowToAutomationRun(r: AutomationRunRow): AutomationRun {
  return {
    id: r.id,
    kind: r.kind === "sync_check" ? "sync_check" : "auto_commit",
    trigger: r.trigger === "manual" ? "manual" : "timer",
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: (r.outcome as AutomationRunOutcome | null) ?? null,
    reposTotal: r.repos_total,
    reposDone: r.repos_done,
    reposBlocked: r.repos_blocked,
    error: r.error,
  };
}

function rowToAutomationRunRepo(r: AutomationRunRepoRow): AutomationRunRepo {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      const parsed: unknown = JSON.parse(r.detail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      // A row this build cannot read is still a row that happened: keep the outcome and the
      // timing and drop only the detail. Failing the whole list over one bad JSON blob is the
      // exact shape of defect item 15 is about.
      detail = null;
    }
  }
  return {
    id: r.id,
    runId: r.run_id,
    repoId: r.repo_id,
    repoName: r.repo_name,
    at: r.at,
    durationMs: r.duration_ms,
    outcome: r.outcome as AutomationRepoOutcome,
    detail,
  };
}

/**
 * Open a run row and return its id, or null when the row could not be written.
 *
 * Never throws, and the null return is load-bearing: history is a reporting feature, and a
 * storage hiccup must not stop the timer from actually committing the owner's work. Callers
 * treat a null id as "run without history this round" and carry on. Same non-fatal-but-loud
 * posture as recordAutoCommitIncident and migrateAddColumn.
 */
export function beginAutomationRun(input: {
  id: string;
  kind: AutomationRunKind;
  trigger: AutomationRunTrigger;
  reposTotal: number;
}): string | null {
  try {
    getDb()
      .query(
        `INSERT INTO automation_runs (id, kind, trigger, started_at, ended_at, outcome,
           repos_total, repos_done, repos_blocked, error)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, 0, NULL)`,
      )
      .run(input.id, input.kind, input.trigger, Date.now(), input.reposTotal);
    return input.id;
  } catch (e) {
    console.error("[repoyeti] failed to open automation run row:", e);
    return null;
  }
}

/** Record what one loop did to one repository. No-op when `runId` is null (see beginAutomationRun). */
export function recordAutomationRunRepo(
  runId: string | null,
  input: {
    repoId: string;
    repoName: string;
    durationMs: number;
    outcome: AutomationRepoOutcome;
    detail?: Record<string, unknown>;
  },
): void {
  if (!runId) return;
  try {
    getDb()
      .query(
        `INSERT INTO automation_run_repos (id, run_id, repo_id, repo_name, at, duration_ms, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        runId,
        input.repoId,
        input.repoName,
        Date.now(),
        Math.max(0, Math.round(input.durationMs)),
        input.outcome,
        input.detail ? JSON.stringify(input.detail) : null,
      );
  } catch (e) {
    console.error("[repoyeti] failed to record automation run repo:", e);
  }
}

/**
 * Close a run row and prune back to the cap.
 *
 * The prune deletes the child rows of every run it evicts, in the same call. There is
 * deliberately no foreign key on run_id (a partially written run must still be readable), so
 * SQLite will not cascade for us and orphans would otherwise accumulate invisibly under a table
 * nothing lists.
 */
export function finishAutomationRun(
  runId: string | null,
  input: {
    outcome: AutomationRunOutcome;
    reposTotal?: number;
    reposDone: number;
    reposBlocked: number;
    error?: string | null;
  },
): void {
  if (!runId) return;
  try {
    const db2 = getDb();
    const setTotal = input.reposTotal === undefined ? "" : ", repos_total = ?";
    const totalParam = input.reposTotal === undefined ? [] : [input.reposTotal];
    db2
      .query(
        `UPDATE automation_runs
            SET ended_at = ?, outcome = ?, repos_done = ?, repos_blocked = ?, error = ?${setTotal}
          WHERE id = ?`,
      )
      .run(Date.now(), input.outcome, input.reposDone, input.reposBlocked, input.error ?? null, ...totalParam, runId);
    // Same OFFSET cap-1 shape as the incidents prune, by rowid rather than started_at (which ties
    // at millisecond resolution when both loops happen to fire together).
    db2
      .query(
        `DELETE FROM automation_runs
          WHERE rowid < (SELECT rowid FROM automation_runs ORDER BY rowid DESC LIMIT 1 OFFSET ?)`,
      )
      .run(AUTOMATION_RUN_CAP - 1);
    db2.query(`DELETE FROM automation_run_repos WHERE run_id NOT IN (SELECT id FROM automation_runs)`).run();
  } catch (e) {
    console.error("[repoyeti] failed to close automation run row:", e);
  }
}

/**
 * Mark every still-open run as interrupted, returning how many were closed.
 *
 * Called once from initDb, before anything can read the table: at that moment this process has
 * started no rounds (the loops are armed from lifecycle.ts, long after the database is opened),
 * so an open row can only belong to a previous process.
 *
 * `ended_at` is deliberately left NULL. We do not know when the run stopped, only that it never
 * reported doing so, and stamping "now" would claim a round that died last Tuesday ended at boot.
 */
export function markInterruptedAutomationRuns(handle?: Database): number {
  try {
    const db2 = handle ?? getDb();
    const open = db2.query(`SELECT count(*) AS n FROM automation_runs WHERE outcome IS NULL`).get() as {
      n: number;
    };
    if (open.n === 0) return 0;
    db2.query(`UPDATE automation_runs SET outcome = 'interrupted' WHERE outcome IS NULL`).run();
    return open.n;
  } catch (e) {
    console.error("[repoyeti] failed to close interrupted automation runs:", e);
    return 0;
  }
}

/** Most recent runs first, optionally narrowed to one loop. */
export function listAutomationRuns(opts: { limit?: number; kind?: AutomationRunKind } = {}): AutomationRun[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, AUTOMATION_RUN_CAP));
  const sql =
    `SELECT id, kind, trigger, started_at, ended_at, outcome, repos_total, repos_done, ` +
    `repos_blocked, error FROM automation_runs ${opts.kind ? "WHERE kind = ?" : ""} ` +
    `ORDER BY started_at DESC, rowid DESC LIMIT ?`;
  const rows = (
    opts.kind ? getDb().query(sql).all(opts.kind, limit) : getDb().query(sql).all(limit)
  ) as AutomationRunRow[];
  return rows.map(rowToAutomationRun);
}

/** One run, or null when the cap has already evicted it. */
export function getAutomationRun(id: string): AutomationRun | null {
  const r = getDb()
    .query(
      `SELECT id, kind, trigger, started_at, ended_at, outcome, repos_total, repos_done,
              repos_blocked, error FROM automation_runs WHERE id = ?`,
    )
    .get(id) as AutomationRunRow | null;
  return r ? rowToAutomationRun(r) : null;
}

/** The per-repository detail of one run, oldest first: the order the round processed them. */
export function listAutomationRunRepos(runId: string): AutomationRunRepo[] {
  return (
    getDb()
      .query(
        `SELECT id, run_id, repo_id, repo_name, at, duration_ms, outcome, detail
           FROM automation_run_repos WHERE run_id = ? ORDER BY at ASC, rowid ASC`,
      )
      .all(runId) as AutomationRunRepoRow[]
  ).map(rowToAutomationRunRepo);
}
