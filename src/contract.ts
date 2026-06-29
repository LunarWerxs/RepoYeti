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
      return 409;
    // 502 — an upstream (git remote / AI provider) failed.
    case "SSH_AUTH_FAILED":
    case "AI_ERROR":
      return 502;
    // 504 — an upstream hung past our timeout.
    case "SSH_PASSPHRASE_REQUIRED":
    case "AI_UNREACHABLE":
      return 504;
    case "ERROR":
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
