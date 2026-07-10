/**
 * ⭐ Agent Safety Rail dashboard routes: list pending MCP approvals + approve/deny one. These are
 * ordinary owner-facing HTTP routes (gated by the normal /api/* auth middleware, same as every
 * other route) — they are NOT the MCP gate itself (that's src/mcp/core.ts's contextFor wrapping
 * src/approvals.ts's requestApproval). This module only ever resolves an ALREADY-pending request.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { listPending, approve, deny } from "../../approvals.ts";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/approvals", (c) => c.json({ approvals: listPending() }));

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
