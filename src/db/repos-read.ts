/**
 * Reading the repository cache (1.0 audit, item 27).
 *
 * A deliberately tiny leaf module. It exists because the shares domain has to answer "which of the
 * owner's repositories does this token see", and a share scoped to everything answers that with
 * the same list the dashboard shows. Keeping these three reads here lets shares.ts depend on a
 * leaf instead of importing the facade back and forming a cycle.
 *
 * Writing to the repos table still lives in db.ts, together with the cross-domain transactions
 * (forgetRepo spans five tables) that are the reason the rest of that domain has not moved yet.
 */
import { getDb } from "./connection.ts";
import { toView, type RepoRow, type RepoView } from "./types.ts";

export function getRepos(): RepoView[] {
  // Manual drag order (sort_order) wins; repos never reordered yet (NULL) fall back
  // to the old grouping — real repos before submodule worktrees, then name.
  const rows = getDb()
    .query(
      `SELECT * FROM repos
       ORDER BY (sort_order IS NULL) ASC, sort_order ASC, is_submodule ASC, name COLLATE NOCASE ASC`,
    )
    .all() as RepoRow[];
  return rows.map(toView);
}
export function getRepo(id: string): RepoView | null {
  const r = getDb().query(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | null;
  return r ? toView(r) : null;
}
/** Repos eligible for filesystem watching (real repos, not submodule worktrees). */
export function getWatchableRepos(): RepoView[] {
  return getRepos().filter((r) => !r.isSubmodule);
}
