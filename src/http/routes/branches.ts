import type { Context, Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { getRepo } from "../../db.ts";
import { parseBody, CheckoutSchema, CreateBranchSchema, DeleteBranchSchema } from "../../schemas.ts";
import {
  checkoutRepo,
  createBranchRepo,
  deleteBranchRepo,
  getBranches,
  previewUndoRepo,
  undoRepo,
  redoRepo,
} from "../../service/index.ts";
import { requireId, withRepo, actionJson } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // ── branches (list / switch / create / delete) ───────────────────────────────
  app.get("/api/repos/:id/branches", (c) => withRepo(c, async (id) => c.json(await getBranches(id))));
  app.post("/api/repos/:id/checkout", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CheckoutSchema);
    if (!p.ok) return p.res;
    const r = await checkoutRepo(id, p.data.branch.trim());
    return actionJson(c, cfg, r);
  });
  app.post("/api/repos/:id/branch", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CreateBranchSchema);
    if (!p.ok) return p.res;
    const r = await createBranchRepo(id, p.data.name.trim(), p.data.switch !== false);
    return actionJson(c, cfg, r, 201);
  });
  app.delete("/api/repos/:id/branch", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, DeleteBranchSchema);
    if (!p.ok) return p.res;
    const r = await deleteBranchRepo(id, p.data.name.trim());
    return actionJson(c, cfg, r);
  });

  // ── reflog undo / redo of the last git action (git repos only) ───────────────
  // GET previews both directions so the dashboard can confirm the exact step before moving HEAD.
  const gitOnly = (c: Context): string | Response => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const repo = getRepo(id);
    if (!repo) return jsonError(c, "NOT_FOUND", "repo not found");
    if (repo.vcs !== "git") return jsonError(c, "BAD_REQUEST", "undo is only available for git repos");
    return id;
  };
  app.get("/api/repos/:id/undo", async (c) => {
    const id = gitOnly(c);
    if (id instanceof Response) return id;
    return c.json(await previewUndoRepo(id));
  });
  app.post("/api/repos/:id/undo", async (c) => {
    const id = gitOnly(c);
    if (id instanceof Response) return id;
    return actionJson(c, cfg, await undoRepo(id));
  });
  app.post("/api/repos/:id/redo", async (c) => {
    const id = gitOnly(c);
    if (id instanceof Response) return id;
    return actionJson(c, cfg, await redoRepo(id));
  });
}
