import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { getLog, getActivity, getCommit, getIncoming, fetchRepo } from "../../service/index.ts";
import { normalizeActivityScale } from "../../read/activity.ts";
import { incomingError } from "../../read/incoming.ts";
import { withRepo } from "../respond.ts";

function refScope(value: string | undefined): "head" | "local" | "all" | undefined {
  return value === "all" || value === "local" || value === "head" ? value : undefined;
}

export function register(app: Hono, _deps: Deps): void {
  // ── commit history (read-only, paginated) ────────────────────────────────────
  app.get("/api/repos/:id/log", (c) =>
    withRepo(c, async (id) => {
      const limit = Number(c.req.query("limit"));
      const skip = Number(c.req.query("skip"));
      // ?merges=only → just merge commits · ?merges=exclude → drop them · absent → all.
      const m = c.req.query("merges");
      const merges = m === "only" || m === "exclude" ? m : undefined;
      // ?refs=head (default, current branch) · local (all local branches+tags) · all (+remotes).
      // The graph view's branch-scope toggle drives this; anything else falls back to head-only.
      const author = {
        name: c.req.query("authorName") ?? "",
        email: c.req.query("authorEmail") ?? "",
      };
      return c.json(
        await getLog(
          id,
          Number.isFinite(limit) ? limit : undefined,
          Number.isFinite(skip) ? skip : undefined,
          merges,
          refScope(c.req.query("refs")),
          author.name.trim() || author.email.trim() ? author : undefined,
        ),
      );
    }),
  );

  // One server-side snapshot for the History activity strip. This is deliberately separate from
  // the paginated log: a busy repo can have far more than the first 50 rows in the selected range.
  app.get("/api/repos/:id/activity", (c) =>
    withRepo(c, async (id) =>
      c.json(
        await getActivity(
          id,
          refScope(c.req.query("refs")),
          normalizeActivityScale(c.req.query("scale")),
        ),
      ),
    ),
  );

  // One commit's detail (changed files + bounded diff) — the History "tap a commit" view.
  app.get("/api/repos/:id/commit/:hash", (c) =>
    withRepo(c, async (id) => c.json(await getCommit(id, c.req.param("hash")))),
  );

  // ── "what would a pull do?" (read-only) ──────────────────────────────────────
  // Everything this reports comes from objects a fetch has already downloaded, so with
  // ?fetch=1 (what the Preview Pull button sends) we fetch FIRST and then describe. Without
  // that the answer would silently reflect whenever the last background sync happened, which
  // for a preview is worse than useless: it would show "nothing incoming" on a stale ref.
  // The fetch is the only side effect, and fetch never touches the working tree.
  app.get("/api/repos/:id/incoming", (c) =>
    withRepo(c, async (id) => {
      if (c.req.query("fetch") === "1") {
        // Never present stale remote-tracking refs as if a requested fresh preview succeeded.
        // Network/auth failures are resolved ActionOutcomes, not throws, so both paths matter.
        try {
          const fetched = await fetchRepo(id);
          if (!fetched.ok) return c.json(incomingError(fetched.message || "fetch failed"));
        } catch (error) {
          return c.json(
            incomingError(
              (error instanceof Error ? error.message : String(error)) || "fetch failed",
            ),
          );
        }
      }
      return c.json(await getIncoming(id));
    }),
  );
}
