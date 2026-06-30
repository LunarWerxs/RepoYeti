import type { Hono, Context } from "hono";
import type { Deps } from "../deps.ts";
import { authEnforced, accessMode, ownerConfigured } from "../../config.ts";
import {
  handleLogin,
  handleComplete,
  handleLogout,
  handleLogoutAll,
  handleContinueLocal,
  readSession,
  isRemoteRequest,
  hasLocalBypass,
} from "../../auth.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // Public: lets the PWA decide whether to show the "Sign in with Connections" screen,
  // and whether to offer the "Continue local for now" escape hatch (loopback only).
  app.get("/api/auth/status", (c) => {
    const enforced = authEnforced(cfg);
    const session = enforced ? readSession(c, cfg.oauth!) : null;
    const local = !isRemoteRequest(c);
    return c.json({
      authEnforced: enforced,
      mode: accessMode(cfg),
      authenticated: enforced ? !!session : true,
      owner: session?.email || session?.sub || null,
      ownerClaimed: ownerConfigured(cfg),
      canContinueLocal: local,
      localBypass: local && hasLocalBypass(c),
    });
  });
  app.get("/api/auth/me", (c) => {
    const s = authEnforced(cfg) ? readSession(c, cfg.oauth!) : null;
    return c.json({ ok: true, sub: s?.sub ?? null, email: s?.email ?? null });
  });
  app.post("/api/auth/logout", (c) => handleLogout(c));
  // "Sign out everywhere" — rotate the signing key so every device's session cookie is
  // invalidated at once (sessions are stateless signed cookies; there is no row to revoke).
  app.post("/api/auth/logout-all", (c) => handleLogoutAll(c));
  // "Continue local for now" — grant a localhost-only bypass (refused over the tunnel).
  app.post("/api/auth/continue-local", (c) => handleContinueLocal(c));

  // OIDC dance (only meaningful when configured).
  const oauthGuard = (h: (c: Context) => Promise<Response>) => (c: Context) =>
    authEnforced(cfg) ? h(c) : c.text("Sign-in is not configured for this daemon.", 404);
  app.get("/oauth/login", oauthGuard((c) => handleLogin(c, cfg)));
  app.get("/oauth/finish", oauthGuard((c) => handleComplete(c, cfg)));
  app.get("/oauth/callback", oauthGuard((c) => handleComplete(c, cfg)));
}
