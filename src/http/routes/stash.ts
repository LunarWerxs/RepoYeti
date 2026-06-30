import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { statusForCode } from "../../contract.ts";
import { parseBody, StashSaveSchema, StashRefSchema } from "../../schemas.ts";
import {
  stashSaveRepo,
  stashPopRepo,
  stashDropRepo,
  getStashes,
} from "../../service/index.ts";
import { requireId, withRepo } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── stash (list / save / pop / drop) ─────────────────────────────────────────
  app.get("/api/repos/:id/stashes", (c) => withRepo(c, async (id) => c.json(await getStashes(id))));
  app.post("/api/repos/:id/stash", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, StashSaveSchema);
    if (!p.ok) return p.res;
    const r = await stashSaveRepo(id, p.data.message);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/stash/pop", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, StashRefSchema);
    if (!p.ok) return p.res;
    const r = await stashPopRepo(id, p.data.index ?? 0);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.post("/api/repos/:id/stash/drop", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, StashRefSchema);
    if (!p.ok) return p.res;
    const r = await stashDropRepo(id, p.data.index ?? 0);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
}
