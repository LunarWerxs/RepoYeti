import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode } from "../../contract.ts";
import { parseBody, CommitSchema, CommitSelectedSchema, SmartCommitSchema } from "../../schemas.ts";
import {
  fetchRepo,
  pullRepo,
  pushRepo,
  commitRepo,
  commitSelectedRepo,
  smartCommitRepo,
  forceRefresh,
} from "../../service/index.ts";
import { action, requireId } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── safe git actions ───────────────────────────────────────────────────────
  app.post("/api/repos/:id/fetch", action(fetchRepo));
  app.post("/api/repos/:id/pull", action(pullRepo));
  app.post("/api/repos/:id/push", action(pushRepo));
  app.post("/api/repos/:id/commit", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CommitSchema);
    if (!p.ok) return p.res;
    const message = (p.data.message ?? "").trim();
    if (!message) return jsonError(c, "NO_MESSAGE", "commit message required");
    const r = await commitRepo(id, message, p.data.amend === true);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  // Per-file staging: commit ONLY the selected paths in one ordinary commit (Smart Commit does this
  // per-group internally; this exposes it for a single commit). Anything unselected stays pending.
  app.post("/api/repos/:id/commit-selected", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CommitSelectedSchema);
    if (!p.ok) return p.res;
    const message = (p.data.message ?? "").trim();
    if (!message) return jsonError(c, "NO_MESSAGE", "commit message required");
    const r = await commitSelectedRepo(id, message, p.data.paths);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  // Smart commit: execute an (owner-edited) multi-commit plan — stage each group's files and
  // commit it in order, optionally syncing after. The body is validated against the live tree
  // in the service layer (PLAN_STALE / PLAN_PATHS_INVALID). See docs/ARCHITECTURE.md §14 (Smart Commit).
  app.post("/api/repos/:id/smart-commit", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, SmartCommitSchema);
    if (!p.ok) return p.res;
    const r = await smartCommitRepo(id, p.data.commits, p.data.sync === true);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });

  app.post("/api/repos/:id/refresh", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const repo = await forceRefresh(id);
    return repo ? c.json({ repo }) : jsonError(c, "NOT_FOUND", "repo not found");
  });
}
