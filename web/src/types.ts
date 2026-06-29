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

export interface Repo {
  id: string;
  name: string;
  absPath: string;
  source: RepoSource;
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
  /** True when served by GitMob's free built-in key (owner has set no key of their own). */
  builtin?: boolean;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, AiProviderState>>;
  defaultProvider: AiProviderId | null;
  style: CommitStyle;
}
