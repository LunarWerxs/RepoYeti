import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { getLog, getCommit } from "../../service/index.ts";
import { withRepo } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── commit history (read-only, paginated) ────────────────────────────────────
  app.get("/api/repos/:id/log", (c) =>
    withRepo(c, async (id) => {
      const limit = Number(c.req.query("limit"));
      const skip = Number(c.req.query("skip"));
      // ?merges=only → just merge commits · ?merges=exclude → drop them · absent → all.
      const m = c.req.query("merges");
      const merges = m === "only" || m === "exclude" ? m : undefined;
      return c.json(
        await getLog(
          id,
          Number.isFinite(limit) ? limit : undefined,
          Number.isFinite(skip) ? skip : undefined,
          merges,
        ),
      );
    }),
  );

  // One commit's detail (changed files + bounded diff) — the History "tap a commit" view.
  app.get("/api/repos/:id/commit/:hash", (c) =>
    withRepo(c, async (id) => c.json(await getCommit(id, c.req.param("hash")))),
  );
}
