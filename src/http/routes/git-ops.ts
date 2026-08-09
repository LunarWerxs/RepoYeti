import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode } from "../../contract.ts";
import { parseBody, CommitSchema, CommitSelectedSchema, SmartCommitSchema } from "../../schemas.ts";
import {
  fetchRepo,
  pullRepo,
  pushRepo,
  commitRepo,
  commitRepoWithFingerprint,
  commitSelectedRepo,
  smartCommitRepo,
  forceRefresh,
} from "../../service/index.ts";
import { action, requireId } from "../respond.ts";
import { effectiveGuest } from "../../auth.ts";
import { guestRepoView } from "../../share/redact.ts";

export function register(app: Hono, { cfg }: Deps): void {
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
    const amend = p.data.amend === true;
    // A share-link guest may commit, but NOT amend. The gate (src/share/policy.ts) works on the
    // route, and "commit" and "amend" are the same route — so this one distinction has to be drawn
    // here, on the body. It matters: amend REWRITES the previous commit, which may be the owner's
    // own work that the guest never authored and cannot see the intent of. That's history editing,
    // not the "commit and sync my tree" the control tier was granted for. Plain commits are always
    // additive and always recoverable; an amend is neither.
    if (amend && effectiveGuest(c, cfg)) {
      return jsonError(c, "FORBIDDEN", "a share link can commit, but cannot amend", 403);
    }
    const r = p.data.expectedFingerprint
      ? await commitRepoWithFingerprint(id, message, p.data.expectedFingerprint)
      : await commitRepo(id, message, amend);
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

  // The one guest-reachable route that returns a whole repo record. It MUST project through
  // guestRepoView the way GET /api/repos does (routes/repos.ts): the raw RepoView carries the
  // owner's identityId, sync account, hidden/autoCommit flags, and the UNREDACTED remote URL —
  // which, per share/redact.ts, routinely embeds a PAT (`https://user:ghp_…@github.com/…`).
  // Shipping that to a "view"-tier link holder handed out the owner's push credential.
  app.post("/api/repos/:id/refresh", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const repo = await forceRefresh(id);
    if (!repo) return jsonError(c, "NOT_FOUND", "repo not found");
    return c.json({ repo: effectiveGuest(c, cfg) ? guestRepoView(repo) : repo });
  });
}
