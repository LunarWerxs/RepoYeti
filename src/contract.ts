/**
 * The one place API error codes + their HTTP status mapping live.
 *
 * Before this module, three things drifted independently: the git-action codes in
 * git-actions.ts, the AI codes in ai.ts, and a handful of ad-hoc `{ error }` bodies +
 * inline status numbers scattered through daemon.ts. A missing repo could surface as a
 * 500 on one route and a 404 on another. Now every error response shares one envelope
 * (`{ ok: false, code, message }`) and one status map (`statusForCode`), and the web app
 * mirrors this union (web/src/types.ts) so the two can't silently diverge.
 *
 * `jsonError` is the single helper routes use; `statusForCode` gives the canonical status
 * for a code, and callers pass an explicit override only where context genuinely differs
 * (e.g. a "not configured" provider reads as 404 on a per-provider route but 400 on the
 * settings route).
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Every non-OK code the API can return, across git actions, repo/service ops, and AI. */
export type ApiErrorCode =
  // ── git action guards (mirror git-actions.ts) ──
  | "DIRTY_WORKING_TREE"
  | "WOULD_OVERWRITE"
  | "NON_FAST_FORWARD"
  | "DETACHED_HEAD"
  | "NO_UPSTREAM"
  | "NO_REMOTE"
  | "NOTHING_TO_COMMIT"
  | "GH_ACCOUNT_NOT_AUTHORIZED"
  | "SSH_AUTH_FAILED"
  | "SSH_PASSPHRASE_REQUIRED"
  | "NETWORK_TIMEOUT"
  // ── repo / service ──
  | "NOT_FOUND"
  | "NOT_A_REPO"
  | "EXISTS"
  | "SUBMODULE_NOT_ACTIONABLE"
  | "TEMP_PATH_REFUSED"
  // ── Identity Firewall (mirror src/identity.ts checkIdentityPolicy) ──
  | "IDENTITY_POLICY_VIOLATION"
  // ── branches / stash / discard (mirror inspect.ts + git-actions.ts) ──
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
  | "DELETE_FAILED"
  // ── smart commit (multi-commit splitter) ──
  | "EMPTY_PLAN"
  | "PLAN_PATHS_INVALID"
  | "PLAN_STALE"
  // ── AI conflict resolution (mirror src/service/conflicts.ts) ──
  /** The path isn't an unmerged, marker-bearing, resolvable text file. */
  | "NOT_CONFLICTED"
  /** The file changed after the resolution was generated — the proposal describes stale bytes. */
  | "CONFLICT_STALE"
  // ── daemon lifecycle (mirror src/auto-update.ts requestRelaunch) ──
  /** Work is in flight on the daemon right now, so it will not restart out from under it. */
  | "BUSY"
  // ── request / validation ──
  | "BAD_REQUEST"
  | "VALIDATION"
  | "NO_MESSAGE"
  | "BAD_MODE"
  | "NEEDS_OWNER"
  // ── share links (src/share/) — this credential exists, but doesn't reach this far ──
  | "FORBIDDEN"
  // ── AI (mirror ai.ts AiCode + the route guards) ──
  | "AI_AUTH_FAILED"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
  | "AI_RATE_LIMITED"
  | "AI_ERROR"
  | "BAD_PROVIDER"
  | "NO_KEY"
  | "NO_AI_PROVIDER"
  | "NO_MODEL"
  | "NOT_CONFIGURED"
  // ── catch-all ──
  | "ERROR";

/** A code plus the success sentinel — what `ActionResult.code` and friends carry. */
export type ApiCode = "OK" | ApiErrorCode;

/** A git-action result code — the shared API code union, so status mapping stays centralized. */
export type ActionCode = ApiCode;

/** The standard result envelope every git action + service op returns. Lives here (the contract
 *  layer) so the VCS abstraction can depend on it WITHOUT importing the git implementation. */
export interface ActionResult {
  ok: boolean;
  code: ActionCode;
  message: string;
}

/** Success/failure envelope builders — every git/VCS action returns one of these. Centralized
 *  here (not in git-actions.ts) so the VCS backends can build results WITHOUT importing the git
 *  implementation, and the two backends share one definition instead of copy-pasting it. */
export const ok = (message: string): ActionResult => ({ ok: true, code: "OK", message });
export const fail = (code: ActionCode, message: string): ActionResult => ({ ok: false, code, message });

/** ~1 MB of unified diff is plenty for the file viewer; bound the pathological "huge change in a
 *  huge file" case so neither backend ever buffers an unbounded patch. Shared by git + Lore. */
export const PATCH_CAP = 1_000_000;

// ── smart commit: split the working tree into several scoped commits ─────────────────
// These shapes live here (the contract layer) so they're part of the VcsBackend contract that
// both backends implement, without either backend's impl owning them.

/** One proposed commit to execute: a message + the exact paths to stage for it. Paths are
 *  already expanded by the caller to include a rename's old path (see service.smartCommitRepo). */
export interface CommitGroupSpec {
  message: string;
  paths: string[];
}

/** Per-group outcome, in plan order. */
export interface CommitGroupResult {
  ok: boolean;
  code: ActionCode;
  /** First line of the message (a label for the UI). */
  subject: string;
  message?: string;
}

export interface CommitGroupsResult {
  ok: boolean;
  code: ActionCode;
  message: string;
  /** Outcome of each group we attempted, in order. */
  committed: CommitGroupResult[];
  /** Groups never attempted because an earlier one failed (their changes stay in the tree). */
  remaining: number;
}

/** Canonical HTTP status for a code, grouped by the reason routes share that status. */
const STATUS_BY_CODE: Partial<Record<ApiCode, ContentfulStatusCode>> = {
  OK: 200,
  // 400 — the caller sent something we can't act on.
  BAD_REQUEST: 400,
  VALIDATION: 400,
  NO_MESSAGE: 400,
  BAD_MODE: 400,
  NOT_A_REPO: 400,
  AI_BAD_REQUEST: 400,
  NO_KEY: 400,
  NO_AI_PROVIDER: 400,
  NO_MODEL: 400,
  NOT_CONFIGURED: 400,
  INVALID_REF_NAME: 400,
  EMPTY_PLAN: 400,
  PLAN_PATHS_INVALID: 400,
  // 401 — a credential was supplied but rejected.
  AI_AUTH_FAILED: 401,
  // 429 — provider/share AI budget says to slow down.
  AI_RATE_LIMITED: 429,
  // 403 — the credential is valid, it just doesn't reach this far (a share link).
  FORBIDDEN: 403,
  // 404 — the named thing doesn't exist.
  NOT_FOUND: 404,
  BAD_PROVIDER: 404,
  // 409 — the repo/owner state conflicts with the request ("resolve at your desk").
  DIRTY_WORKING_TREE: 409,
  WOULD_OVERWRITE: 409,
  NON_FAST_FORWARD: 409,
  DETACHED_HEAD: 409,
  NO_UPSTREAM: 409,
  NO_REMOTE: 409,
  NOTHING_TO_COMMIT: 409,
  EXISTS: 409,
  SUBMODULE_NOT_ACTIONABLE: 409,
  TEMP_PATH_REFUSED: 409,
  NEEDS_OWNER: 409,
  BRANCH_EXISTS: 409,
  UNMERGED_BRANCH: 409,
  CANNOT_DELETE_CURRENT: 409,
  PROTECTED_BRANCH: 409,
  NOTHING_TO_STASH: 409,
  STASH_CONFLICT: 409,
  STASH_EMPTY: 409,
  PLAN_STALE: 409,
  NOT_CONFLICTED: 409,
  CONFLICT_STALE: 409,
  IDENTITY_POLICY_VIOLATION: 409,
  BUSY: 409,
  // 502 — an upstream (git remote / AI provider) failed.
  SSH_AUTH_FAILED: 502,
  GH_ACCOUNT_NOT_AUTHORIZED: 502,
  AI_ERROR: 502,
  // 504 — an upstream hung past our timeout.
  SSH_PASSPHRASE_REQUIRED: 504,
  NETWORK_TIMEOUT: 504,
  AI_UNREACHABLE: 504,
};

/** Canonical HTTP status for a code. Routes can still override per call site. */
export function statusForCode(code: ApiCode): ContentfulStatusCode {
  return STATUS_BY_CODE[code] ?? 500;
}

/** A short default message for a code, used when a route doesn't supply its own. */
const DEFAULT_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  NOT_FOUND: "not found",
  BAD_REQUEST: "bad request",
  VALIDATION: "invalid request",
  BAD_PROVIDER: "unknown provider",
  SUBMODULE_NOT_ACTIONABLE: "submodule worktree is not actionable",
  TEMP_PATH_REFUSED: "that folder is inside a temporary directory and will not be added",
  ERROR: "internal error",
};

/** The standard error envelope every route emits: `{ ok: false, code, message }`. */
export function jsonError(
  c: Context,
  code: ApiErrorCode,
  message?: string,
  status?: ContentfulStatusCode,
): Response {
  return c.json(
    { ok: false, code, message: message ?? DEFAULT_MESSAGE[code] ?? code },
    status ?? statusForCode(code),
  );
}
