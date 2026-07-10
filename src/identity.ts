/**
 * Resolve the effective identity for a repo.
 *
 * Phase 3: a repo's explicit override only. Phase 5 extends this to fall back to
 * the repo's workspace default identity. Returns null when none is assigned (git
 * then uses whatever the repo/host already has — we never force one on).
 */
import { getIdentity, type Identity, type RepoView } from "./db.ts";
import type { IdentityRule, RepoYetiConfig } from "./config.ts";
import { globMatch } from "./glob-match.ts";

export function resolveRepoIdentity(repo: RepoView): Identity | null {
  if (repo.identityId) return getIdentity(repo.identityId);
  return null;
}

// ── Identity Firewall (v1, dead simple) ──────────────────────────────────────────────
//
// The glob matcher lives in src/glob-match.ts — ONE shared implementation, also imported by the
// web's display-only mirror (web/src/lib/identity-firewall.ts) so client and server can never
// drift. Re-exported here so existing importers/tests keep their entry point.
export { globMatch };

/** The first rule (in array order) whose `pathPattern` matches `absPath`, or null when no rule
 *  applies. First-match-wins keeps v1 simple — no rule-priority/merge semantics to reason about. */
export function matchIdentityRule(absPath: string, rules: IdentityRule[] | undefined): IdentityRule | null {
  if (!rules?.length) return null;
  for (const rule of rules) {
    if (globMatch(rule.pathPattern, absPath)) return rule;
  }
  return null;
}

/** Result of checking a repo against the Identity Firewall: either no rule applies / the
 *  resolved identity satisfies it (`ok: true`), or it's a hard violation naming the rule and
 *  what actually resolved (`ok: false`) — the caller turns this into IDENTITY_POLICY_VIOLATION. */
export type IdentityPolicyCheck =
  | { ok: true }
  | { ok: false; rule: IdentityRule; resolvedIdentityId: string | null };

/**
 * Preflight check for the Identity Firewall: does this repo's CURRENTLY RESOLVED identity
 * (resolveRepoIdentity) satisfy the rule matching its path, if any? Call this at every point
 * that resolves an identity before a commit/push actually runs (src/service/core.ts's
 * `runAction`, src/service/actions.ts's `smartCommitRepo` + `commitSelectedRepo`) — MCP mutating
 * calls funnel through those same functions, so they inherit the block automatically.
 */
export function checkIdentityPolicy(repo: RepoView, rules: IdentityRule[] | undefined): IdentityPolicyCheck {
  const rule = matchIdentityRule(repo.absPath, rules);
  if (!rule) return { ok: true };
  const identity = resolveRepoIdentity(repo);
  if (identity?.id === rule.requiredIdentityId) return { ok: true };
  return { ok: false, rule, resolvedIdentityId: identity?.id ?? null };
}

/** Human-readable message for a violation, shared by every enforcement call site so the error
 *  text (and the web UI reading it back) stays consistent. */
export function identityPolicyMessage(check: Extract<IdentityPolicyCheck, { ok: false }>): string {
  const required = getIdentity(check.rule.requiredIdentityId);
  const requiredName = required?.displayName ?? check.rule.requiredIdentityId;
  return `this repo requires identity "${requiredName}" (rule "${check.rule.pathPattern}") — resolved identity does not match`;
}

// ── live config ref (mirrors auto-commit.ts's setAutoCommitConfig pattern) ─────────────────
// Primed at boot (app.ts) + re-primed on every rules edit (the identity-rules route) so the
// three enforcement call sites (below) always see the current `identityRules` without each
// having to thread `cfg` through. A repo action running before boot priming (tests that build
// their own config) simply sees no rules — safe (identical to "no rules configured").
let cfgRef: RepoYetiConfig | null = null;

/** Give this module the live config object (for `identityRules`). Called from app.ts at boot,
 *  and again after PUT /api/identity-rules persists an edit. */
export function setIdentityRulesConfig(cfg: RepoYetiConfig): void {
  cfgRef = cfg;
}

/** The live `identityRules` list, or `[]` before `setIdentityRulesConfig` has ever been called. */
export function currentIdentityRules(): IdentityRule[] {
  return cfgRef?.identityRules ?? [];
}

/** Structured failure shape shared by every enforcement call site — same idiom as
 *  guards.ts's GuardFail (`{ ok: false, code, message }`, spread with call-site-specific extras). */
export interface IdentityPolicyFail {
  ok: false;
  code: "IDENTITY_POLICY_VIOLATION";
  message: string;
}

/**
 * The ONE preflight enforcement point every mutating VCS action calls before touching git:
 * checks the repo against the live Identity Firewall rules and returns a ready-to-return
 * failure object, or null when the action may proceed. Called from src/service/core.ts's
 * `runAction` (fetch/pull/push/commit/checkout/createBranch/stash/tag) and
 * src/service/actions.ts's `smartCommitRepo` + `commitSelectedRepo` — MCP mutating tool calls
 * go through those exact same functions, so they inherit the block with no separate wiring.
 */
export function enforceIdentityPolicy(repo: RepoView): IdentityPolicyFail | null {
  const check = checkIdentityPolicy(repo, currentIdentityRules());
  if (check.ok) return null;
  return { ok: false, code: "IDENTITY_POLICY_VIOLATION", message: identityPolicyMessage(check) };
}
