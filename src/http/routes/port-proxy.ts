/**
 * The port proxy: `/proxy/<port>/...` forwards to `http://127.0.0.1:<port>/...` (HTTP and WebSocket),
 * behind the same owner sign-in as the dashboard.
 *
 * WHY: the daemon is often the only thing on this machine reachable from the phone (the tunnel), and
 * the repo you are looking at usually has a dev server running on some local port. This lets the
 * owner open that server through the one origin that already has a login in front of it, without
 * exposing each port. Idea from coder/code-server's path proxy (src/node/routes/pathProxy.ts, MIT),
 * written fresh for RepoYeti's auth model.
 *
 * The shape of it, and why each part is there:
 *  - OFF unless `portProxy` is on (config.json, or PUT /api/settings). A proxied page is served from the daemon's own
 *    origin, so its scripts can call /api/* with the owner's cookie like the dashboard does. That is
 *    fine for the owner's own dev server (its process already runs as the owner) and wrong for a port
 *    serving anything else, so the owner has to decide it once.
 *  - Owner only (auth.ts isOwnerRequest): a share-link guest never reaches another port, and with no
 *    OIDC client configured the proxy stays loopback-only. An anonymous browser page load is sent to
 *    the dashboard (which shows the sign-in); anything else gets a bare 401, like /api/*.
 *  - The daemon's own port is refused: a forwarded request arrives from 127.0.0.1 without the
 *    daemon's cookies and would be judged by the local-mode rules, not the caller's.
 *  - The daemon's cookies and the owner's API token are stripped before forwarding, and an upstream
 *    Set-Cookie can never overwrite them, so no owner credential reaches a process on another port.
 *  - The path prefix is stripped (the app sees `/`), so the app should use relative asset paths or a
 *    base of `/proxy/<port>/`, same as code-server's `/proxy/`. Redirects are rewritten to stay
 *    under the prefix, and `X-Forwarded-Prefix` tells the app where it lives.
 */
import type { Context, Hono } from "hono";
import type { Deps } from "../deps.ts";
import type { RepoYetiConfig } from "../../config.ts";
import { DAEMON_COOKIE_NAMES, isOwnerRequest, validBearerToken } from "../../auth.ts";
import { getServerPort } from "../../runtime.ts";

/** Headers that describe one connection, not the message: never forwarded in either direction. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** The WebSocket handshake headers the upstream client connection makes for itself. */
const WS_HANDSHAKE = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"];

/** Frames a client may send before the upstream socket opens; past this the proxy gives up. */
const MAX_PENDING_FRAMES = 1000;

/** What Bun keeps on each proxied browser socket (see portProxyWebSocket below). */
export interface PortProxySocketData {
  target: string;
  protocols: string[];
  headers: Record<string, string>;
  upstream?: WebSocket;
  pending: (string | Buffer)[];
}

type ProxyServer = Bun.Server<PortProxySocketData>;

/** The port a request asks for, or null when it is not a usable TCP port. */
export function parseProxyPort(raw: string | undefined): number | null {
  if (!raw || !/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/** The name of a `name=value` cookie pair (a Cookie header part or a Set-Cookie line). */
function cookieName(pair: string): string {
  const eq = pair.indexOf("=");
  return (eq < 0 ? pair : pair.slice(0, eq)).trim();
}

/** A Cookie header with the daemon's own cookies removed ("" when nothing is left). */
export function stripDaemonCookies(header: string | null | undefined): string {
  if (!header) return "";
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !DAEMON_COOKIE_NAMES.includes(cookieName(part)))
    .join("; ");
}

/** An upstream redirect target, moved under /proxy/<port> when it points back at that port. */
export function rewriteLocation(location: string, port: number): string {
  const prefix = `/proxy/${port}`;
  if (location.startsWith("/") && !location.startsWith("//")) return prefix + location;
  try {
    const u = new URL(location);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (loopback && u.port === String(port)) return `${prefix}${u.pathname}${u.search}${u.hash}`;
  } catch {
    // A relative location ("next/page") resolves against the proxied URL already.
  }
  return location;
}

/** The request headers the upstream sees: no hop-by-hop, no daemon credential, a loopback Origin. */
function upstreamHeaders(c: Context, cfg: RepoYetiConfig, port: number): Headers {
  const h = new Headers(c.req.raw.headers);
  for (const name of HOP_BY_HOP) h.delete(name);
  // fetch/WebSocket derive Host from the target URL. X-Forwarded-Host would make a framework's
  // own CSRF check (Next.js server actions compare it with Origin) see the tunnel host instead.
  h.delete("host");
  h.delete("x-forwarded-host");
  const cookie = stripDaemonCookies(h.get("cookie"));
  if (cookie) h.set("cookie", cookie);
  else h.delete("cookie");
  if (validBearerToken(c, cfg.apiToken)) h.delete("authorization");
  // The caller is already authenticated as the owner and CSRF-checked here, so the upstream sees the
  // origin it would see if the owner opened the port directly. Dev servers such as Vite refuse a
  // WebSocket whose Origin is not loopback, which would otherwise break hot reload over the tunnel.
  if (h.has("origin")) h.set("origin", `http://127.0.0.1:${port}`);
  h.set("x-forwarded-prefix", `/proxy/${port}`);
  return h;
}

/** The response headers the browser sees: no hop-by-hop, no daemon cookie, redirects kept inside. */
function downstreamHeaders(res: Response, port: number): Headers {
  const h = new Headers(res.headers);
  for (const name of HOP_BY_HOP) h.delete(name);
  h.delete("set-cookie");
  for (const cookie of res.headers.getSetCookie()) {
    if (!DAEMON_COOKIE_NAMES.includes(cookieName(cookie))) h.append("set-cookie", cookie);
  }
  const location = h.get("location");
  if (location) h.set("location", rewriteLocation(location, port));
  return h;
}

/** The refusal for a caller who is not the owner: a page load goes to the sign-in, the rest 401. */
function refuse(c: Context): Response {
  if ((c.req.header("accept") ?? "").includes("text/html")) return c.redirect("/");
  return c.body(null, 401);
}

async function proxy(c: Context, cfg: RepoYetiConfig): Promise<Response> {
  if (!isOwnerRequest(c, cfg)) return refuse(c);
  if (cfg.portProxy !== true) {
    return c.text('The port proxy is off. Turn it on with PUT /api/settings {"portProxy": true}.', 404);
  }
  const port = parseProxyPort(c.req.param("port"));
  if (port === null) return c.text("Not a TCP port.", 400);
  if (port === (getServerPort() || cfg.port)) return c.text("The port proxy cannot open RepoYeti itself.", 403);

  const url = new URL(c.req.url);
  const prefix = `/proxy/${port}`;
  // `/proxy/3000` alone: send the browser to `/proxy/3000/` so the app's relative URLs resolve.
  if (url.pathname === prefix) return c.redirect(`${prefix}/${url.search}`);
  const path = `${url.pathname.slice(prefix.length)}${url.search}`;
  const headers = upstreamHeaders(c, cfg, port);

  if ((c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
    // Hono hands Bun's server over as the env when Bun.serve runs app.fetch (cli/lifecycle.ts).
    const server = c.env as ProxyServer | undefined;
    if (typeof server?.upgrade !== "function") return c.text("WebSocket upgrade is not available here.", 501);
    const protocols = (c.req.header("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const name of WS_HANDSHAKE) headers.delete(name);
    const data: PortProxySocketData = {
      target: `ws://127.0.0.1:${port}${path}`,
      protocols,
      headers: Object.fromEntries(headers.entries()),
      pending: [],
    };
    // The browser drops a socket whose handshake does not echo one of its subprotocols. The real
    // choice is only known once the upstream answers, so offer the first, which is the one a dev
    // server's client (Vite's "vite-hmr", for one) asks for.
    const upgraded = server.upgrade(c.req.raw, {
      data,
      ...(protocols[0] ? { headers: { "sec-websocket-protocol": protocols[0] } } : {}),
    });
    return upgraded ? new Response(null) : c.text("WebSocket upgrade failed.", 400);
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
      // Pass the upstream's bytes through as they are: decompressing would leave Content-Encoding
      // and Content-Length describing a body the browser no longer receives.
      decompress: false,
    });
  } catch {
    return c.text(`Nothing answered on port ${port}.`, 502);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: downstreamHeaders(res, port) });
}

/**
 * Bun's WebSocket handler for proxied sockets: one upstream client socket per browser socket, frames
 * copied both ways, either side closing closes the other. Wired into Bun.serve in cli/lifecycle.ts.
 */
export const portProxyWebSocket: Bun.WebSocketHandler<PortProxySocketData> = {
  data: {} as PortProxySocketData,
  open(ws) {
    const d = ws.data;
    const upstream = new WebSocket(d.target, { headers: d.headers, protocols: d.protocols });
    upstream.binaryType = "arraybuffer";
    d.upstream = upstream;
    upstream.onopen = () => {
      for (const frame of d.pending.splice(0)) upstream.send(frame);
    };
    upstream.onmessage = (e) => {
      ws.send(e.data as string | ArrayBuffer);
    };
    // 1005 and 1006 describe a close without a frame and may not be sent; pass anything else on.
    upstream.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
    upstream.onerror = () => ws.close(1011, "upstream error");
  },
  message(ws, message) {
    const d = ws.data;
    if (d.upstream?.readyState === WebSocket.OPEN) {
      d.upstream.send(message);
      return;
    }
    if (d.pending.length >= MAX_PENDING_FRAMES) {
      ws.close(1013, "upstream not ready");
      return;
    }
    d.pending.push(message);
  },
  close(ws) {
    ws.data.upstream?.close();
  },
};

export function register(app: Hono, { cfg }: Deps): void {
  app.all("/proxy/:port", (c) => proxy(c, cfg));
  app.all("/proxy/:port/*", (c) => proxy(c, cfg));
}
