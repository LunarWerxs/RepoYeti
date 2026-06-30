/**
 * In-process MCP endpoint (Streamable HTTP): POST /api/mcp.
 *
 * One JSON-RPC 2.0 message in, one JSON response out (plain JSON — NOT WebSockets/SSE). Mounted
 * at /api/mcp so the existing /api/* auth middleware gates it automatically: open on loopback,
 * owner/token-required over the tunnel (see app.ts). Because the request already reached THIS
 * daemon, it dispatches against the in-process serviceBackend — no HTTP loopback.
 *
 * A notification (no `id`) produces no JSON-RPC response → we return 202 Accepted with no body.
 * An unparseable body is handled by core.ts as a JSON-RPC parse error.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { handleRpc, parseErrorResponse } from "../../mcp/core.ts";
import { serviceBackend } from "../../mcp/adapter-service.ts";

export function register(app: Hono, _deps: Deps): void {
  app.post("/api/mcp", async (c) => {
    let msg: unknown = null;
    let parsed = true;
    try {
      msg = await c.req.json();
    } catch {
      parsed = false;
    }
    // A body that isn't JSON at all → a JSON-RPC -32700 parse error (id null).
    if (!parsed) return c.json(parseErrorResponse());
    const res = await handleRpc(msg, serviceBackend());
    return res ? c.json(res) : c.body(null, 202);
  });
}
