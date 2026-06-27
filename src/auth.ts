/**
 * "Sign in with Connections" — public OIDC relying party (MARCHING_ORDERS §7).
 *
 * Stand-alone: GitMob only ever calls the IdP's PUBLIC OAuth URLs (discovered from
 * `<issuer>/.well-known/openid-configuration`) and verifies the returned id_token
 * with the IdP's PUBLIC JWKS (via `jose`). No shared secret, no IdP-repo coupling.
 *
 * Auth is ENFORCED on every /api/* route exactly when OIDC is configured (and it is
 * required before any tunnel is exposed). With no OIDC config the daemon is
 * local-only (127.0.0.1) and unauthenticated — safe because nothing can reach it.
 *
 * Flow (daemon-side PKCE; the phone never holds tokens):
 *   /oauth/login → authorize (redirect_uri = the fixed shim) with signed state that
 *   embeds this daemon's origin → IdP → shim 302s to <origin>/oauth/finish?code&state
 *   → token exchange → verify id_token (JWKS) → owner check → signed session cookie.
 * Path B (loopback) registers /oauth/callback as the redirect and skips the shim.
 */
import { randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { CONFIG_DIR, ensureConfigDir, authEnforced, type GitmobConfig, type OAuthConfig } from "./config.ts";

const COOKIE = "gm_session";
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const TX_TTL_MS = 10 * 60 * 1000;

export interface Session {
  sub: string;
  email: string;
  exp: number;
}

// ── signing key (persisted so sessions survive a restart) ──────────────────────
let KEY: Buffer | null = null;
function key(): Buffer {
  if (KEY) return KEY;
  ensureConfigDir();
  const p = join(CONFIG_DIR, "session.key");
  if (existsSync(p)) {
    KEY = Buffer.from(readFileSync(p, "utf8").trim(), "hex");
  } else {
    KEY = randomBytes(32);
    writeFileSync(p, KEY.toString("hex"), { mode: 0o600 });
  }
  return KEY;
}

function sign(payload: string): string {
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function unsign(token: string | undefined): string | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString();
}

// ── OIDC discovery + JWKS (cached) ─────────────────────────────────────────────
let discoveryCache: { issuer: string; doc: Record<string, string> } | null = null;
async function discover(issuer: string): Promise<Record<string, string>> {
  const iss = issuer.replace(/\/$/, "");
  if (discoveryCache?.issuer === iss) return discoveryCache.doc;
  const res = await fetch(`${iss}/.well-known/openid-configuration`);
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
const txs = new Map<string, { verifier: string; ts: number }>();
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
function gcTx(): void {
  const now = Date.now();
  for (const [k, v] of txs) if (now - v.ts > TX_TTL_MS) txs.delete(k);
}

function ownerMatches(o: OAuthConfig, sub: string, email: string): boolean {
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
function setSession(c: Context, s: Session): void {
  setCookie(c, COOKIE, sign(JSON.stringify(s)), {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}
export function readSession(c: Context, o: OAuthConfig): Session | null {
  const raw = unsign(getCookie(c, COOKIE));
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

// ── HTML for the auth-complete error page ──────────────────────────────────────
function errPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitMob — sign in</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="max-width:340px;text-align:center;padding:24px">
<div style="font-size:40px">🔒</div>
<h2 style="margin:12px 0 8px">Can't sign you in</h2>
<p style="color:#9a9aa6;font-size:14px;line-height:1.5">${message}</p>
<a href="/oauth/login" style="display:inline-block;margin-top:14px;background:#3ddc84;color:#06210f;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:9px">Try again</a>
</div></body>`;
}

// ── handlers ────────────────────────────────────────────────────────────────────
export async function handleLogin(c: Context, cfg: GitmobConfig): Promise<Response> {
  const o = cfg.oauth!;
  const doc = await discover(o.issuer);
  const { verifier, challenge } = pkce();
  const nonce = randomBytes(16).toString("base64url");
  txs.set(nonce, { verifier, ts: Date.now() });
  gcTx();
  const origin = publicOrigin(c);
  const state = sign(JSON.stringify({ n: nonce, o: origin }));
  const url = new URL(doc.authorization_endpoint!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("scope", o.scopes || "openid profile email");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

/** Shared by /oauth/finish (shim bounce) and /oauth/callback (loopback). */
export async function handleComplete(c: Context, cfg: GitmobConfig): Promise<Response> {
  const o = cfg.oauth!;
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.html(errPage("Missing authorization code."), 400);

  const sp = unsign(state);
  if (!sp) return c.html(errPage("Invalid or tampered sign-in state."), 400);
  let nonce: string;
  try {
    nonce = JSON.parse(sp).n as string;
  } catch {
    return c.html(errPage("Invalid sign-in state."), 400);
  }
  const tx = txs.get(nonce);
  if (!tx) return c.html(errPage("This sign-in link expired. Start again."), 400);
  txs.delete(nonce);

  try {
    const doc = await discover(o.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      code_verifier: tx.verifier,
    });
    if (o.clientSecret) body.set("client_secret", o.clientSecret);
    const tr = await fetch(doc.token_endpoint!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tr.ok) return c.html(errPage("Token exchange with Connections failed."), 502);
    const tok = (await tr.json()) as { id_token?: string };
    if (!tok.id_token) return c.html(errPage("Connections returned no identity token."), 502);

    const { payload } = await jwtVerify(tok.id_token, jwks(doc.jwks_uri!), {
      issuer: o.issuer.replace(/\/$/, ""),
      audience: o.clientId,
    });
    const sub = String(payload.sub ?? "");
    const email = String((payload as { email?: string }).email ?? "");
    if (!ownerMatches(o, sub, email)) {
      return c.html(errPage("This Connections account isn't the owner of this GitMob."), 403);
    }
    setSession(c, { sub, email, exp: Date.now() + SESSION_TTL_MS });
    return c.redirect("/");
  } catch {
    return c.html(errPage("Couldn't verify your Connections sign-in."), 401);
  }
}

export function handleLogout(c: Context): Response {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
}

/** Middleware: gate /api/* on a valid owner session when auth is enforced. */
export function authMiddleware(cfg: GitmobConfig) {
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (!authEnforced(cfg)) return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/api/auth/status" || path === "/api/health") return next();
    if (!readSession(c, cfg.oauth!)) return c.body(null, 401);
    return next();
  };
}
