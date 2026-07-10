// ⭐ Identity Firewall — client-side rule check, so the repo card badge (RepoCardHeader.vue) can
// flag a violation locally without a round-trip. The glob matcher itself is the daemon's OWN
// implementation (../../../src/glob-match.ts) imported directly — one shared module, so the
// client can never drift from the server (it's the redaction layer; drift here would be a
// security bug). The daemon remains the source of truth that actually blocks the action; this
// module is display-only.
import { globMatch } from "../../../src/glob-match.ts";
import type { IdentityRule, Repo } from "../types";

/** The first rule (in array order) whose pathPattern matches `absPath`, or null. */
export function matchIdentityRule(absPath: string, rules: IdentityRule[]): IdentityRule | null {
  for (const rule of rules) {
    if (globMatch(rule.pathPattern, absPath)) return rule;
  }
  return null;
}

/** Does this repo currently violate an Identity Firewall rule (matches a rule whose
 *  `requiredIdentityId` differs from the repo's own resolved `identityId`)? Display-only —
 *  the daemon is what actually blocks the mutating action. */
export function repoViolatesIdentityRule(repo: Repo, rules: IdentityRule[]): IdentityRule | null {
  const rule = matchIdentityRule(repo.absPath, rules);
  if (!rule) return null;
  return repo.identityId === rule.requiredIdentityId ? null : rule;
}
