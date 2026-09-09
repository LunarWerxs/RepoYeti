import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { pathWithin } from "../../paths.ts";
import { getRepos, getSharedRepos, listIgnoredPaths } from "../../db.ts";
import { effectiveGuest } from "../../auth.ts";
import { guestRepoView } from "../../share/redact.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "../../contract.ts";
import { parseBody, CloneSchema, ReorderSchema, RestorePathSchema } from "../../schemas.ts";
import {
  registerRepo,
  createRepo,
  cloneRepo,
  reorderRepos,
  startFetchAllJob,
  cancelFetchAll,
  fetchAllState,
  isFetchingAll,
  cleanupMissingRepos,
  restoreIgnoredPath,
} from "../../service/index.ts";
import { repoFromPath, looksLikeGitUrl, deriveCloneName } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // ── repos ────────────────────────────────────────────────────────────────
  // getRepos() is unfiltered by design — it's the owner's dashboard. A share link must instead
  // see ONLY its own repos, so this is the one read that branches on the principal. (The gate
  // can't do it: scope enforcement there works by matching a repo id in the path, and this route
  // has none — the whole list IS the response.)
  app.get("/api/repos", (c) => {
    const share = effectiveGuest(c, cfg);
    if (share) return c.json({ repos: getSharedRepos(share).map(guestRepoView) });
    return c.json({ repos: getRepos() });
  });

  // "Point to Folder" (register existing) + "Create New" (git init).
  app.post("/api/repos/register", repoFromPath(registerRepo));
  app.post("/api/repos/create", repoFromPath(createRepo));

  // Clone a remote into a folder under a scan root. Validated hard (URL scheme, target name,
  // and parent-under-root) before any git runs; the SSH key is injected per-op in cloneRepo.
  app.post("/api/repos/clone", async (c) => {
    const p = await parseBody(c, CloneSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeGitUrl(url)) return jsonError(c, "BAD_REQUEST", "not a recognizable git URL");
    const parentAbs = resolve(p.data.parentPath.trim());
    try {
      if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
        return jsonError(c, "BAD_REQUEST", "destination folder does not exist");
      }
    } catch {
      return jsonError(c, "BAD_REQUEST", "destination folder is not accessible");
    }
    if (!cfg.roots.some((r) => pathWithin(resolve(r), parentAbs))) {
      return jsonError(c, "BAD_REQUEST", "destination must be inside a scan folder");
    }
    const name = (p.data.name?.trim() || deriveCloneName(url));
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      return jsonError(c, "BAD_REQUEST", "invalid target folder name");
    }
    if (existsSync(join(parentAbs, name))) {
      return jsonError(c, "EXISTS", "a folder with that name already exists");
    }
    const result = await cloneRepo(parentAbs, name, url, p.data.identityId || null);
    if (result.ok) return c.json(result, 201);
    return c.json(result, statusForCode(result.code as ApiErrorCode));
  });

  // Persist a drag-to-reorder of the repo list. Body: { order: string[] } (repo ids).
  app.post("/api/repos/reorder", async (c) => {
    const p = await parseBody(c, ReorderSchema);
    if (!p.ok) return p.res;
    reorderRepos(p.data.order);
    return c.json({ ok: true });
  });

  // ── fetch-all, as a job ───────────────────────────────────────────────────────
  // Fire-and-forget, the same shape as POST /api/scan: the response only acknowledges that the
  // pass started, and the counters + summary arrive over SSE (fetch_all_started →
  // fetch_all_progress → fetch_all_done | fetch_all_cancelled). It used to await the whole sweep
  // and return the summary inline, which on a large installation or a stalled credential helper
  // was a lengthy opaque request with nothing to show and no way to stop it (1.0 audit item 24).
  app.post("/api/repos/fetch-all", (c) => {
    if (isFetchingAll()) return c.json({ ok: true, started: false, ...fetchAllState() });
    // Errors surface over SSE, not in this response. The counters are already populated by the
    // time this line runs: an async function body executes synchronously up to its first await,
    // and the job installs its opening state before the first repository is touched. A client
    // that misses them anyway is not stranded, because `fetch_all_started` carries the same.
    void startFetchAllJob().catch(() => {});
    return c.json({ ok: true, started: true, ...fetchAllState() });
  });
  // Stop the in-flight pass. The repository being fetched right now is allowed to finish; only
  // the ones after it are dropped (see service/fetch-all.ts).
  app.post("/api/repos/fetch-all/cancel", (c) => c.json({ ok: true, cancelled: cancelFetchAll() }));
  // What the run is doing right now, or what the last one did. The lifecycle streams over SSE and
  // the daemon has no event replay, so a phone that backgrounded mid-sweep has nothing to
  // reconcile against without this — and unlike the scan's status route it answers with the
  // counters too, so the phone can show the result it missed rather than only "not running".
  app.get("/api/repos/fetch-all", (c) => c.json({ ok: true, ...fetchAllState() }));

  // Remove every repo entry (any source) whose local path no longer exists on disk.
  app.post("/api/repos/cleanup-missing", (c) => c.json({ ok: true, removed: cleanupMissingRepos() }));

  // ── removed ("don't show me this again") paths ────────────────────────────────
  // The undo surface for DELETE /api/repos/:id. Without a way back, a mis-click would be
  // permanent-feeling: the repo is gone from the list and every rescan deliberately refuses to
  // re-add it, with nothing on screen explaining why.
  app.get("/api/repos/ignored", (c) => c.json({ paths: listIgnoredPaths() }));

  app.post("/api/repos/ignored/restore", async (c) => {
    const p = await parseBody(c, RestorePathSchema);
    if (!p.ok) return p.res;
    const result = await restoreIgnoredPath(p.data.absPath);
    if (!result.ok) return c.json(result, statusForCode(result.code as ApiErrorCode));
    return c.json(result);
  });
}
