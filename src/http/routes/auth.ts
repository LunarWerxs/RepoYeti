import type { Hono, Context } from "hono";
import type { Deps } from "../deps.ts";
import { authEnforced, accessMode, ownerConfigured, saveConfig } from "../../config.ts";
import {
  handleLogin,
  handleComplete,
  handleLogout,
  handleLogoutAll,
  handleContinueLocal,
  readSession,
  isRemoteRequest,
  hasLocalBypass,
  type AuthOptions,
  type HandleLoginOptions,
  type OAuthCallbackUnavailableReason,
  OAuthCallbackUnavailableError,
} from "../../auth.ts";
import { rememberTokens, clearTokens, pullNow } from "../../connections-sync.ts";
import { revokeApiToken } from "../../api-token.ts";
import { effectiveGuest } from "../../auth.ts";
import { clearGuestCookie } from "../../share/index.ts";
import { getOAuthCallback, getOAuthCallbackStatus } from "../../runtime.ts";
import type { RepoYetiConfig } from "../../config.ts";

/**
 * GET /api/auth/status — the public shape the PWA's sign-in screen decides from: whether auth is
 * enforced, what it should offer, and who (if anyone) is signed in.
 *
 * A share-link guest is "authenticated" for the PWA's purposes — they hold a live credential and
 * must land on the dashboard, not the sign-in gate — but they are NOT the owner, so none of the
 * owner's identity (name, email, avatar) appears here. `share` is what the UI keys its guest banner
 * and control-gating off. Owner wins: if both credentials are present this is a normal owner
 * session and the guest fields never appear.
 */
function authStatusResponse(c: Context, cfg: RepoYetiConfig): Response {
  const enforced = authEnforced(cfg);
  const session = enforced ? readSession(c, cfg.oauth!) : null;
  const local = !isRemoteRequest(c);
  const share = effectiveGuest(c, cfg);
  return c.json({
    authEnforced: enforced,
    mode: accessMode(cfg),
    authenticated: enforced ? !!session || !!share : true,
    owner: session?.name || session?.email || session?.sub || null,
    ownerPicture: session?.picture || null,
    ownerClaimed: ownerConfigured(cfg),
    canContinueLocal: local && !share,
    localBypass: local && hasLocalBypass(c),
    share: share
      ? {
          label: share.label,
          perm: share.perm,
          expiresAt: share.expiresAt,
          collaborative: share.collaborative,
        }
      : null,
  });
}

/** GET /api/auth/me — the signed-in owner's identity, every field null when nobody is signed in. */
function authMeResponse(c: Context, cfg: RepoYetiConfig): Response {
  const s = authEnforced(cfg) ? readSession(c, cfg.oauth!) : null;
  return c.json({
    ok: true,
    sub: s?.sub ?? null,
    name: s?.name ?? null,
    email: s?.email ?? null,
    picture: s?.picture ?? null,
  });
}

/**
 * The OIDC dance, only meaningful when configured — oauthGuard refuses with a 404 otherwise, which
 * is also what guarantees the `cfg.oauth!` assertion its handlers carry.
 */
function registerOAuthRoutes(
  app: Hono,
  cfg: RepoYetiConfig,
  authOpts: AuthOptions,
  loginOpts: HandleLoginOptions,
): void {
  const oauthGuard = (h: (c: Context) => Promise<Response>) => async (c: Context) =>
    authEnforced(cfg) ? h(c) : c.text("Sign-in is not configured for this daemon.", 404);
  app.get("/oauth/login", oauthGuard((c) => handleLogin(c, cfg.oauth!, loginOpts)));
  app.get("/oauth/finish", oauthGuard((c) => handleComplete(c, cfg.oauth!, authOpts)));
  app.get("/oauth/callback", oauthGuard((c) => handleComplete(c, cfg.oauth!, authOpts)));
}

/**
 * "Sign out" for the owner; "Leave" for a guest. A guest reaching this (the gate allows it) has no
 * owner session to clear, so clear their share cookie instead and stop — handleLogout would be a
 * no-op for them, leaving a live guest cookie behind and a "Leave" button that lies.
 */
function logoutOwnerOrGuest(c: Context, cfg: RepoYetiConfig): Response | Promise<Response> {
  if (effectiveGuest(c, cfg)) {
    clearGuestCookie(c);
    return c.json({ ok: true });
  }
  return handleLogout(c);
}

/**
 * "Sign out everywhere" — rotate the signing key so every device's session cookie is invalidated at
 * once (sessions are stateless signed cookies; there is no row to revoke). Also forget the
 * Connections refresh token: signing out everywhere severs the settings-sync link too.
 *
 * AND revoke the owner's API Bearer token. That one is NOT a cookie and NOT signed by the rotated
 * key — validBearerToken compares straight against cfg.apiToken — so rotation alone left it
 * authenticating over the public tunnel after the owner had pressed the only panic-button the UI
 * offers. A credential that survives "sign out everywhere" makes the button a lie, so this awaits
 * the revocation rather than firing it off: the response must not claim the token is gone before it
 * is. (Revocation is host-specific — the durable bytes live in this app's keychain — so it belongs
 * here in the adapter, not in the reusable auth.ts.)
 *
 * revokeApiToken (src/api-token.ts) ends live access first and then makes the revocation stick
 * across a restart even when the keychain refuses the delete (a persisted tombstone). The key
 * rotation below must happen regardless of how the durable steps went, so a non-durable outcome is
 * logged rather than allowed to abort the sign-out.
 */
async function revokeTokenThenLogoutAll(c: Context, cfg: RepoYetiConfig): Promise<Response> {
  const [, revoked] = await Promise.allSettled([clearTokens(), revokeApiToken(cfg)]);
  if (revoked.status === "fulfilled" && revoked.value.warning) {
    console.warn(`repoyeti: sign out everywhere — API token: ${revoked.value.warning}`);
  } else if (revoked.status === "rejected") {
    console.warn(`repoyeti: sign out everywhere — API token revocation threw: ${String(revoked.reason)}`);
  }
  return handleLogoutAll(c);
}

/** The registered callback to send the owner back to after sign-in, or a typed refusal when the
 *  daemon cannot determine a usable one. */
async function resolveOAuthRedirect(
  cfg: RepoYetiConfig,
  origin: string,
): Promise<{ redirectUri: string; relayId?: string }> {
  const callback = getOAuthCallback(cfg, origin);
  if (callback) return callback;
  const status = getOAuthCallbackStatus(cfg, origin);
  const reason: OAuthCallbackUnavailableReason =
    status === "failed" || status === "incompatible" ? status : "temporary";
  throw new OAuthCallbackUnavailableError(reason);
}

/** Retain the owner's refresh token (keychain) so the daemon can sync settings to the Connections
 *  store; if sync is already enabled, a fresh sign-in immediately pulls the cloud copy. */
function retainConnectionTokens(
  tokens: { access_token?: string; refresh_token?: string; expires_in?: number },
  cfg: RepoYetiConfig,
): void {
  void rememberTokens(tokens, cfg.oauth!).then(() => {
    // Best-effort: a failed pull just leaves the local copy in place until the next sync.
    if (cfg.cloudSync?.enabled) return pullNow(cfg, cfg.oauth!).catch(() => {});
  });
}

export function register(app: Hono, { cfg }: Deps): void {
  // Public: lets the PWA decide whether to show the "Sign in with Connections" screen,
  // arkitect-allow: no-bandaids - "Continue local for now" is the literal label of the button the sign-in screen renders (web/src/components/SignIn.vue): the wording belongs to the UI copy, not to an unfinished code path here.
  // and whether to offer the "Continue local for now" escape hatch (loopback only).
  app.get("/api/auth/status", (c) => authStatusResponse(c, cfg));
  app.get("/api/auth/me", (c) => authMeResponse(c, cfg));
  app.post("/api/auth/logout", (c) => logoutOwnerOrGuest(c, cfg));
  app.post("/api/auth/logout-all", (c) => revokeTokenThenLogoutAll(c, cfg));
  // arkitect-allow: no-bandaids - "Continue local for now" is the shipped button label (web/src/components/SignIn.vue): the route is named after the control that calls it, and the bypass it grants is the finished feature, not a placeholder.
  // "Continue local for now" — grant a localhost-only bypass (refused over the tunnel).
  app.post("/api/auth/continue-local", (c) => handleContinueLocal(c));

  // Adapter: the generic OIDC handlers take a bare OAuthConfig + an AuthOptions bag (not the whole
  // RepoYetiConfig). RepoYeti passes cfg.oauth and persists a first-use ("TOFU") ownership claim back
  // to config.json; cookie names + signing secret fall back to the module defaults (RepoYeti's own).
  // onTokens retains the owner's refresh token (keychain) so the daemon can sync settings to the
  // Connections store; if sync is already enabled, a fresh sign-in immediately pulls the cloud copy.
  const authOpts: AuthOptions = {
    onOwnerClaimed: () => saveConfig(cfg),
    onTokens: (tokens) => retainConnectionTokens(tokens, cfg),
  };
  const loginOpts: HandleLoginOptions = {
    ...authOpts,
    resolveRedirect: (origin) => resolveOAuthRedirect(cfg, origin),
  };

  registerOAuthRoutes(app, cfg, authOpts, loginOpts);
}
