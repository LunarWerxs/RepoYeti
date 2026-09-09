/**
 * Owner-minted API Bearer token routes (OPTIONAL, off by default).
 *
 * These live under /api/* so they're owner-gated automatically by the auth middleware — only a
 * signed-in owner (or a request that already carries a valid token / local bypass) can mint, view,
 * or revoke. The token is a separate, LOCAL credential (never touches connections.icu) that lets a
 * remote/headless agent authenticate over the tunnel. The durable bytes live in the OS keychain
 * (secrets.ts API_TOKEN) or, on a keychain-less host, in config.json; `cfg.apiToken` is the
 * hydrated in-memory slot the gate checks. The mint/revoke mechanics, and the guarantees each
 * response field makes, live in src/api-token.ts.
 *
 * The plaintext value is returned EXACTLY ONCE — by POST (mint). GET reports only whether one is
 * configured; it NEVER returns the value.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { mintApiToken, revokeApiToken } from "../../api-token.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // Mint (or overwrite) the API token. The ONLY time the value is returned to a client. `store`
  // says where the durable copy went ("config" = the keychain refused, so config.json holds it in
  // plaintext under the owner-only ACL — worth knowing). A mint that nothing durable accepted is
  // an error, not a token that dies at the next restart.
  app.post("/api/auth/token", async (c) => {
    const r = await mintApiToken(cfg);
    if (!r.ok) return jsonError(c, "ERROR", r.message, 500);
    return c.json({ ok: true, token: r.token, store: r.store });
  });

  // Revoke the API token (disables Bearer auth again — back to OIDC-only). Live access ends before
  // this responds, always; `durable` / `keychainCleared` report whether a restart can bring it
  // back (it cannot while `durable` is true — a refused keychain delete is tombstoned).
  app.delete("/api/auth/token", async (c) => {
    const r = await revokeApiToken(cfg);
    if (!r.durable) return c.json({ ok: false, code: "ERROR", message: r.warning, ...r }, 500);
    return c.json({ ok: true, ...r });
  });

  // Status: whether a token is configured. NEVER returns the value.
  app.get("/api/auth/token", (c) => c.json({ ok: true, configured: !!cfg.apiToken }));
}
