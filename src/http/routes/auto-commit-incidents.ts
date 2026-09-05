/**
 * Auto-commit incident review: the persisted counterpart to the repo_auto_commit_blocked /
 * repo_auto_committed SSE broadcasts (src/auto-commit.ts). A repo the unattended timer skipped,
 * or only partially synced, while nobody happened to be connected to the dashboard was, until
 * this, reviewable nowhere; these routes read/ack the reviewable log src/db.ts now keeps.
 */
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { listAutoCommitIncidents, countUnackedAutoCommitIncidents, ackAutoCommitIncident } from "../../db.ts";

export function register(app: Hono, _deps: Deps): void {
  app.get("/api/auto-commit/incidents", (c) => {
    const unackedOnly = c.req.query("unackedOnly") === "1";
    const rawLimit = c.req.query("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    return c.json({
      incidents: listAutoCommitIncidents({ limit: Number.isFinite(limit) ? limit : undefined, unackedOnly }),
      unacked: countUnackedAutoCommitIncidents(),
    });
  });

  app.post("/api/auto-commit/incidents/:id/ack", (c) => {
    const id = c.req.param("id") ?? "";
    if (!ackAutoCommitIncident(id)) return jsonError(c, "NOT_FOUND", "no auto-commit incident with that id");
    return c.json({ ok: true });
  });
}
