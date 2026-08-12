import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { parseBody, CheckoutSchema, CreateBranchSchema, DeleteBranchSchema } from "../../schemas.ts";
import {
  checkoutRepo,
  createBranchRepo,
  deleteBranchRepo,
  getBranches,
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
}
