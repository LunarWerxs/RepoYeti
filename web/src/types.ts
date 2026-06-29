// Mirrors the daemon's API shapes (src/db.ts / src/git-actions.ts).

/** Added/removed line + character delta vs HEAD (mirrors src/diffstat.ts). */
export interface DiffStat {
  addedLines: number;
  removedLines: number;
  addedChars: number;
  removedChars: number;
}

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  remote: string | null;
  error: string | null;
  fetchedAt: number | null;
  /** Aggregate line/char delta — present only when the diff-stats setting is on. */
  diff?: DiffStat | null;
  updatedAt: number;
}

export type RepoSource = "auto" | "pinned" | "created";

/** Which VCS backs a repo. Mirrors src/vcs/types.ts VcsKind. */
export type VcsKind = "git" | "lore";

/**
 * What a backend supports — mirrors src/vcs/types.ts VcsCapabilities so the UI can hide
 * controls a VCS doesn't have. Looked up by kind via VCS_CAPABILITIES below.
 */
export interface VcsCapabilities {
  /** Has a stash stack (git). Lore has none. */
  stash: boolean;
  /** Has a distinct fetch step separate from pull (git). Lore syncs in one step. */
  fetch: boolean;
  /** Has multiple named remotes + tag management (git). Lore is centralized (one server). */
  multipleRemotes: boolean;
}

export const VCS_CAPABILITIES: Record<VcsKind, VcsCapabilities> = {
  git: { stash: true, fetch: true, multipleRemotes: true },
  lore: { stash: false, fetch: false, multipleRemotes: false },
};

export interface Repo {
  id: string;
  name: string;
  absPath: string;
  source: RepoSource;
  /** Which VCS backs this repo — drives which controls the card shows. */
  vcs: VcsKind;
  isSubmodule: boolean;
  identityId: string | null;
  /** Owner-hidden from the dashboard (e.g. a deprecated repo). Display-only. */
  hidden: boolean;
  /** Favorited into the "Pinned" section. Organisation flag — NOT `source: "pinned"`. */
  pinned: boolean;
  /** Favorited into the "Starred" section. Independent of `pinned`. */
  starred: boolean;
  status: RepoStatus | null;
  updatedAt: number;
}

export interface Identity {
  id: string;
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export interface ChangedFile {
  path: string;
  /** M · A · D · R · U · C */
  status: string;
  staged: boolean;
  /** Per-file line/char delta — present only when the diff-stats setting is on. */
  stat?: DiffStat;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  status?: string;
  staged?: boolean;
  /** File nodes only: per-file line/char delta (when the diff-stats setting is on). */
  stat?: DiffStat;
  children?: TreeNode[];
}

/** One file's contents for the read-only source-control viewer (mirrors src/service.ts). */
export interface FileContent {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  path: string;
  content: string;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
  ref?: "work" | "head";
}

/** Both sides of a changed file for the viewer's Diff tab (mirrors src/service.ts). */
export interface FileDiff {
  ok: boolean;
  code: "OK" | "NOT_FOUND" | "ERROR";
  message?: string;
  path: string;
  /** "models" (default) = original+modified pair → rich side-by-side diff · "patch" = a
   *  unified `git diff` string, sent for large modified files (only the hunks travel). */
  mode?: "models" | "patch";
  /** Last-committed (HEAD) text — "" for a newly-added file. ("models" mode.) */
  original: string;
  /** Working-tree text — "" for a deleted file. ("models" mode.) */
  modified: string;
  /** Unified git-diff text — present only when `mode` is "patch". */
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
}

export type ActionName = "fetch" | "pull" | "push" | "refresh" | "commit";

// ── branches / history / stash (mirror src/inspect.ts) ──────────────────────────
export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface BranchList {
  ok: boolean;
  code: ApiCode;
  message?: string;
  current: string | null;
  detached: boolean;
  branches: BranchInfo[];
  total?: number;
  truncated?: boolean;
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Author date as epoch milliseconds. */
  date: number;
  /** Ref decorations, e.g. "HEAD -> main, origin/main". */
  refs: string;
}

export interface LogResult {
  ok: boolean;
  code: ApiCode;
  message?: string;
  commits: LogEntry[];
  hasMore: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  /** Created date as epoch milliseconds. */
  date: number;
}

export interface StashList {
  ok: boolean;
  code: ApiCode;
  message?: string;
  stashes: StashEntry[];
}

export interface TagEntry {
  name: string;
  /** Creation date as epoch milliseconds. */
  date: number;
  subject: string;
}

export interface TagList {
  ok: boolean;
  code: ApiCode;
  message?: string;
  tags: TagEntry[];
}

/** Summary of a bulk "fetch all" (mirrors src/service.ts FetchAllResult). */
export interface FetchAllResult {
  total: number;
  ok: number;
  failed: Array<{ id: string; name: string; code: string }>;
}

/**
 * Every error code the daemon can return. Keep in sync with `ApiErrorCode` in
 * src/contract.ts (the daemon's single source of truth + HTTP-status map). Typing this
 * as a union — rather than the old `string` — lets the UI switch on codes exhaustively
 * and catches drift when the backend adds one. `(string & {})` keeps it forward-tolerant:
 * an unknown future code still parses, it just won't narrow.
 */
export type ApiErrorCode =
  | "DIRTY_WORKING_TREE"
  | "NON_FAST_FORWARD"
  | "DETACHED_HEAD"
  | "NO_UPSTREAM"
  | "NO_REMOTE"
  | "NOTHING_TO_COMMIT"
  | "SSH_AUTH_FAILED"
  | "SSH_PASSPHRASE_REQUIRED"
  | "NOT_FOUND"
  | "NOT_A_REPO"
  | "EXISTS"
  | "SUBMODULE_NOT_ACTIONABLE"
  | "INVALID_REF_NAME"
  | "BRANCH_EXISTS"
  | "UNMERGED_BRANCH"
  | "CANNOT_DELETE_CURRENT"
  | "PROTECTED_BRANCH"
  | "NOTHING_TO_STASH"
  | "STASH_CONFLICT"
  | "STASH_EMPTY"
  | "DISCARD_FAILED"
  | "EMPTY_PLAN"
  | "PLAN_PATHS_INVALID"
  | "PLAN_STALE"
  | "BAD_REQUEST"
  | "VALIDATION"
  | "NO_MESSAGE"
  | "BAD_MODE"
  | "NEEDS_OWNER"
  | "AI_AUTH_FAILED"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
  | "AI_ERROR"
  | "BAD_PROVIDER"
  | "NO_KEY"
  | "NO_AI_PROVIDER"
  | "NO_MODEL"
  | "NOT_CONFIGURED"
  | "ERROR";

export type ApiCode = "OK" | ApiErrorCode | (string & {});

export interface ActionResult {
  ok: boolean;
  code: ApiCode;
  message: string;
  repoId?: string;
}

// ── bring-your-own-key AI (mirrors src/config.ts redactAi + src/ai.ts) ──────────
// NOTE: AiProviderId must stay in sync with src/config.ts. Type-only duplication is
// acceptable here; the backend is the single source of truth for runtime values.
export type AiProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "groq"
  | "openrouter";

/**
 * Safe display metadata for one AI provider — mirrors src/config.ts AiCatalogEntry.
 * Served by GET /api/ai/catalog; the Settings UI consumes this instead of a hardcoded list.
 */
export interface AiCatalogEntry {
  id: AiProviderId;
  label: string;
  url: string;
  keyPlaceholder: string;
  free?: boolean;
}
export type CommitStyle = "conventional" | "concise" | "detailed";

export interface AiModel {
  id: string;
  label: string;
}

/** Redacted per-provider state from the daemon — NEVER carries the key. */
export interface AiProviderState {
  configured: true;
  model: string | null;
  /** True when served by RepoYeti's free built-in key (owner has set no key of their own). */
  builtin?: boolean;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, AiProviderState>>;
  defaultProvider: AiProviderId | null;
  style: CommitStyle;
  /** Smart-commit YOLO mode: commit the AI plan immediately, skipping the review editor. */
  yolo: boolean;
}

// ── smart commit (AI multi-commit splitter) — mirrors src/ai.ts + src/service.ts ──

/** One proposed commit in a plan. */
export interface CommitGroup {
  type: string;
  scope?: string;
  subject: string;
  body?: string;
  files: string[];
  rationale?: string;
}

/** A full proposed plan (read-only suggestion; the owner edits it before executing). */
export interface CommitPlan {
  groups: CommitGroup[];
  /** Files the planner couldn't place — the UI blocks commit until each is in a group. */
  leftovers: string[];
  /** True when this came from the deterministic fallback (no/failed AI). */
  degraded: boolean;
  /** True when the diff shown to the AI was capped (large change-set). */
  truncated: boolean;
}

export interface CommitPlanResponse {
  ok: boolean;
  plan: CommitPlan;
  provider: AiProviderId;
  model: string;
  /** True when the daemon used the deterministic fallback after an AI failure. */
  fallback?: boolean;
}

/** Per-group outcome of executing a plan, in order. */
export interface CommitGroupResult {
  ok: boolean;
  code: ApiCode;
  subject: string;
  message?: string;
}

export interface SmartCommitResult {
  ok: boolean;
  code: ApiCode;
  message: string;
  repoId: string;
  committed?: CommitGroupResult[];
  remaining?: number;
  synced?: boolean;
  syncCode?: ApiCode;
  syncMessage?: string;
}
