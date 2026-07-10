/**
 * Shared repo-precondition guard. Every mutating/diff path first checks the same two
 * conditions: the repo must exist, and (for actionable paths) must not be a submodule
 * worktree. This collapses the ~6 duplicated "if (!repo) … / if (repo.isSubmodule) …"
 * blocks into one helper while letting each call site keep its own return shape.
 *
 * On success it returns `{ repo }`. On failure it returns a `fail` object carrying the
 * `code`/`message` (and `repoId` when the call site's return type includes it) — the
 * caller spreads that into its own typed result. The codes are type parameters so the
 * spread stays assignable to each call site's narrow union; the submodule failure code
 * differs by call site (some use SUBMODULE_NOT_ACTIONABLE, some plain ERROR) and is a
 * runtime argument as well.
 */
import { getRepo } from "../db.ts";
import type { RepoView } from "../db.ts";

interface GuardFail<C extends string> {
  ok: false;
  code: C;
  message: string;
}

/**
 * Guard a repo for an actionable/diff path.
 *
 * @param repoId         the repo to look up.
 * @param submoduleCode  code to return when the repo is a submodule worktree.
 * @param extra          fields merged into every failure (e.g. `{ repoId }` for
 *                       ActionOutcome-shaped returns). Defaults to `{}`.
 */
export function guardRepo<C extends string, E extends object = Record<never, never>>(
  repoId: string,
  submoduleCode: C,
  extra: E = {} as E,
): { repo: RepoView; fail?: undefined } | { repo?: undefined; fail: GuardFail<C | "NOT_FOUND"> & E } {
  const repo = getRepo(repoId);
  if (!repo) {
    return { fail: { ok: false, code: "NOT_FOUND", message: "repo not found", ...extra } };
  }
  if (repo.isSubmodule) {
    return { fail: { ok: false, code: submoduleCode, message: "submodule worktree is not actionable", ...extra } };
  }
  return { repo };
}
