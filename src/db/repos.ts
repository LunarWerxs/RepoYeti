/**
 * The repository cache: everything that WRITES it, plus the removal tombstones and the immutable
 * per-commit statistics cache (1.0 audit, item 27).
 *
 * Reads live next door in repos-read.ts, which is a leaf so the shares domain can depend on it
 * without importing this file back. This half is the write half, and it is where the schema's two
 * genuinely cross-domain deletions live.
 *
 * `forgetRepo` and `deleteRepos` delete from tables three other domains own: a removed repository
 * must not leave behind its share grants, its cached commit statistics or its failure history, and
 * that has to happen in ONE transaction or a removal can half apply and leave a dangling grant
 * pointing at nothing. They stay whole here, reaching those tables directly, rather than becoming
 * a chain of cross-module calls that each commit separately. That is the honest trade: file
 * tidiness is worth less than a removal that cannot half apply.
 *
 * `upsertRepo`'s two refusals (a path under the OS temp directory, and a path the owner
 * tombstoned) are the choke point the rest of the app relies on; see the function's own comment.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./connection.ts";
import { isUnderTempDir } from "../paths.ts";
import type { RepoSource, RepoStatus, RepoView } from "./types.ts";
import type { VcsKind } from "../vcs/types.ts";
import type { CommitStat } from "../read/inspect.ts";
import { getRepo } from "./repos-read.ts";

export interface GitCommitStatCacheEntry {
  hash: string;
  date: number;
  stat: CommitStat;
}

/** Read immutable shortstats previously measured for this repo and commit-date window. */
export function getGitCommitStats(
  repoId: string,
  since: number,
  until: number,
  statVersion: number,
): Map<string, CommitStat> {
  const rows = getDb()
    .query(
      `SELECT commit_hash, files_changed, added_lines, removed_lines
       FROM git_commit_stats
       WHERE repo_id = ? AND stat_version = ? AND committed_at >= ? AND committed_at <= ?`,
    )
    .all(repoId, statVersion, Math.floor(since), Math.floor(until)) as Array<{
    commit_hash: string;
    files_changed: number;
    added_lines: number;
    removed_lines: number;
  }>;
  const stats = new Map<string, CommitStat>();
  for (const row of rows) {
    if (
      !row.commit_hash ||
      !Number.isSafeInteger(row.files_changed) ||
      row.files_changed < 0 ||
      !Number.isSafeInteger(row.added_lines) ||
      row.added_lines < 0 ||
      !Number.isSafeInteger(row.removed_lines) ||
      row.removed_lines < 0
    ) {
      continue;
    }
    stats.set(row.commit_hash, {
      filesChanged: row.files_changed,
      addedLines: row.added_lines,
      removedLines: row.removed_lines,
    });
  }
  return stats;
}

/** Transactionally persist a batch of successful measurements; explicit all-zero stats count. */
export function putGitCommitStats(
  repoId: string,
  entries: readonly GitCommitStatCacheEntry[],
  statVersion: number,
): void {
  if (entries.length === 0) return;
  const handle = getDb();
  const repoExists = handle.query(`SELECT 1 FROM repos WHERE id = ? LIMIT 1`);
  const statement = handle.query(
    `INSERT INTO git_commit_stats
       (repo_id, commit_hash, committed_at, files_changed, added_lines, removed_lines, stat_version, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
       committed_at = excluded.committed_at,
       files_changed = excluded.files_changed,
       added_lines = excluded.added_lines,
       removed_lines = excluded.removed_lines,
       stat_version = excluded.stat_version,
       cached_at = excluded.cached_at`,
  );
  const cachedAt = Date.now();
  const write = handle.transaction((rows: readonly GitCommitStatCacheEntry[]) => {
    // An activity read can finish after the repo was removed. Check inside the same transaction
    // as the upserts so that race cannot resurrect permanent orphan cache rows.
    if (!repoExists.get(repoId)) return;
    for (const entry of rows) {
      statement.run(
        repoId,
        entry.hash,
        Math.floor(entry.date),
        Math.max(0, Math.floor(entry.stat.filesChanged)),
        Math.max(0, Math.floor(entry.stat.addedLines)),
        Math.max(0, Math.floor(entry.stat.removedLines)),
        statVersion,
        cachedAt,
      );
    }
  });
  write(entries);
}

/**
 * Insert (or refresh name/submodule of) a repo by absolute path. Returns its id, or null if
 * `absPath` is under the OS temp directory (see `isUnderTempDir`): a repo living there is NEVER
 * imported, by owner directive, no matter which caller reaches this choke point (auto-discovery,
 * a manual "Point to Folder" pin, or a clone/create destination). This is the single write
 * choke point every import path shares, so this one check is the hard, unbypassable backstop;
 * src/discovery.ts's SKIP_DIRS pruning of "temp"/"tmp" during the walk is scan-time efficiency
 * only, not a guarantee (a pin or clone destination never goes through that walk at all).
 *
 * Deliberately non-throwing (a throw here would abort a scan loop mid-walk); callers check for
 * null instead. See src/service/repo-mgmt.ts (registerRepo/cloneRepo/cloneLoreRepo/createRepo
 * surface it as a RepoMutation) and the auto/boot/scan callers (which just skip the entry).
 */
export function upsertRepo(
  absPath: string,
  name: string,
  source: RepoSource,
  isSubmodule: boolean,
  vcs: VcsKind = "git",
): string | null {
  if (isUnderTempDir(absPath)) return null;
  // The owner removed this path — a rescan must not resurrect it. Checked here, at the same
  // choke point as the temp guard, so EVERY import route (scan, boot discovery, add-root,
  // "Point to Folder", clone) inherits it rather than each remembering to ask.
  if (isPathIgnored(absPath)) return null;
  const row = getDb()
    .query(
      `INSERT INTO repos (id, abs_path, name, source, vcs, is_submodule, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(abs_path) DO UPDATE SET
         name = excluded.name,
          source = CASE
            WHEN repos.source = 'created' OR excluded.source = 'created' THEN 'created'
            WHEN repos.source = 'pinned' OR excluded.source = 'pinned' THEN 'pinned'
            ELSE excluded.source
          END,
          vcs = excluded.vcs,
          is_submodule = excluded.is_submodule,
          updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(randomUUID(), absPath, name, source, vcs, isSubmodule ? 1 : 0, Date.now()) as
    | { id: string }
    | null;
  return row!.id;
}

export function setRepoStatus(id: string, status: RepoStatus): void {
  getDb()
    .query(`UPDATE repos SET last_status = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(status), status.updatedAt, id);
}

/**
 * Persist a full drag-to-reorder: assign each id its position as sort_order.
 * Clears every repo's sort_order first so any repo NOT in the list (e.g. one
 * discovered mid-drag) falls back to the name/submodule tiebreaker instead of
 * floating to a stale position.
 */
export function setRepoOrder(orderedIds: string[]): void {
  const d = getDb();
  const clear = d.query(`UPDATE repos SET sort_order = NULL`);
  const upd = d.query(`UPDATE repos SET sort_order = ? WHERE id = ?`);
  const tx = d.transaction((ids: string[]) => {
    clear.run();
    ids.forEach((id, i) => {
      upd.run(i, id);
    });
  });
  tx(orderedIds);
}

// ── Removal + rename ────────────────────────────────────────────────────────────────────
//
// "Remove" here means remove from RepoYeti's index. It NEVER touches the folder or a single byte
// of git history: RepoYeti's whole promise is "uninstall it and your repos are untouched", so a
// button that could delete real work would break that contract outright. The row goes; the code
// stays exactly where it is.

/** True when `absPath` sits on the owner's removed list (see the `ignored_paths` table). */
export function isPathIgnored(absPath: string): boolean {
  return (
    getDb().query(`SELECT 1 FROM ignored_paths WHERE abs_path = ?`).get(absPath) !== null
  );
}

/** Every path the owner has removed, newest first — the Settings → Removed repos list. */
export function listIgnoredPaths(): Array<{ absPath: string; name: string; ignoredAt: number }> {
  const rows = getDb()
    .query(`SELECT abs_path, name, ignored_at FROM ignored_paths ORDER BY ignored_at DESC`)
    .all() as Array<{ abs_path: string; name: string; ignored_at: number }>;
  return rows.map((r) => ({ absPath: r.abs_path, name: r.name, ignoredAt: r.ignored_at }));
}

/** Drop a path from the removed list, so the next scan may import it again. Idempotent. */
export function unignorePath(absPath: string): void {
  getDb().query(`DELETE FROM ignored_paths WHERE abs_path = ?`).run(absPath);
}

/**
 * Remove one repo from the index. `ignore: true` (the default for an owner-initiated removal)
 * also tombstones the path so a rescan can't bring it straight back; `ignore: false` is the
 * "just forget the row" variant used when a repo's folder is already gone.
 *
 * Returns the removed repo's view, or null if the id was unknown.
 */
export function forgetRepo(id: string, ignore = true): RepoView | null {
  const repo = getRepo(id);
  if (!repo) return null;
  const d = getDb();
  const tx = d.transaction(() => {
    if (ignore) {
      d.query(
        `INSERT INTO ignored_paths (abs_path, name, ignored_at) VALUES (?, ?, ?)
         ON CONFLICT(abs_path) DO UPDATE SET name = excluded.name, ignored_at = excluded.ignored_at`,
      ).run(repo.absPath, repo.name, Date.now());
    }
    d.query(`DELETE FROM share_repos WHERE repo_id = ?`).run(id);
    d.query(`DELETE FROM shares WHERE id NOT IN (SELECT share_id FROM share_repos)`).run();
    d.query(`DELETE FROM git_commit_stats WHERE repo_id = ?`).run(id);
    // Unlike share_events (an audit trail that must outlive the share it logged), an
    // operational-error group has no meaning once its repo is gone - there is nothing left to
    // mute/dismiss/retry against, so it is cleaned up here rather than kept.
    d.query(`DELETE FROM operational_errors WHERE repo_id = ?`).run(id);
    d.query(`DELETE FROM repos WHERE id = ?`).run(id);
  });
  tx();
  return repo;
}

/**
 * Set (or clear, with null) a repo's display label. Purely cosmetic — the folder is never
 * renamed. An empty/whitespace-only label clears back to the folder name rather than showing a
 * blank card.
 */
export function setRepoDisplayName(id: string, displayName: string | null): void {
  const label = displayName?.trim() ? displayName.trim() : null;
  getDb()
    .query(`UPDATE repos SET display_name = ?, updated_at = ? WHERE id = ?`)
    .run(label, Date.now(), id);
}

/** Delete repos by id (used when a scan root is removed). Path/owner logic lives in the
 *  caller (service.ts) so this stays a dumb, transactional delete. */
export function deleteRepos(ids: string[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const stmt = d.query(`DELETE FROM repos WHERE id = ?`);
  const clearStats = d.query(`DELETE FROM git_commit_stats WHERE repo_id = ?`);
  const clearErrors = d.query(`DELETE FROM operational_errors WHERE repo_id = ?`);
  const tx = d.transaction((xs: string[]) => {
    for (const id of xs) {
      clearStats.run(id);
      clearErrors.run(id);
      stmt.run(id);
    }
  });
  tx(ids);
}
