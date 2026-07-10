/**
 * The VCS-agnostic backend contract — the core of the RepoYeti pivot.
 *
 * Until now every repo operation assumed git. RepoYeti makes the daemon manage *any* VCS
 * (git today, Epic's Lore next) behind ONE interface, so service.ts / the watcher / the
 * routes never branch on "which VCS" — they resolve a backend and call it. Each backend
 * normalises its VCS into the SAME result shapes the dashboard already consumes
 * (RepoStatus, ChangedFile, ActionResult, BranchList, LogResult, StashList), so the UI is
 * unchanged regardless of which VCS owns a repo.
 *
 * The signatures deliberately mirror the existing git functions (absPath + per-op Identity),
 * so the git backend (vcs/git.ts) is a thin pass-through and wiring this into service.ts
 * later stays mechanical rather than a rewrite.
 */
import type { Identity, RepoStatus } from "../db.ts";
import type { ChangedFile } from "../read/status.ts";
import type { ActionResult, CommitGroupSpec, CommitGroupsResult } from "../contract.ts";
import type { BranchList, LogResult, StashList, CommitDetail, MergeFilter, RefScope } from "../read/inspect.ts";

export type VcsKind = "git" | "lore";

/**
 * What a backend supports beyond the common core, so the UI/service can hide controls a VCS
 * doesn't have. The common core — status, changed files, branches (list/create/switch),
 * history, pull, push, commit — is assumed for EVERY backend. These flags cover the parts
 * that genuinely differ (e.g. Lore is centralized: no separate fetch step, one server, no
 * stash stack).
 */
export interface VcsCapabilities {
  /** Has a stash stack (git: true). Lore has no stash concept → false. */
  stash: boolean;
  /** Has a distinct "fetch" step separate from pull (git: true). Lore syncs in one step → false. */
  fetch: boolean;
  /** Supports multiple named remotes (git: true). Lore is centralized (one server) → false. */
  multipleRemotes: boolean;
  /** Can reconstruct BOTH whole sides of a file for a rich side-by-side "models" diff (git:
   *  true). When false (Lore), the file viewer falls back to unified-patch mode only. */
  fileModels: boolean;
}

/** A single file's unified patch (working tree vs the current revision/HEAD) — the file
 *  viewer's "patch" mode. `ok` is false when the backend couldn't produce it. */
export interface FilePatchResult {
  ok: boolean;
  patch: string;
  truncated: boolean;
  message?: string;
}

/**
 * One version-control backend. Implementations: vcs/git.ts (delegates to the existing,
 * battle-tested git plumbing) and vcs/lore.ts (drives the `lore` CLI). Resolve one via
 * vcs/index.ts → backendFor(kind) / detectVcs(absPath).
 */
export interface VcsBackend {
  readonly kind: VcsKind;
  /** Directory entry that marks a working copy of this VCS (".git" / ".lore"). */
  readonly marker: string;
  readonly capabilities: VcsCapabilities;

  /** True when `absPath` is a working copy of this VCS (its marker is present). */
  detect(absPath: string): boolean;

  // ── status / changed files ──
  readStatus(absPath: string, withDiff?: boolean): Promise<RepoStatus>;
  readChanges(absPath: string, withStats?: boolean): Promise<ChangedFile[]>;

  // ── safe remote/commit actions (identity injected per-op) ──
  fetch(absPath: string, identity: Identity | null): Promise<ActionResult>;
  pull(absPath: string, identity: Identity | null): Promise<ActionResult>;
  push(absPath: string, identity: Identity | null): Promise<ActionResult>;
  commitAll(
    absPath: string,
    identity: Identity | null,
    message: string,
    amend?: boolean,
  ): Promise<ActionResult>;

  // ── branches ──
  listBranches(absPath: string): Promise<BranchList>;
  checkout(absPath: string, branch: string): Promise<ActionResult>;
  createBranch(absPath: string, name: string, switchTo?: boolean): Promise<ActionResult>;
  deleteBranch(absPath: string, name: string): Promise<ActionResult>;

  // ── history ──
  readLog(absPath: string, limit?: number, skip?: number, merges?: MergeFilter, refScope?: RefScope): Promise<LogResult>;
  /** Full detail for one commit: changed-file list + a bounded unified diff. */
  readCommit(absPath: string, hash: string): Promise<CommitDetail>;

  // ── stash (capabilities.stash === false → mutations return a clear error) ──
  readStashes(absPath: string): Promise<StashList>;
  stashSave(absPath: string, identity: Identity | null, message?: string): Promise<ActionResult>;
  stashPop(absPath: string, index?: number): Promise<ActionResult>;
  stashDrop(absPath: string, index?: number): Promise<ActionResult>;

  // ── file diff / discard (file viewer "patch" mode + the changes-tree "Discard") ──
  /** Unified working-tree-vs-current-revision patch for ONE file. */
  filePatch(absPath: string, relPath: string): Promise<FilePatchResult>;
  /** Discard ONE file's working-tree changes — restore it to its committed/absent state.
   *  DESTRUCTIVE (the UI gates it behind an explicit confirm); never touches HEAD. */
  discardFile(absPath: string, relPath: string): Promise<ActionResult>;

  // ── AI commit-diff · smart-commit grouping · content search ──
  /** A compact, bounded working-tree diff snapshot for an AI commit-message/plan prompt.
   *  `paths` scopes it to a subset (smart-commit per-group regenerate); omitted = whole tree. */
  collectAiDiff(absPath: string, paths?: string[]): Promise<string>;
  /** Execute a multi-commit plan: stage each group's files in isolation and commit it, in order. */
  commitGroups(absPath: string, identity: Identity | null, groups: CommitGroupSpec[]): Promise<CommitGroupsResult>;
  /** Of `paths` (the changed-file set), the ones whose working-tree content contains `needle`
   *  (literal, case-insensitive). Read-only. */
  searchContent(absPath: string, needle: string, paths: string[]): Promise<string[]>;
}
