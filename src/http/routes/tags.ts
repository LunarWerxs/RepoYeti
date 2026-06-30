import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode } from "../../contract.ts";
import { parseBody, TagCreateSchema } from "../../schemas.ts";
import { getRepo } from "../../db.ts";
import { getTags, createTagRepo } from "../../service/index.ts";
import { withRepo } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── tags (read-only) ─────────────────────────────────────────────────────────
  app.get("/api/repos/:id/tags", (c) => withRepo(c, async (id) => c.json(await getTags(id))));
  // Create a tag (annotated when a message is given), optionally pushing it to origin.
  app.post("/api/repos/:id/tag", async (c) => {
    const id = c.req.param("id");
    const repo = getRepo(id);
    if (!repo) return jsonError(c, "NOT_FOUND", "repo not found");
    if (repo.vcs !== "git") return jsonError(c, "BAD_REQUEST", "tags are only available for git repos");
    const p = await parseBody(c, TagCreateSchema);
    if (!p.ok) return p.res;
    const r = await createTagRepo(id, p.data.name.trim(), p.data.message, p.data.push === true);
    return c.json(r, r.ok ? 201 : statusForCode(r.code));
  });
}
