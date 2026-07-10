/**
 * Owner-minted API Bearer token routes (OPTIONAL, off by default).
 *
 * These live under /api/* so they're owner-gated automatically by the auth middleware — only a
 * signed-in owner (or a request that already carries a valid token / local bypass) can mint, view,
 * or revoke. The token is a separate, LOCAL credential (never touches connections.icu) that lets a
 * remote/headless agent authenticate over the tunnel. The durable bytes live in the OS keychain
 * (secrets.ts API_TOKEN); `cfg.apiToken` is the hydrated in-memory slot the gate checks.
 *
 * The plaintext value is returned EXACTLY ONCE — by POST (mint). GET reports only whether one is
 * configured; it NEVER returns the value.
 */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { setSecret, deleteSecret, API_TOKEN } from "../../secrets.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // Mint (or overwrite) the API token. The ONLY time the value is returned to a client.
  app.post("/api/auth/token", async (c) => {
    const token = randomBytes(32).toString("base64url");
    await setSecret(API_TOKEN, token);
    cfg.apiToken = token;
    return c.json({ ok: true, token });
  });

  // Revoke the API token (disables Bearer auth again — back to OIDC-only).
  app.delete("/api/auth/token", async (c) => {
    await deleteSecret(API_TOKEN);
    delete cfg.apiToken;
    return c.json({ ok: true });
  });

  // Status: whether a token is configured. NEVER returns the value.
  app.get("/api/auth/token", (c) => c.json({ ok: true, configured: !!cfg.apiToken }));
}
