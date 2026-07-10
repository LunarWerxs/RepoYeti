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
  | "NON_FAST_FORWARD"
  | "DETACHED_HEAD"
  | "NO_UPSTREAM"
  | "NO_REMOTE"
  | "NOTHING_TO_COMMIT"
  | "SSH_AUTH_FAILED"
  | "SSH_PASSPHRASE_REQUIRED"
  // ── repo / service ──
  | "NOT_FOUND"
  | "NOT_A_REPO"
  | "EXISTS"
  | "SUBMODULE_NOT_ACTIONABLE"
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
  // ── smart commit (multi-commit splitter) ──
  | "EMPTY_PLAN"
  | "PLAN_PATHS_INVALID"
  | "PLAN_STALE"
  // ── request / validation ──
  | "BAD_REQUEST"
  | "VALIDATION"
  | "NO_MESSAGE"
  | "BAD_MODE"
  | "NEEDS_OWNER"
  // ── AI (mirror ai.ts AiCode + the route guards) ──
  | "AI_AUTH_FAILED"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
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

/** Canonical HTTP status for a code. Routes can still override per call site. */
export function statusForCode(code: ApiCode): ContentfulStatusCode {
  switch (code) {
    case "OK":
      return 200;
    // 400 — the caller sent something we can't act on.
    case "BAD_REQUEST":
    case "VALIDATION":
    case "NO_MESSAGE":
    case "BAD_MODE":
    case "NOT_A_REPO":
    case "AI_BAD_REQUEST":
    case "NO_KEY":
    case "NO_AI_PROVIDER":
    case "NO_MODEL":
    case "NOT_CONFIGURED":
    case "INVALID_REF_NAME":
    case "EMPTY_PLAN":
    case "PLAN_PATHS_INVALID":
      return 400;
    // 401 — a credential was supplied but rejected.
    case "AI_AUTH_FAILED":
      return 401;
    // 404 — the named thing doesn't exist.
    case "NOT_FOUND":
    case "BAD_PROVIDER":
      return 404;
    // 409 — the repo/owner state conflicts with the request ("resolve at your desk").
    case "DIRTY_WORKING_TREE":
    case "NON_FAST_FORWARD":
    case "DETACHED_HEAD":
    case "NO_UPSTREAM":
    case "NO_REMOTE":
    case "NOTHING_TO_COMMIT":
    case "EXISTS":
    case "SUBMODULE_NOT_ACTIONABLE":
    case "NEEDS_OWNER":
    case "BRANCH_EXISTS":
    case "UNMERGED_BRANCH":
    case "CANNOT_DELETE_CURRENT":
    case "PROTECTED_BRANCH":
    case "NOTHING_TO_STASH":
    case "STASH_CONFLICT":
    case "STASH_EMPTY":
    case "PLAN_STALE":
    case "IDENTITY_POLICY_VIOLATION":
      return 409;
    // 502 — an upstream (git remote / AI provider) failed.
    case "SSH_AUTH_FAILED":
    case "AI_ERROR":
      return 502;
    // 504 — an upstream hung past our timeout.
    case "SSH_PASSPHRASE_REQUIRED":
    case "AI_UNREACHABLE":
      return 504;
    default:
      return 500;
  }
}

/** A short default message for a code, used when a route doesn't supply its own. */
const DEFAULT_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  NOT_FOUND: "not found",
  BAD_REQUEST: "bad request",
  VALIDATION: "invalid request",
  BAD_PROVIDER: "unknown provider",
  SUBMODULE_NOT_ACTIONABLE: "submodule worktree is not actionable",
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
