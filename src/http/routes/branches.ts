import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { statusForCode } from "../../contract.ts";
import { parseBody, CheckoutSchema, CreateBranchSchema, DeleteBranchSchema } from "../../schemas.ts";
import {
  checkoutRepo,
  createBranchRepo,
  deleteBranchRepo,
  getBranches,
} from "../../service/index.ts";
import { requireId, withRepo } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── branches (list / switch / create / delete) ───────────────────────────────
  app.get("/api/repos/:id/branches", (c) => withRepo(c, async (id) => c.json(await getBranches(id))));
  app.post("/api/repos/:id/checkout", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CheckoutSchema);
    if (!p.ok) return p.res;
    const r = await checkoutRepo(id, p.data.branch.trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/branch", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, CreateBranchSchema);
    if (!p.ok) return p.res;
    const r = await createBranchRepo(id, p.data.name.trim(), p.data.switch !== false);
    return c.json(r, r.ok ? 201 : statusForCode(r.code));
  });
  app.delete("/api/repos/:id/branch", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, DeleteBranchSchema);
    if (!p.ok) return p.res;
    const r = await deleteBranchRepo(id, p.data.name.trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
}
