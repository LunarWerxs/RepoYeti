/**
 * ⭐ Identity Firewall rules: read/replace the list of {pathPattern, requiredIdentityId} rules
 * that src/identity.ts's `enforceIdentityPolicy` checks before every commit/push (both the
 * dashboard HTTP actions and MCP mutating calls funnel through the same service functions —
 * see service/core.ts's runAction + service/actions.ts's smartCommitRepo/commitSelectedRepo).
 *
 * v1 is dead simple: PUT replaces the whole list (no per-rule CRUD endpoints) — the Settings
 * rules editor always submits its full, current list. A `requiredIdentityId` that doesn't name
 * an existing identity is rejected (NOT_FOUND) so a rule can never point at nothing.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { parseBody, IdentityRulesSchema } from "../../schemas.ts";
import { getIdentity } from "../../db.ts";
import { broadcast } from "../../bus.ts";
import { setIdentityRulesConfig } from "../../identity.ts";
import { saveConfig } from "../../config.ts";

export function register(app: Hono, { cfg }: Deps): void {
  app.get("/api/identity-rules", (c) => c.json({ rules: cfg.identityRules ?? [] }));

  app.put("/api/identity-rules", async (c) => {
    const p = await parseBody(c, IdentityRulesSchema);
    if (!p.ok) return p.res;
    for (const rule of p.data.rules) {
      if (!getIdentity(rule.requiredIdentityId)) {
        return jsonError(c, "NOT_FOUND", `identity "${rule.requiredIdentityId}" not found`);
      }
    }
    cfg.identityRules = p.data.rules;
    saveConfig(cfg);
    setIdentityRulesConfig(cfg); // re-prime the live ref the enforcement checks read from
    broadcast("identity_rules_changed", { rules: cfg.identityRules });
    return c.json({ ok: true, rules: cfg.identityRules });
  });
}
