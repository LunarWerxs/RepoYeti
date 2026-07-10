import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { parseBody, AccountSwitchSchema, AccountIdentitySchema } from "../../schemas.ts";
import { accountsSnapshot, switchGhAccount, type AccountsSnapshot, type GhAccount } from "../../gh-cli.ts";
import { accountIdentityMap, getAccountIdentity, getIdentity, setAccountIdentity } from "../../db.ts";

/** The host we default to when a request doesn't name one — the common case. */
const DEFAULT_HOST = "github.com";

/** A gh account plus the saved identity linked to it (applied as the git author on switch), if any. */
interface AccountWithIdentity extends GhAccount {
  identityId: string | null;
}
interface AccountsResponse extends Omit<AccountsSnapshot, "accounts"> {
  accounts: AccountWithIdentity[];
}

/** Merge a gh snapshot with each account's linked identity id from the DB. */
function enrich(snap: AccountsSnapshot): AccountsResponse {
  const map = accountIdentityMap();
  return {
    ...snap,
    accounts: snap.accounts.map((a) => ({ ...a, identityId: map[`${a.host}\0${a.login}`] ?? null })),
  };
}

export function register(app: Hono, _deps: Deps): void {
  // Read the machine's authenticated GitHub (gh) accounts + which one is active + each account's
  // linked commit identity, plus the global git author in effect. No secrets leave the daemon.
  app.get("/api/accounts", async (c) => c.json(enrich(await accountsSnapshot())));

  // Switch the ACTIVE gh account (and align the credential username pin). If the target account is
  // linked to a saved identity, also set the global git author. Owner-gated by the shared /api/*
  // middleware; deliberately NOT an MCP tool — flipping the system's auth account is owner-only.
  app.post("/api/accounts/switch", async (c) => {
    const p = await parseBody(c, AccountSwitchSchema);
    if (!p.ok) return p.res;
    const host = p.data.host?.trim() || DEFAULT_HOST;
    const identityId = getAccountIdentity(host, p.data.login);
    const identity = identityId ? getIdentity(identityId) : null;
    const applyAuthor = identity ? { name: identity.gitUsername, email: identity.gitEmail } : null;
    const r = await switchGhAccount(host, p.data.login, applyAuthor);
    if (!r.ok) return jsonError(c, r.code, r.message);
    return c.json({ ok: true, switched: p.data.login, ...enrich(r.snapshot) });
  });

  // Link (or unlink, with null) a GitHub account to a saved commit identity. The link is applied on
  // the next switch to that account — setting it here does not rewrite the author on its own.
  app.put("/api/accounts/identity", async (c) => {
    const p = await parseBody(c, AccountIdentitySchema);
    if (!p.ok) return p.res;
    const host = p.data.host?.trim() || DEFAULT_HOST;
    const identityId = p.data.identityId || null;
    if (identityId && !getIdentity(identityId)) return jsonError(c, "NOT_FOUND", "identity not found");
    setAccountIdentity(host, p.data.login, identityId);
    return c.json(enrich(await accountsSnapshot()));
  });
}
