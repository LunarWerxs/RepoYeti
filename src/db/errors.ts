/**
 * The grouped operational-error history (1.0 audit, item 27).
 *
 * One row per (repository, operation, error code), with an occurrence count, so a fetch that has
 * failed five times against a rotated key reads differently from one that failed once on a flaky
 * connection. Lifted out of db.ts whole; it owns one table and reaches nothing else.
 *
 * The one thing that reaches IN is repository removal: forgetRepo and deleteRepos delete this
 * table's rows inside their own transaction, because a removed repository must not leave its
 * failure history behind. That deletion deliberately stays whole in db.ts rather than becoming a
 * cross-module call that could half apply.
 */
import { createHash } from "node:crypto";
import { getDb } from "./connection.ts";

// ── Grouped operational-error history ───────────────────────────────────────────────────
//
// Adapted from PostHog's issue-fingerprint grouping (products/error_tracking/, MIT): cluster
// recurring failures by a stable signature instead of a flat log or a one-shot toast. See the
// `operational_errors` CREATE TABLE above for why this exists.

export interface OperationalErrorView {
  fingerprint: string;
  repoId: string;
  repoName: string;
  op: string;
  code: string;
  message: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  muted: boolean;
}

interface OperationalErrorRow {
  fingerprint: string;
  repo_id: string;
  repo_name: string;
  op: string;
  code: string;
  message: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  muted: number;
}

function toOperationalErrorView(r: OperationalErrorRow): OperationalErrorView {
  return {
    fingerprint: r.fingerprint,
    repoId: r.repo_id,
    repoName: r.repo_name,
    op: r.op,
    code: r.code,
    message: r.message,
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    muted: r.muted === 1,
  };
}

/**
 * Stable id for one (repo, operation, code) group - same short-hash idiom as `idFor` in
 * identity-detect.ts (sha1, hex, 16 chars): plenty of collision resistance for a local per-machine
 * log, and a clean opaque path segment for the mute/dismiss routes, unlike the raw
 * "repoId:op:code" string, which would need URL-encoding and could still collide with a route
 * pattern if an op or code ever contained a slash.
 */
export function operationalErrorFingerprint(repoId: string, op: string, code: string): string {
  return createHash("sha1").update([repoId, op, code].join("\0")).digest("hex").slice(0, 16);
}

/**
 * Record one failed mutating action, grouped by (repo, op, code), see
 * `operationalErrorFingerprint`. The first occurrence inserts a row; every later one bumps
 * `occurrences` and refreshes `message`/`last_seen_at` (the newest failure's message is usually
 * the more useful one, e.g. a changed SSH host-key fingerprint) without disturbing
 * `first_seen_at` or a manually-set `muted` flag. Called from service/core.ts's `runAction`, the
 * single funnel every mutating VCS action goes through, so every call site is covered without
 * each action remembering to log its own failure.
 */
export function recordOperationalError(input: {
  repoId: string;
  repoName: string;
  op: string;
  code: string;
  message: string;
}): void {
  const fingerprint = operationalErrorFingerprint(input.repoId, input.op, input.code);
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO operational_errors
         (fingerprint, repo_id, repo_name, op, code, message, occurrences, first_seen_at, last_seen_at, muted)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT(fingerprint) DO UPDATE SET
         repo_name = excluded.repo_name,
         message = excluded.message,
         occurrences = operational_errors.occurrences + 1,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(fingerprint, input.repoId, input.repoName, input.op, input.code, input.message, now, now);
}

/** Every grouped operational error, most-recently-seen first - the "this repo's fetch has failed
 *  N times" list next to the live health/status route. */
export function listOperationalErrors(): OperationalErrorView[] {
  const rows = getDb()
    .query(`SELECT * FROM operational_errors ORDER BY last_seen_at DESC`)
    .all() as OperationalErrorRow[];
  return rows.map(toOperationalErrorView);
}

/** Toggle a group's mute flag (silence it from an "unread" badge without deleting its history).
 *  Returns false if the fingerprint is unknown, so the route can answer 404 instead of a false ok. */
export function setOperationalErrorMuted(fingerprint: string, muted: boolean): boolean {
  const result = getDb()
    .query(`UPDATE operational_errors SET muted = ? WHERE fingerprint = ?`)
    .run(muted ? 1 : 0, fingerprint);
  return result.changes > 0;
}

/** Dismiss one group outright. The next matching failure starts a fresh row/count: dismissing is
 *  "I've dealt with this", not "stop telling me forever" (mute is that). Returns false if the
 *  fingerprint was already gone/unknown. */
export function dismissOperationalError(fingerprint: string): boolean {
  const result = getDb().query(`DELETE FROM operational_errors WHERE fingerprint = ?`).run(fingerprint);
  return result.changes > 0;
}
