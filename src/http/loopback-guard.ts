/**
 * Cross-site request guard for the loopback API (ported from ccmanagerui's server/src/loopback-guard.ts).
 *
 * THE THREAT (classic local-daemon CSRF, e.g. the Jupyter/Selenium/dev-server CVE class): this
 * daemon binds 127.0.0.1, and in LOCAL mode (no OIDC configured) its /api/* surface is
 * UNAUTHENTICATED by design — a single-user tool on the owner's machine. But "loopback + no auth"
 * is NOT private: a browser will happily let ANY web page the owner visits send requests to
 * http://127.0.0.1:<port>. Without a guard, a malicious page could POST /api/repos/:id/remote,
 * /api/repos/clone, a commit + push, a checkout, etc. and drive the real `git` CLI with the owner's
 * credentials and SSH keys — a drive-by remote code execution / repo-tamper. A cross-site GET could
 * also exfiltrate the repo list and settings.
 *
 * THE DEFENSE (no tokens, no client changes, robust to the "simple request" bypass): the browser
 * itself stamps the request's provenance in headers page JS CANNOT forge:
 *   · `Sec-Fetch-Site` — the browser sets this on every fetch/navigation. A page on another site
 *     gets `cross-site`; our own PWA gets `same-origin`; the dev PWA (Vite :5173 → the daemon) gets
 *     `same-site`. It is a Forbidden header — page script cannot override it. Reject `cross-site`.
 *   · `Origin` — present on all cross-origin requests (including a "simple" text/plain POST that
 *     skips CORS preflight, which is exactly how a naive CORS-only fix gets bypassed). If it's
 *     present and its host isn't loopback, reject. This ALSO stops DNS-rebinding (evil.com → A
 *     record 127.0.0.1: the page's Origin is still evil.com).
 *   · `Host` — reject a Host header that isn't loopback (a second DNS-rebinding backstop).
 * A request with NONE of these browser markers (curl, the tray's health probe, an MCP client, the
 * single-instance probe) is NOT a browser-CSRF vector and is allowed — those are same-machine tools
 * the owner ran deliberately, and a local attacker who can run curl already owns the session.
 *
 * ── RepoYeti-specific: the tunnel path ──
 * Unlike ccmanagerui, RepoYeti can ALSO be exposed remotely over a Cloudflare tunnel, where the
 * daemon's public Host/Origin is legitimately NON-loopback (app.repoyeti.com / a cloudflared URL).
 * A blanket loopback-only guard would 403 every tunneled request. That path does not need this
 * guard: a tunnel request is already CSRF-safe via the `SameSite=Lax` session cookie + the owner
 * auth gate (authMiddleware) — a cross-site page can neither forge the owner's session nor have the
 * browser attach it on a cross-site request. So this guard is wired to run ONLY on the local
 * (non-tunnel) path — the one that is open and therefore vulnerable. See src/http/app.ts for the
 * `isRemoteRequest`-gated wiring.
 *
 * This is deliberately a header-provenance check, NOT a CORS allowlist: CORS governs whether a
 * cross-origin response is READABLE, but the write-side CSRF damage is done the moment the request
 * is PROCESSED, regardless of whether the attacker can read the reply. Sec-Fetch-Site/Origin gate
 * the request itself.
 */
import type { MiddlewareHandler } from "hono";

/** Hostname is loopback (the only interface this daemon binds). Accepts IPv4/IPv6 loopback + the
 *  `localhost` name; strips a `:port` and IPv6 brackets first. */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // host may be "127.0.0.1:7171", "localhost:7171", "[::1]:7171"
  let host = hostHeader.trim().toLowerCase();
  // strip IPv6 brackets + port
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    host = close >= 0 ? host.slice(1, close) : host.slice(1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** The origin string (scheme://host[:port]) has a loopback host. For a CORS origin allowlist. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

/** The Origin header's host is loopback (or the header is absent — many legitimate same-origin
 *  requests omit it). A present, non-loopback Origin is a cross-site/rebinding request → block. */
function originIsLoopbackOrAbsent(originHeader: string | undefined): boolean {
  if (!originHeader || originHeader === "null") return originHeader !== "null"; // 'null' origin (sandboxed/file) is NOT trusted
  try {
    return isLoopbackHost(new URL(originHeader).host);
  } catch {
    return false; // unparseable Origin → treat as untrusted
  }
}

export interface LoopbackGuardResult {
  ok: boolean;
  reason?: string;
}

/** Pure decision function (exported for tests): should this request's headers be allowed? */
export function evaluateRequest(headers: {
  secFetchSite?: string;
  origin?: string;
  host?: string;
}): LoopbackGuardResult {
  // 1. Sec-Fetch-Site: a modern browser's unforgeable provenance signal. Only `cross-site` is a
  //    drive-by from another origin; `same-origin`/`same-site`/`none` are our PWA (or the dev PWA,
  //    or a top-level navigation the user typed). Absent → non-browser client, allowed.
  if (headers.secFetchSite && headers.secFetchSite.toLowerCase() === "cross-site") {
    return { ok: false, reason: "cross-site request rejected" };
  }
  // 2. Origin present but non-loopback → cross-origin write / DNS-rebinding, even without a
  //    Sec-Fetch-Site header (older browsers) or on a "simple" no-preflight POST.
  if (!originIsLoopbackOrAbsent(headers.origin)) {
    return { ok: false, reason: "non-loopback Origin rejected" };
  }
  // 3. A PRESENT Host must be loopback — the DNS-rebinding backstop (a browser rebinding
  //    evil.com → 127.0.0.1 sends Host: evil.com, and may omit Origin on a same-origin GET, so
  //    Host is the one signal left). An ABSENT Host is treated like an absent Origin: a real
  //    browser ALWAYS sends Host, so no-Host-at-all is a non-browser client (curl/tray/MCP/an
  //    HTTP tool) — not a browser-CSRF vector — and is allowed, consistent with rule 2.
  if (headers.host && !isLoopbackHost(headers.host)) {
    return { ok: false, reason: "non-loopback Host rejected" };
  }
  return { ok: true };
}

/** Hono middleware: apply to the loopback API surface. Blocks browser cross-site requests with 403;
 *  lets same-origin (PWA), same-site (dev), and non-browser (curl/tray/MCP) requests through. Wire
 *  it to run only on the local path — a genuine tunnel request is auth-gated instead (see app.ts). */
export const loopbackGuard: MiddlewareHandler = async (c, next) => {
  const verdict = evaluateRequest({
    secFetchSite: c.req.header("sec-fetch-site"),
    origin: c.req.header("origin"),
    host: c.req.header("host"),
  });
  if (!verdict.ok) {
    return c.json({ error: `forbidden: ${verdict.reason}` }, 403);
  }
  await next();
};
