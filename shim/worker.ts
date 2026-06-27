/**
 * GitMob OAuth redirect shim — a Cloudflare Worker (~free, stable `*.workers.dev`).
 *
 * Why this exists: the daemon lives on a free, *rotating* quick-tunnel URL, but an
 * OAuth redirect URI must be a single *stable* registered URL. So we register THIS
 * worker as the redirect, and it bounces the login back to the daemon's current URL
 * (which the daemon stamped into the signed `state`). See MARCHING_ORDERS §7.
 *
 * Security: the `code` is PKCE-bound to the daemon's verifier (held server-side) and
 * single-use, so the shim only ever sees an unusable token. The daemon HMAC-verifies
 * `state` itself; the shim just reads the embedded origin and refuses to forward to
 * any host outside the allowed suffix list (no open redirect).
 *
 * Deploy: see shim/README.md (`wrangler deploy`). Register `https://<name>.workers.dev/cb`
 * as the GitMob app's redirect URI, and set ALLOWED_SUFFIXES if you use a custom tunnel.
 */
export interface Env {
  /** Comma-separated host suffixes the shim may bounce to. Default: trycloudflare. */
  ALLOWED_SUFFIXES?: string;
}

function page(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>GitMob sign-in</title><body style="margin:0;background:#0e0e12;color:#e6e6ea;` +
      `font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">` +
      `<div style="max-width:320px;text-align:center;padding:24px"><div style="font-size:38px">🔒</div>` +
      `<p style="color:#9a9aa6;line-height:1.5">${message}</p></div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return atob(b64);
}

function allowedSuffixes(env: Env): string[] {
  return (env.ALLOWED_SUFFIXES ?? ".trycloudflare.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function originAllowed(origin: string, env: Env): boolean {
  let host: string;
  let protocol: string;
  try {
    const u = new URL(origin);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1") return true; // loopback dev
  if (protocol !== "https:") return false; // anything public must be https
  return allowedSuffixes(env).some((suf) => host === suf.replace(/^\./, "") || host.endsWith(suf));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/cb") return new Response("gitmob auth shim", { status: 200 });

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return page("Missing authorization code.", 400);

    // state = base64url(json).hmac — read the json (daemon origin) WITHOUT verifying;
    // the daemon HMAC-verifies it on /oauth/finish. We only need the origin to bounce.
    let origin = "";
    try {
      const json = JSON.parse(b64urlDecode(state.split(".")[0] ?? ""));
      origin = String(json.o ?? "");
    } catch {
      return page("Malformed sign-in state.", 400);
    }
    if (!originAllowed(origin, env)) return page("This sign-in origin isn't allowed.", 403);

    const dest = new URL("/oauth/finish", origin);
    dest.searchParams.set("code", code);
    dest.searchParams.set("state", state);
    return Response.redirect(dest.toString(), 302);
  },
};
