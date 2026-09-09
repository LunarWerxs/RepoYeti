/**
 * ⭐ Agent Safety Rail dashboard routes: list pending MCP approvals, read one in full, and
 * approve/deny one. These are ordinary owner-facing HTTP routes (gated by the normal /api/* auth
 * middleware, same as every other route) — they are NOT the MCP gate itself (that's
 * src/mcp/core.ts's contextFor wrapping src/approvals.ts's requestApproval). This module only ever
 * reads or resolves an ALREADY-pending request.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { listPending, pendingRequest, approve, deny } from "../../approvals.ts";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/approvals", (c) => c.json({ approvals: listPending() }));

  // The full request behind one pending approval: tool + arguments, bounded and with
  // secret-looking fields hidden (approvals.ts boundedArgs). The list and SSE carry only an
  // 80-character summary; this is what the owner expands before deciding. 404 once resolved.
  app.get("/api/approvals/:id", (c) => {
    const id = c.req.param("id") ?? "";
    const entry = pendingRequest(id);
    if (!entry) return jsonError(c, "NOT_FOUND", "no pending approval with that id");
    return c.json(entry);
  });

  app.post("/api/approvals/:id/approve", (c) => {
    const id = c.req.param("id") ?? "";
    if (!approve(id)) return jsonError(c, "NOT_FOUND", "no pending approval with that id");
    return c.json({ ok: true });
  });

  app.post("/api/approvals/:id/deny", (c) => {
    const id = c.req.param("id") ?? "";
    if (!deny(id)) return jsonError(c, "NOT_FOUND", "no pending approval with that id");
    return c.json({ ok: true });
  });
}
