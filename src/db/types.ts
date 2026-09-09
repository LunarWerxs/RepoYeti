/**
 * The repository row, the view the rest of the app consumes, and the identity shapes (1.0 audit,
 * item 27).
 *
 * These live here rather than in db.ts because they are the one thing several domains genuinely
 * share: the shares module projects a share's scope into RepoView, the repos module builds them,
 * and both need the same row-to-view mapping. Putting the shapes in the facade instead would make
 * every domain import the facade back, which is the cycle the split exists to avoid.
 *
 * Types plus the row mapper. No queries live here, so this module never touches the connection.
 */
import type { DiffStat } from "../read/diffstat.ts";
import type { VcsKind } from "../vcs/types.ts";

export type RepoSource = "auto" | "pinned" | "created";

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
  /**
   * Full object id currently resolved by HEAD. Unlike branch/ahead/behind counters, this changes
   * when another Git client commits + pushes, amends, or resets between watcher refreshes. Null
   * for an unborn/error state; optional so persisted pre-field and non-Git statuses still parse.
   */
  headOid?: string | null;
  /** Full object id of the configured upstream tip; null/absent when nothing is tracked. */
  upstreamOid?: string | null;
  /**
   * Deterministic identity of every ref included by History's Local/All scopes
   * (`refs/heads`, `refs/remotes`, and `refs/tags`). This catches external ref creation,
   * deletion, and force-moves even when HEAD/upstream/counters stay unchanged.
   */
  historyRefsHash?: string | null;
  /**
   * Opaque hash of changed paths and their index/worktree status letters. This deliberately
   * excludes contents: pull checkout safety changes when the affected path/state set changes.
   */
  worktreeStateHash?: string | null;
  dirty: number;
  ahead: number;
  /** From last fetch only — never auto-fetched on a watch event. */
  behind: number;
  remote: string | null;
  error: string | null;
  /** When `behind` was last refreshed by an explicit fetch (null until then). */
  fetchedAt: number | null;
  /**
   * Aggregate working-tree-vs-HEAD line/char delta. Null when the diff-stats setting is
   * off (the default) or the tree is clean — computing it is gated behind that setting.
   * Optional so a status literal can omit it; readStatus always sets it (null or a value).
   */
  diff?: DiffStat | null;
  /** Has any unmerged/conflicted path (git status "U"/"AA"/"DD"). Git-only for now — optional
   *  so the Lore backend's status literals (vcs/lore.ts) can omit it (defaults falsy in the UI).
   *  Drives the Conflict Concierge triage card (state-driven, not event-driven). */
  conflicted?: boolean;
  /** Which mid-git-operation marker is present ("MERGE_HEAD" | "rebase-merge" | "rebase-apply" |
   *  "CHERRY_PICK_HEAD" | "REVERT_HEAD"), or null when the repo isn't mid-operation. See
   *  src/git.ts currentGitOperation (shared with the auto-commit safety gate). Optional/git-only
   *  like `conflicted`. */
  gitOperation?: string | null;
  updatedAt: number;
}

export interface RepoRow {
  id: string;
  abs_path: string;
  name: string;
  /** Owner-chosen label (Rename), or NULL to use `name`. Never the folder on disk. */
  display_name: string | null;
  source: RepoSource;
  vcs: string;
  identity_id: string | null;
  sync_account_host: string | null;
  sync_account_login: string | null;
  is_submodule: number;
  hidden: number;
  /** User "favorite" flags — organisation only. Distinct from source='pinned'. */
  pinned: number;
  starred: number;
  /** Owner opted this repo into the auto-commit timer (see src/auto-commit.ts). */
  auto_commit: number;
  /** Drag-persisted position; NULL for a repo the owner has never reordered. */
  sort_order: number | null;
  last_status: string | null;
  updated_at: number;
}

/** The shape the API/UI consumes. */
export interface RepoView {
  id: string;
  /** The folder's basename on disk. Always the real thing — a rename never changes it. */
  name: string;
  /** Owner-chosen label, or null when none is set. The UI shows `displayName ?? name`. */
  displayName: string | null;
  absPath: string;
  source: RepoSource;
  /** Which VCS backs this repo ("git" | "lore"). Drives backend dispatch in service.ts. */
  vcs: VcsKind;
  isSubmodule: boolean;
  /** Repo-level identity override (null → inherit/none). */
  identityId: string | null;
  /** Repo-level GitHub "sync account" (host + login) to authenticate as for fetch/pull/push.
   *  Null → resolve automatically from git config, remote ownership, or GitHub permissions. */
  syncAccountHost: string | null;
  syncAccountLogin: string | null;
  /** Owner-hidden from the dashboard (e.g. a deprecated repo). Display-only. */
  hidden: boolean;
  /** Favorited into the "Pinned" section. Organisation flag — NOT source='pinned'. */
  pinned: boolean;
  /** Favorited into the "Starred" section. Organisation flag, independent of pinned. */
  starred: boolean;
  /** Opted into the auto-commit timer (per-repo; the timer only touches repos with this on). */
  autoCommit: boolean;
  /** Drag-persisted list position, or null for a repo never manually reordered. Exposed so the
   *  dashboard can slot a live-discovered repo into the same place getRepos() would, instead of
   *  appending it to the bottom of whatever it already had. */
  sortOrder: number | null;
  status: RepoStatus | null;
  updatedAt: number;
}

/** A git identity. SSH key is stored as a *path* (never read by the daemon).
 * PAT / signing handles exist in the schema but are wired in Phase 5. */
export interface Identity {
  id: string;
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export interface IdentityInput {  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath?: string | null;
}

/**
 * Parse a cached status blob, or give up on that ONE row (1.0 audit, item 15).
 *
 * `last_status` is a cache of what git last reported, written by this daemon and read back by it.
 * A row that no longer parses is therefore a damaged cache entry, not lost data: the next status
 * refresh rewrites it. Before this guard, `toView` parsed it bare, so a single truncated row
 * (a disk that filled mid-write, a killed process) threw out of getRepos and took the ENTIRE
 * repository list with it - a dashboard that shows nothing at all, over one repository's stale
 * cache. Now that repository shows as "not yet scanned" and everything else still lists.
 *
 * Silent by design at this level: getRepos runs on nearly every request, and a console line per
 * row per request would bury the daemon's log. `verifyDatabase()` counts these on demand and
 * `repairStatusCache()` clears them, which is where an owner looks on purpose.
 */
export function parseCachedStatus(raw: string | null): RepoStatus | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoStatus;
  } catch {
    return null;
  }
}

export function toView(r: RepoRow): RepoView {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name ?? null,
    absPath: r.abs_path,
    source: r.source,
    vcs: (r.vcs as VcsKind) || "git",
    isSubmodule: r.is_submodule === 1,
    identityId: r.identity_id,
    syncAccountHost: r.sync_account_host,
    syncAccountLogin: r.sync_account_login,
    hidden: r.hidden === 1,
    pinned: r.pinned === 1,
    starred: r.starred === 1,
    autoCommit: r.auto_commit === 1,
    sortOrder: r.sort_order ?? null,
    status: parseCachedStatus(r.last_status),
    updatedAt: r.updated_at,
  };
}
