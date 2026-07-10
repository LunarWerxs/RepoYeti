import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { parseBody, AssignIdentitySchema } from "../../schemas.ts";
import {
  getRepo,
  getIdentity,
  setRepoIdentity,
  setRepoAccount,
  setRepoHidden,
  setRepoPinned,
  setRepoStarred,
  setRepoAutoCommit,
} from "../../db.ts";
import { broadcast } from "../../bus.ts";
import { withRepo } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── assign identity to a repo ──────────────────────────────────────────────
  app.post("/api/repos/:id/identity", (c) =>
    withRepo(c, async (repoId) => {
      const p = await parseBody(c, AssignIdentitySchema);
      if (!p.ok) return p.res;
      const identityId = p.data.identityId || null;
      if (identityId && !getIdentity(identityId)) return jsonError(c, "NOT_FOUND", "identity not found");
      setRepoIdentity(repoId, identityId);
      broadcast("repo_identity_changed", { id: repoId, identityId });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );

  // ── pin a GitHub "sync account" to a repo (the account its fetch/pull/push auth as) ──
  app.post("/api/repos/:id/account", (c) =>
    withRepo(c, async (repoId) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const login = typeof b.login === "string" && b.login.trim() ? b.login.trim() : null;
      const host = typeof b.host === "string" && b.host.trim() ? b.host.trim() : null;
      setRepoAccount(repoId, host, login);
      broadcast("repo_account_changed", {
        id: repoId,
        syncAccountHost: login ? host || "github.com" : null,
        syncAccountLogin: login,
      });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );

  // ── hide / unhide a repo from the dashboard (display-only) ───────────────────
  app.post("/api/repos/:id/hidden", (c) =>
    withRepo(c, async (repoId) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const hidden = b.hidden === true;
      setRepoHidden(repoId, hidden);
      broadcast("repo_hidden_changed", { id: repoId, hidden });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );

  // ── pin / unpin a repo (moves it into the "Pinned" section; display-only) ────
  app.post("/api/repos/:id/pinned", (c) =>
    withRepo(c, async (repoId) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const pinned = b.pinned === true;
      setRepoPinned(repoId, pinned);
      broadcast("repo_pinned_changed", { id: repoId, pinned });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );

  // ── star / unstar a repo (moves it into the "Starred" section; display-only) ──
  app.post("/api/repos/:id/starred", (c) =>
    withRepo(c, async (repoId) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const starred = b.starred === true;
      setRepoStarred(repoId, starred);
      broadcast("repo_starred_changed", { id: repoId, starred });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );

  // ── opt a repo in/out of the auto-commit timer (see src/auto-commit.ts) ──────
  app.post("/api/repos/:id/auto-commit", (c) =>
    withRepo(c, async (repoId) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const autoCommit = b.autoCommit === true;
      setRepoAutoCommit(repoId, autoCommit);
      broadcast("repo_auto_commit_changed", { id: repoId, autoCommit });
      return c.json({ ok: true, repo: getRepo(repoId) });
    }),
  );
}
