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
  /** Has any unmerged/conflicted path. Git-only for now (optional; falsy for Lore repos). */
  conflicted?: boolean;
  /** Which mid-git-operation marker is present ("MERGE_HEAD" | "rebase-merge" | "rebase-apply" |
   *  "CHERRY_PICK_HEAD" | "REVERT_HEAD"), or null/absent when not mid-operation. */
  gitOperation?: string | null;
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
  /** Repo-level GitHub "sync account" (host + login) to authenticate as for fetch/pull/push.
   *  Null → use the machine's currently-active account. */
  syncAccountHost: string | null;
  syncAccountLogin: string | null;
  /** Owner-hidden from the dashboard (e.g. a deprecated repo). Display-only. */
  hidden: boolean;
  /** Favorited into the "Pinned" section. Organisation flag — NOT `source: "pinned"`. */
  pinned: boolean;
  /** Favorited into the "Starred" section. Independent of `pinned`. */
  starred: boolean;
  /** Opted into the auto-commit timer (per-repo; see the daemon's src/auto-commit.ts). */
  autoCommit: boolean;
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

/** ⭐ Identity Firewall rule: repos whose absolute path matches `pathPattern` (a glob — see
 *  src/identity.ts globMatch) MUST resolve to `requiredIdentityId`. Mirrors src/config.ts
 *  IdentityRule. */
export interface IdentityRule {
  pathPattern: string;
  requiredIdentityId: string;
}

export type DetectedIdentitySource =
  | "git-global"
  | "git-local"
  | "git-credential"
  | "github-cli"
  | "windows-credential"
  | "ssh-key"
  | "ssh-agent";
export type DetectedIdentityConfidence = "high" | "medium" | "low";

export interface DetectedIdentitySuggestion {
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export interface DetectedIdentity {
  id: string;
  source: DetectedIdentitySource;
  title: string;
  detail: string;
  confidence: DetectedIdentityConfidence;
  suggestion: DetectedIdentitySuggestion;
  missing: Array<keyof DetectedIdentitySuggestion>;
}

/** One authenticated GitHub (gh) account on the machine (mirrors src/gh-cli.ts GhAccount). */
export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  /** "https" | "ssh" | "" */
  gitProtocol: string;
  scopes: string[];
  /** Saved identity linked to this account — applied as the git author on switch, or null. */
  identityId: string | null;
}

/**
 * The machine's gh account state + the global git author in effect (mirrors src/gh-cli.ts).
 * `commitIdentity` is display-only — switching the active account changes authentication, not who
 * commits are attributed to.
 */
export interface AccountsSnapshot {
  ghAvailable: boolean;
  accounts: GhAccount[];
  commitIdentity: { name: string; email: string };
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
  /** Parent commit hashes (full); a root has none, a merge has 2+. */
  parents: string[];
  /** True when this commit has 2+ parents (a merge). */
  isMerge: boolean;
}

export interface LogResult {
  ok: boolean;
  code: ApiCode;
  message?: string;
  commits: LogEntry[];
  hasMore: boolean;
}

/** One changed file in a commit. */
export interface CommitFile {
  status: string; // A / M / D / R / C
  path: string;
  from?: string;
}

/** Full detail for one commit (the History tap-to-expand view). Mirrors src/inspect.ts. */
export interface CommitDetail {
  ok: boolean;
  code: ApiCode;
  message?: string;
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: number;
  /** Parent commit hashes (full); 2+ ⇒ this is a merge. */
  parents: string[];
  /** True when this commit has 2+ parents (a merge). */
  isMerge: boolean;
  committerName: string;
  committerEmail: string;
  /** Committer date as epoch milliseconds. */
  committerDate: number;
  /** Commit message body (everything after the subject line); "" when none. */
  body: string;
  files: CommitFile[];
  diff: string;
  truncated: boolean;
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
  | "WOULD_OVERWRITE"
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
  | "TEMP_PATH_REFUSED"
  | "IDENTITY_POLICY_VIOLATION"
  | "INVALID_REF_NAME"
  | "BRANCH_EXISTS"
  | "UNMERGED_BRANCH"
  | "CANNOT_DELETE_CURRENT"
  | "PROTECTED_BRANCH"
  | "NOTHING_TO_STASH"
  | "STASH_CONFLICT"
  | "STASH_EMPTY"
  | "DISCARD_FAILED"
  | "STAGE_FAILED"
  | "EMPTY_PLAN"
  | "PLAN_PATHS_INVALID"
  | "PLAN_STALE"
  | "BAD_REQUEST"
  | "VALIDATION"
  | "NO_MESSAGE"
  | "BAD_MODE"
  | "NEEDS_OWNER"
  // Share links: the credential is valid, it just doesn't reach this far (src/share/policy.ts).
  | "FORBIDDEN"
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
  /** The one provider we steer new owners to (Groq) — renders a "Suggested" badge + get-a-key nudge. */
  suggested?: boolean;
  /** Preferred chat model id, marked "Recommended" in the model picker + used as the connect-time
   *  default. Best-effort: absent from a provider's live list ⇒ no marker, no default. */
  recommended?: string;
}
export type CommitStyle = "conventional" | "concise" | "detailed";

/** How much of EACH changed file the smart-commit planner reads (mirrors src/config.ts). A cost
 *  dial: the planner always gets the complete file list, so this only trades how much of a large
 *  file's body feeds its message against tokens spent per commit. */
export type DiffDetail = "lean" | "balanced" | "thorough";

/** A registered Lore server RepoYeti can clone repos from (mirrors src/config.ts LoreServer). */
export interface LoreServer {
  id: string;
  name: string;
  url: string;
}

export interface AiModel {
  id: string;
  label: string;
}

/** Redacted per-provider state from the daemon — NEVER carries the key. */
export interface AiProviderState {
  configured: true;
  model: string | null;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, AiProviderState>>;
  defaultProvider: AiProviderId | null;
  style: CommitStyle;
  /** How much of each changed file the smart-commit planner reads — the token-cost dial. */
  diffDetail: DiffDetail;
  /** Smart-commit YOLO mode: commit the AI plan immediately, skipping the review editor. */
  yolo: boolean;
  /** Whether the AI commit buttons (Generate + Auto) are shown at all (default true). */
  commitEnabled: boolean;
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
/** Mirrors the daemon's AiCode (src/ai/commit-message.ts). */
export type AiCode =
  | "OK"
  | "AI_AUTH_FAILED"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
  | "AI_RATE_LIMITED"
  | "AI_ERROR";

export interface CommitPlan {
  groups: CommitGroup[];
  /** Files the planner couldn't place — the UI blocks commit until each is in a group. */
  leftovers: string[];
  /** True when this came from the deterministic fallback (no/failed AI). */
  degraded: boolean;
  /** True when the diff shown to the AI was capped (large change-set). */
  truncated: boolean;
  /** Why it degraded, so the banner states the real cause (e.g. a spent rate limit) rather than
   *  always blaming the model. `degradedMessage` is the provider's own text. */
  degradedCode?: AiCode;
  degradedMessage?: string;
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

export interface UpdateStatus {
  ok: boolean;
  service: "repoyeti";
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

/** ⭐ Agent Safety Rail: one MCP mutating tool call awaiting owner approve/deny (mirrors
 *  src/approvals.ts PendingApproval). Carried by GET /api/approvals and the
 *  approval_pending/approval_resolved SSE events. */
export interface PendingApproval {
  id: string;
  tool: string;
  repo: string | null;
  argsSummary: string;
  requestedAt: number;
  /** When the soonest armed auto-resolution fires (0 = none armed → waits for a manual decision). */
  expiresAt: number;
  /** What the countdown will do at expiry — "deny", "approve", or null (no timer, hide the countdown). */
  autoAction: "approve" | "deny" | null;
}

// ── share links ───────────────────────────────────────────────────────────────
/** What a share link may do. "control" is a superset of "view" (mirrors src/share/policy.ts). */
export type SharePerm = "view" | "control";

/** The link lifetimes the owner can pick (mirrors src/share/index.ts SHARE_DURATIONS). */
export type ShareDuration = "hour" | "day" | "week" | "month" | "year" | "never";

/** One share link in the owner's Sharing panel (GET /api/shares).
 *  Note there is no token field, and never will be: only sha256(secret) is stored, so the link
 *  itself is shown exactly once — in the response to creating it — and is unrecoverable after. */
export interface Share {
  id: string;
  label: string;
  perm: SharePerm;
  /** Every repo, including ones discovered later. When true, `repoIds` is empty and meaningless. */
  scopeAll: boolean;
  repoIds: string[];
  createdAt: number;
  /** null = never expires. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  /** False once expired — the panel greys these out. */
  live: boolean;
}

/** POST /api/shares — the ONLY response that ever carries the secret link token. */
export interface ShareCreated {
  ok: boolean;
  share: Share;
  token: string;
}

/** One entry in a link's audit trail (GET /api/shares/:id/events). */
export interface ShareEvent {
  id: string;
  shareId: string;
  at: number;
  action: string;
  repoId: string | null;
  outcome: "allowed" | "denied";
}

/** Who the CURRENT viewer is, when they're a guest rather than the owner. Carried by
 *  /api/auth/status and /api/status; null for the owner. Drives the guest banner + control gating. */
export interface ShareViewer {
  label: string;
  perm: SharePerm;
  expiresAt: number | null;
}
