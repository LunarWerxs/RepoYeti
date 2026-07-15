/**
 * "Sign in with Connections" — public OIDC relying party (docs/ARCHITECTURE.md §7).
 *
 * Stand-alone: RepoYeti only ever calls the IdP's PUBLIC OAuth URLs (discovered from
 * `<issuer>/.well-known/openid-configuration`) and verifies the returned id_token
 * with the IdP's PUBLIC JWKS (via `jose`). No shared secret, no IdP-repo coupling.
 *
 * Auth is ENFORCED on every /api/* route exactly when OIDC is configured (and it is
 * required before any tunnel is exposed). With no OIDC config the daemon is
 * local-only (127.0.0.1) and unauthenticated — safe because nothing can reach it.
 *
 * Flow (daemon-side PKCE; the phone never holds tokens):
 *   /oauth/login → authorize (redirect_uri = <origin>/oauth/callback) with signed state that
 *   embeds this daemon's origin → IdP → <origin>/oauth/callback?code&state → token exchange →
 *   verify id_token (JWKS) → owner check → signed session cookie. The IdP allow-lists the daemon's
 *   OWN callback (app.repoyeti.com/oauth/callback + the loopback); the old rotating-URL "shim" Worker
 *   is retired (see config.ts CONNECTIONS_OAUTH + handleLogin below).
 *
 * Reusable across apps: the OIDC handlers (handleLogin/handleComplete/handleLogout/…) take a bare
 * `OAuthConfig` plus an optional `AuthOptions` bag (cookie names, signing secret, a TOFU-persist
 * hook) — NOT the whole `RepoYetiConfig`. RepoYeti supplies its own values through a thin adapter
 * at its HTTP routes (see src/http/routes/auth.ts); a sibling app adopts this by passing its own.
 * Only `authMiddleware` (RepoYeti's local-vs-remote access policy) still takes the full config.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { authEnforced, accessMode, type RepoYetiConfig, type OAuthConfig } from "./config.ts";
import { sign, unsign, rotateKey } from "./signing.ts";
import { readGuestShare } from "./share/index.ts";
import { policyFor, permSatisfies } from "./share/policy.ts";
import { shareCoversRepo, logShareEvent, type Share } from "./db.ts";

const COOKIE = "gm_session";
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const TX_TTL_MS = 10 * 60 * 1000;
const AUTH_FETCH_TIMEOUT_MS = 15_000;

export interface Session {
  sub: string;
  email: string;
  /** Display name from /oauth/userinfo (profile scope). Optional: older cookies + local-bypass
   *  sessions have none, and it's filled on the next Connections sign-in. */
  name?: string;
  /** Avatar image URL from /oauth/userinfo (photo scope, when granted). Optional for the same
   *  reasons as `name` — older cookies and local-bypass sessions have none. */
  picture?: string;
  exp: number;
}

/**
 * Host-app-specific knobs for the otherwise-generic OIDC handlers. Every field is optional
 * and falls back to this module's defaults, so RepoYeti's call sites stay a one-line adapter
 * while a *different* adopter (a future sibling app) overrides only what it needs.
 *
 * This is the seam that lets `handleLogin` / `handleComplete` (and the session/bypass helpers)
 * depend on a bare `OAuthConfig` + these knobs instead of the whole `RepoYetiConfig`.
 */
export interface AuthOptions {
  /** Signed-session cookie name (default "gm_session"). */
  cookieName?: string;
  /** Local-bypass cookie name (default "gm_local"). */
  localCookieName?: string;
  /** HMAC secret signing the session / state / bypass cookies. Defaults to the per-install key
   *  persisted under the app's config dir (see `key()`) — every app that vendors this module
   *  gets its own isolated key for free, which is why RepoYeti never passes this. */
  secret?: Buffer;
  /** Called after a first-use ("TOFU") ownership claim mutates `oauth.ownerSub`, so the host can
   *  persist the change. No-op if omitted. RepoYeti wires this to `saveConfig`. */
  onOwnerClaimed?: (oauth: OAuthConfig) => void;
  /** Called on a successful token exchange with the FULL token set (not just the id_token this
   *  module verifies for identity). Lets a host that also acts as a Backend-for-Frontend retain the
   *  `refresh_token` server-side and later mint access tokens to call a per-user API (e.g. the
   *  Connections settings-sync store). No-op if omitted → identity-only behaviour is unchanged.
   *  The `sub`/`email` are the just-verified owner identity, so the host can key the tokens by owner. */
  onTokens?: (tokens: OAuthTokens, who: { sub: string; email: string; name: string }) => void;
}

/** The token-endpoint response the BFF cares about (a superset of the id_token used for identity). */
export interface OAuthTokens {
  access_token?: string;
  refresh_token?: string;
  /** Access-token lifetime in seconds (per RFC 6749); used to schedule a proactive refresh. */
  expires_in?: number;
  token_type?: string;
}

// The signing key + sign/unsign/rotateKey now live in signing.ts, so share/index.ts can sign a
// guest cookie without importing this module (which imports IT, to read one — that pair would be
// a cycle). Re-exported here because they've always been part of auth.ts's surface.
export { sign, unsign, rotateKey } from "./signing.ts";

// ── OIDC discovery + JWKS (cached) ─────────────────────────────────────────────
let discoveryCache: { issuer: string; doc: Record<string, string> } | null = null;
function authFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS) });
}
async function discover(
  issuer: string,
  doFetch: FetchLike = authFetch,
): Promise<Record<string, string>> {
  const iss = issuer.replace(/\/$/, "");
  if (discoveryCache?.issuer === iss) return discoveryCache.doc;
  const res = await doFetch(`${iss}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Record<string, string>;
  discoveryCache = { issuer: iss, doc };
  return doc;
}

let jwksCache: { uri: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
function jwks(uri: string) {
  if (jwksCache?.uri !== uri) jwksCache = { uri, set: createRemoteJWKSet(new URL(uri)) };
  return jwksCache.set;
}

// ── PKCE transactions ──────────────────────────────────────────────────────────
/** @internal exported for security tests only — not part of the public API. */
export const txs = new Map<string, { verifier: string; ts: number }>();
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
function gcTx(): void {
  const now = Date.now();
  for (const [k, v] of txs) if (now - v.ts > TX_TTL_MS) txs.delete(k);
}

/** @internal exported for security tests only — not part of the public API. */
export function ownerMatches(o: OAuthConfig, sub: string, email: string): boolean {
  if (o.ownerSub && sub === o.ownerSub) return true;
  if (o.ownerEmail && email && email.toLowerCase() === o.ownerEmail.toLowerCase()) return true;
  return false;
}

// ── session cookie ─────────────────────────────────────────────────────────────
/** Proto as seen by the *client* — honours the tunnel's X-Forwarded-Proto, since
 * cloudflared terminates TLS and forwards to the daemon over plain http. */
function clientProto(c: Context): string {
  return (
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(c.req.url).protocol.replace(":", "")
  );
}
function isHttps(c: Context): boolean {
  return clientProto(c) === "https";
}
/** The daemon's public origin as the browser reached it (https over a tunnel). This
 * is what we stamp into `state` so the shim bounces back to a reachable URL. */
function publicOrigin(c: Context): string {
  const u = new URL(c.req.url);
  u.protocol = `${clientProto(c)}:`;
  return u.origin;
}
function setSession(c: Context, s: Session, opts?: AuthOptions): void {
  setCookie(c, opts?.cookieName ?? COOKIE, sign(JSON.stringify(s), opts?.secret), {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}
export function readSession(c: Context, o: OAuthConfig, opts?: AuthOptions): Session | null {
  const raw = unsign(getCookie(c, opts?.cookieName ?? COOKIE), opts?.secret);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (!s.exp || s.exp < Date.now()) return null;
    if (!ownerMatches(o, s.sub, s.email)) return null;
    return s;
  } catch {
    return null;
  }
}

// ── local-bypass ("Continue local for now") ─────────────────────────────────────
// In remote mode the dashboard demands a login, but someone physically at the machine
// can opt to keep using it locally. This is gated HARD on the request being loopback:
// a request that arrived over the tunnel carries Cloudflare/forwarding headers it cannot
// strip, so a remote caller can NEVER use the bypass — only true localhost can.
const LOCAL_COOKIE = "gm_local";
const LOCAL_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * True when the request came in over the tunnel (Cloudflare adds these; localhost has none).
 *
 * ⚠️ SECURITY ASSUMPTION (F2): "local vs remote" is inferred PURELY from these proxy headers.
 * This is correct behind Cloudflare (the named tunnel always injects `cf-connecting-ip`, and a
 * remote caller can't strip them). But if you deploy RepoYeti behind a DIFFERENT reverse proxy
 * that does NOT set any of these, a genuinely remote request would be misclassified as LOCAL —
 * letting it use the "continue local" bypass and skip owner auth. Only expose the daemon through
 * a proxy that sets `cf-connecting-ip` / `x-forwarded-*` (see README "Deploying behind a proxy"),
 * or bind it to loopback only. Do not loosen this without re-deriving remoteness from a trusted
 * signal (e.g. the bound socket address), not a spoofable header.
 */
export function isRemoteRequest(c: Context): boolean {
  return !!(
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for") ||
    c.req.header("x-forwarded-proto")
  );
}

function setLocalBypass(c: Context, opts?: AuthOptions): void {
  setCookie(c, opts?.localCookieName ?? LOCAL_COOKIE, sign(JSON.stringify({ exp: Date.now() + LOCAL_TTL_MS }), opts?.secret), {
    httpOnly: true,
    sameSite: "Lax",
    secure: false, // local http only — never sent over the tunnel anyway
    path: "/",
    maxAge: Math.floor(LOCAL_TTL_MS / 1000),
  });
}

/** A live local-bypass cookie — only meaningful for a local request (callers gate on that). */
export function hasLocalBypass(c: Context, opts?: AuthOptions): boolean {
  const raw = unsign(getCookie(c, opts?.localCookieName ?? LOCAL_COOKIE), opts?.secret);
  if (!raw) return false;
  try {
    const { exp } = JSON.parse(raw) as { exp: number };
    return !!exp && exp > Date.now();
  } catch {
    return false;
  }
}

/** POST /api/auth/continue-local — grant the local bypass. Refused for tunnel traffic. */
export function handleContinueLocal(c: Context, opts?: AuthOptions): Response {
  if (isRemoteRequest(c)) {
    return c.json({ ok: false, code: "REMOTE_FORBIDDEN", message: "local bypass is not available remotely" }, 403);
  }
  setLocalBypass(c, opts);
  return c.json({ ok: true });
}

// ── HTML for the auth-complete error page ──────────────────────────────────────
function errPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RepoYeti — sign in</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="max-width:340px;text-align:center;padding:24px">
<div style="font-size:40px">🔒</div>
<h2 style="margin:12px 0 8px">Can't sign you in</h2>
<p style="color:#9a9aa6;font-size:14px;line-height:1.5">${message}</p>
<a href="/oauth/login" style="display:inline-block;margin-top:14px;background:#3ddc84;color:#06210f;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:9px">Try again</a>
</div></body>`;
}

// ── handlers ────────────────────────────────────────────────────────────────────

/** Minimal fetch signature used by the auth seam — a subset of the global fetch. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Options accepted by handleLogin — the AuthOptions knobs plus a fetch seam for tests. */
export interface HandleLoginOptions extends AuthOptions {
  /** Override the fetch used for OIDC discovery (lets a unit test avoid a live network). */
  fetchImpl?: FetchLike;
}

export async function handleLogin(c: Context, oauth: OAuthConfig, opts?: HandleLoginOptions): Promise<Response> {
  const o = oauth;
  const doc = await discover(o.issuer, opts?.fetchImpl ?? authFetch);
  const { verifier, challenge } = pkce();
  const nonce = randomBytes(16).toString("base64url");
  txs.set(nonce, { verifier, ts: Date.now() });
  gcTx();
  const origin = publicOrigin(c);
  const state = sign(JSON.stringify({ n: nonce, o: origin }), opts?.secret);
  const url = new URL(doc.authorization_endpoint!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  // Doing it right (we own the domain): register the daemon's OWN callback at its current origin —
  // no rotating-URL shim. The IdP allow-lists app.repoyeti.com/oauth/callback + the loopback.
  url.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
  url.searchParams.set("scope", o.scopes || "openid profile email photo");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

/** Options accepted by handleComplete — the AuthOptions knobs plus two test seams.
 *  Production callers pass only `onOwnerClaimed` (via the host adapter); tests add the fetch/JWKS seams. */
export interface HandleCompleteOptions extends AuthOptions {
  /** Override the fetch implementation used for OIDC discovery + token exchange. */
  fetchImpl?: FetchLike;
  /** Override the JWKS key resolver passed to jwtVerify (skips createRemoteJWKSet). */
  jwksSet?: Parameters<typeof jwtVerify>[1];
}

/** Shared by /oauth/finish (shim bounce) and /oauth/callback (loopback). */
export async function handleComplete(
  c: Context,
  oauth: OAuthConfig,
  opts?: HandleCompleteOptions,
): Promise<Response> {
  const o = oauth;
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.html(errPage("Missing authorization code."), 400);

  const sp = unsign(state, opts?.secret);
  if (!sp) return c.html(errPage("Invalid or tampered sign-in state."), 400);
  let nonce: string;
  let stateOrigin: string;
  try {
    const parsed = JSON.parse(sp);
    nonce = parsed.n as string;
    stateOrigin = String(parsed.o || "");
  } catch {
    return c.html(errPage("Invalid sign-in state."), 400);
  }
  const tx = txs.get(nonce);
  if (!tx) return c.html(errPage("This sign-in link expired. Start again."), 400);
  txs.delete(nonce);

  // Allow a test-supplied fetch so unit tests can inject a mock IdP without a live network.
  const doFetch: FetchLike = opts?.fetchImpl ?? authFetch;

  try {
    const doc = await discover(o.issuer, doFetch);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // Must EXACTLY match the redirect_uri sent at /oauth/login — the daemon's own origin (from the
      // signed state, so it can't be tampered) + /oauth/callback. No shim.
      redirect_uri: `${stateOrigin}/oauth/callback`,
      client_id: o.clientId,
      code_verifier: tx.verifier,
    });
    if (o.clientSecret) body.set("client_secret", o.clientSecret);
    const tr = await doFetch(doc.token_endpoint!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tr.ok) return c.html(errPage("Token exchange with Connections failed."), 502);
    const tok = (await tr.json()) as { id_token?: string } & OAuthTokens;
    if (!tok.id_token) return c.html(errPage("Connections returned no identity token."), 502);

    const keySet = opts?.jwksSet ?? jwks(doc.jwks_uri!);
    const { payload } = await jwtVerify(tok.id_token, keySet, {
      issuer: o.issuer.replace(/\/$/, ""),
      audience: o.clientId,
    });
    const sub = String(payload.sub ?? "");
    const email = String((payload as { email?: string }).email ?? "");

    // First-use ownership (TOFU): if no owner is configured yet, the first verified
    // sign-in claims this daemon and is persisted. After that it's locked to that
    // identity. Lets the owner bootstrap without hunting down their Cognito `sub`.
    if (!o.ownerSub && !o.ownerEmail && sub) {
      o.ownerSub = sub;
      opts?.onOwnerClaimed?.(o);
      console.log(`[repoyeti] ownership claimed by ${email || sub}`);
    }

    if (!ownerMatches(o, sub, email)) {
      return c.html(errPage("This Connections account isn't the owner of this RepoYeti."), 403);
    }
    // The id_token carries only `sub` — AEGIS mints minimal-claim id_tokens (Google-style; profile
    // claims live at /oauth/userinfo). Fetch the display name (+ the privacy-relay email) there so the
    // UI shows a human name instead of the raw sub. Best-effort: a userinfo blip must never fail an
    // otherwise-valid owner login.
    let name = "";
    let displayEmail = email;
    let picture = "";
    if (tok.access_token && doc.userinfo_endpoint) {
      try {
        const ui = await doFetch(doc.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tok.access_token}` },
        });
        if (ui.ok) {
          const u = (await ui.json()) as { email?: string; name?: string; picture?: string };
          if (u.name) name = u.name;
          if (u.email) displayEmail = u.email;
          if (u.picture) picture = u.picture;
        }
      } catch {
        /* best-effort — the login proceeds with sub only */
      }
    }
    // Hand the full token set to the host (if it wired the hook) AFTER the owner check, so only the
    // verified owner's tokens are ever retained. RepoYeti persists the refresh_token (keychain) so
    // the daemon can sync settings to the Connections store on the owner's behalf. Identity-only
    // hosts omit onTokens and nothing changes.
    if (tok.access_token) {
      opts?.onTokens?.(
        { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in, token_type: tok.token_type },
        { sub, email: displayEmail, name },
      );
    }
    setSession(c, { sub, email: displayEmail, name, picture, exp: Date.now() + SESSION_TTL_MS }, opts);
    return c.redirect("/");
  } catch {
    return c.html(errPage("Couldn't verify your Connections sign-in."), 401);
  }
}

export function handleLogout(c: Context, opts?: AuthOptions): Response {
  deleteCookie(c, opts?.cookieName ?? COOKIE, { path: "/" });
  return c.json({ ok: true });
}

/** POST /api/auth/logout-all — invalidate sessions on ALL devices, then clear this one.
 *  Note: rotateKey() rotates the module's persisted per-install key — the default signing secret.
 *  An adopter that injects its OWN `opts.secret` would rotate that out-of-band and override this. */
export function handleLogoutAll(c: Context, opts?: AuthOptions): Response {
  rotateKey();
  deleteCookie(c, opts?.cookieName ?? COOKIE, { path: "/" });
  deleteCookie(c, opts?.localCookieName ?? LOCAL_COOKIE, { path: "/" });
  return c.json({ ok: true });
}

/**
 * OPTIONAL API Bearer token check. Validates `Authorization: Bearer <token>` against the owner's
 * minted `apiToken`, constant-time. OFF BY DEFAULT: when `apiToken` is unset/empty this ALWAYS
 * returns false — so an unconfigured daemon never matches a bearer header and auth behaves exactly
 * as OIDC-only (zero behavior change). The token is a separate, LOCAL credential (never touches
 * connections.icu); it lets a remote/headless agent authenticate over the tunnel. The host passes
 * its own token (RepoYeti: `cfg.apiToken`), keeping this decoupled from the full config shape.
 */
export function validBearerToken(c: Context, apiToken?: string): boolean {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  // UNSET ⇒ never matches ⇒ no behavior change.
  if (!apiToken) return false;
  // timingSafeEqual throws on a length mismatch, so length-guard first (a length-only side channel
  // is acceptable here, and unsign() in this file uses the same pattern). Compare over UTF-8 bytes.
  if (Buffer.byteLength(presented) !== Buffer.byteLength(apiToken)) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(apiToken));
}

/**
 * The share behind this request — but ONLY if the caller isn't the owner by some other means.
 *
 * This is what handlers must use, NOT `readGuestShare()` directly. The difference is the whole
 * "owner always wins" rule, and getting it wrong is not theoretical: a share cookie ends up in the
 * OWNER's browser the moment they click their own link to check it, which is the first thing
 * anyone does after minting one. `readGuestShare()` only asks "is there a share cookie?", so every
 * handler that projects on it — /api/repos, /api/status, /api/auth/status, the SSE filter — would
 * quietly serve the owner a guest's narrowed view of their own machine: repos they own vanishing
 * from their own dashboard, settings blanked. It denies rather than grants, so it was never a
 * security hole; it just looked exactly like data loss.
 *
 * The ordering below mirrors authMiddleware's decision tree exactly, and must keep mirroring it:
 * the gate and the projections have to agree on who the caller is, or the UI contradicts the
 * permissions.
 */
export function effectiveGuest(c: Context, cfg: RepoYetiConfig): Share | null {
  if (!authEnforced(cfg)) return null; // no OIDC at all → loopback-only, everyone is the owner
  if (readSession(c, cfg.oauth!)) return null; // signed-in owner
  if (validBearerToken(c, cfg.apiToken)) return null; // owner's API token
  if (!isRemoteRequest(c)) {
    if (accessMode(cfg) !== "remote") return null; // local mode → open on this machine
    if (hasLocalBypass(c)) return null; // "Continue local for now" → the owner, at their desk
  }
  return readGuestShare(c);
}

/**
 * The guest gate: decide whether a share-link holder may make THIS request.
 *
 * Split out of authMiddleware so the owner's decision tree below stays readable and so this can be
 * unit-tested directly. Reached only after every owner check has already failed, so it can never
 * widen owner access — it only ever admits a caller who would otherwise have received a flat 401.
 *
 * Default-deny: an unmatched route is refused. See share/policy.ts for why that's the whole design.
 */
async function guestGate(
  c: Context,
  share: Share,
  method: string,
  path: string,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  const mutating = method !== "GET" && method !== "HEAD";
  const deny = (status: 403 | 404, repoId: string | null): Response => {
    // Log every refusal, mutating or not: a guest probing the surface is what the owner would want
    // to see. That's only true while refusals stay RARE, which is a property of the client, not of
    // this line — the dashboard's boot sequence originally fetched a dozen owner-only endpoints
    // unconditionally, so every guest page load wrote ~10 "denied" rows and buried the one entry
    // the owner opens this trail to find ("did my brother push that?"). The PWA now skips what a
    // guest is designed to be refused (see web store loadAll + AppShell), so a denial here means
    // something genuinely went looking. Keep it that way: if you add an owner-only fetch to the
    // boot path, gate it on isGuest.
    logShareEvent(share.id, `${method} ${path}`, repoId, "denied");
    return c.body(null, status);
  };

  const match = policyFor(method, path);
  if (!match) return deny(403, null); // not on the allowlist ⇒ owner-only
  if (!permSatisfies(share.perm, match.policy.need)) return deny(403, null); // view link, control route

  let repoId: string | null = null;
  if (match.policy.scoped) {
    repoId = match.params.id ?? null;
    // 404, not 403: a repo outside the share must be indistinguishable from one that doesn't
    // exist. 403 would confirm "this repo is real, you just can't have it".
    if (!repoId || !shareCoversRepo(share, repoId)) return deny(404, repoId);
  }

  if (mutating) logShareEvent(share.id, `${method} ${path}`, repoId, "allowed");
  // `await next(); return undefined` rather than `return next()`: it keeps this function's return
  // type free of `void` (which biome flags inside a union), and Response|undefined is assignable
  // to the middleware's Promise<Response | void> either way.
  await next();
  return undefined;
}

/** Middleware gating /api/*. The invariants:
 *  - No OIDC client at all (bare test configs) → fully open.
 *  - A request over the tunnel ALWAYS requires a signed-in owner (or a valid API Bearer token),
 *    in any mode — or, failing that, a live share-link cookie limited to that share's policy.
 *  - A local (loopback) request: open in "local" mode; in "remote" mode it needs either an
 *    owner session, the local bypass ("Continue local for now"), or a valid API Bearer token.
 *  Public endpoints (health + the status probes the gate itself relies on) always pass.
 *
 *  On share links (see src/share/): the guest branch is deliberately LAST in each arm, so the
 *  owner always wins when both credentials are present, and a guest can only ever reach routes
 *  named in share/policy.ts's allowlist, on repos their share covers. Nothing above this comment
 *  changed when share links were added — the guest path is purely additive, and with no shares
 *  minted, readGuestShare() returns null and the gate behaves exactly as it always has. */
export function authMiddleware(cfg: RepoYetiConfig) {
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` is load-bearing — the pass-through branches `return next()` (Promise<void>); narrowing to `undefined` breaks that.
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (!authEnforced(cfg)) return next();
    const path = new URL(c.req.url).pathname;
    // Public: health + the probes the gate itself relies on. continue-local is here too —
    // it self-guards on loopback, so it must be reachable from the (otherwise-gated) gate.
    // /api/auth/status and /api/auth/me are safe to leave open: both only ECHO the caller's own
    // verified cookie (readSession), so an anonymous caller gets nulls, not the owner's identity.
    //
    // /api/status is NOT in this list, though it used to be. It returns the full settings dump
    // (tunnel config, MCP rails, auto-commit schedule, editor, version), and being public meant any
    // caller who merely knew the tunnel URL could read all of it — contradicting the documented
    // threat model ("Hit any endpoint → 401, empty body: no surface, no version, no repo data",
    // docs/ARCHITECTURE.md §7). Nothing needed it open: the PWA only calls it AFTER the auth gate
    // passes (AppShell.vue returns at the sign-in screen before loadAll()), and local callers are
    // unaffected because loopback requests never reach this branch in local mode.
    if (
      path === "/api/auth/status" ||
      path === "/api/auth/me" ||
      path === "/api/health" ||
      path === "/api/auth/continue-local" ||
      path === "/api/openapi.json"
    ) {
      return next();
    }

    if (isRemoteRequest(c)) {
      // Over-the-tunnel: owner session required (or a valid API Bearer token, when configured).
      if (readSession(c, cfg.oauth!) || validBearerToken(c, cfg.apiToken)) return next();
      const share = readGuestShare(c);
      if (share) return guestGate(c, share, c.req.method, path, next);
      return c.body(null, 401);
    }
    // Local request.
    if (accessMode(cfg) !== "remote") return next(); // local mode → open on this machine
    if (readSession(c, cfg.oauth!) || hasLocalBypass(c) || validBearerToken(c, cfg.apiToken)) return next();
    // A share link opened on the owner's own machine (loopback) is still just a guest.
    const share = readGuestShare(c);
    if (share) return guestGate(c, share, c.req.method, path, next);
    return c.body(null, 401);
  };
}
