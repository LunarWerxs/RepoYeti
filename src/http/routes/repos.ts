import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { pathWithin } from "../../paths.ts";
import type { RepoYetiConfig } from "../../config.ts";
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

type CloneBody = z.infer<typeof CloneSchema>;

/** A clone request that has passed every check: the folder it goes into, its name, and the remote. */
interface CloneTarget {
  parentAbs: string;
  name: string;
  url: string;
  identityId: string | null;
}

type CloneTargetResult = { ok: true; target: CloneTarget } | { ok: false; res: Response };

/** Why `parentAbs` cannot receive a clone, or null when it can. */
function destinationProblem(parentAbs: string, cfg: RepoYetiConfig): string | null {
  try {
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) return "destination folder does not exist";
  } catch {
    return "destination folder is not accessible";
  }
  if (!cfg.roots.some((r) => pathWithin(resolve(r), parentAbs))) {
    return "destination must be inside a scan folder";
  }
  return null;
}

/** A name safe to create a folder with: no separators, no traversal, not the current directory. */
const isValidFolderName = (name: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";

/**
 * Validate a clone body against the URL scheme, the filesystem and the scan roots, before any git
 * runs. Returns the resolved target, or the refusal to hand straight back to the client.
 */
function resolveCloneTarget(c: Context, body: CloneBody, cfg: RepoYetiConfig): CloneTargetResult {
  const url = body.url.trim();
  if (!looksLikeGitUrl(url)) return { ok: false, res: jsonError(c, "BAD_REQUEST", "not a recognizable git URL") };
  const parentAbs = resolve(body.parentPath.trim());
  const problem = destinationProblem(parentAbs, cfg);
  if (problem) return { ok: false, res: jsonError(c, "BAD_REQUEST", problem) };
  const name = body.name?.trim() || deriveCloneName(url);
  if (!isValidFolderName(name)) {
    return { ok: false, res: jsonError(c, "BAD_REQUEST", "invalid target folder name") };
  }
  if (existsSync(join(parentAbs, name))) {
    return { ok: false, res: jsonError(c, "EXISTS", "a folder with that name already exists") };
  }
  return { ok: true, target: { parentAbs, name, url, identityId: body.identityId || null } };
}

/**
 * GET /api/repos. getRepos() is unfiltered by design — it's the owner's dashboard. A share link
 * must instead see ONLY its own repos, so this is the one read that branches on the principal. (The
 * gate can't do it: scope enforcement there works by matching a repo id in the path, and this route
 * has none — the whole list IS the response.)
 */
function listReposResponse(c: Context, cfg: RepoYetiConfig): Response {
  const share = effectiveGuest(c, cfg);
  if (share) return c.json({ repos: getSharedRepos(share).map(guestRepoView) });
  return c.json({ repos: getRepos() });
}

/**
 * POST /api/repos/fetch-all. Fire-and-forget, the same shape as POST /api/scan: the response only
 * acknowledges that the pass started, and the counters + summary arrive over SSE (fetch_all_started
 * → fetch_all_progress → fetch_all_done | fetch_all_cancelled). It used to await the whole sweep and
 * return the summary inline, which on a large installation or a stalled credential helper was a
 * lengthy opaque request with nothing to show and no way to stop it (1.0 audit item 24).
 */
function startFetchAllResponse(c: Context): Response {
  if (isFetchingAll()) return c.json({ ok: true, started: false, ...fetchAllState() });
  // Errors surface over SSE, not in this response. The counters are already populated by the time
  // this line runs: an async function body executes synchronously up to its first await, and the
  // job installs its opening state before the first repository is touched. A client that misses
  // them anyway is not stranded, because `fetch_all_started` carries the same.
  void startFetchAllJob().catch(() => {});
  return c.json({ ok: true, started: true, ...fetchAllState() });
}

/** POST /api/repos/ignored/restore — the undo surface for DELETE /api/repos/:id. */
async function restoreIgnoredPathResponse(c: Context): Promise<Response> {
  const p = await parseBody(c, RestorePathSchema);
  if (!p.ok) return p.res;
  const result = await restoreIgnoredPath(p.data.absPath);
  if (!result.ok) return c.json(result, statusForCode(result.code as ApiErrorCode));
  return c.json(result);
}

/** Clone a remote into a validated folder under a scan root. The SSH key is injected per-op. */
async function handleClone(c: Context, cfg: RepoYetiConfig): Promise<Response> {
  const p = await parseBody(c, CloneSchema);
  if (!p.ok) return p.res;
  const resolved = resolveCloneTarget(c, p.data, cfg);
  if (!resolved.ok) return resolved.res;
  const { parentAbs, name, url, identityId } = resolved.target;
  const result = await cloneRepo(parentAbs, name, url, identityId);
  if (result.ok) return c.json(result, 201);
  return c.json(result, statusForCode(result.code as ApiErrorCode));
}

export function register(app: Hono, { cfg }: Deps): void {
  // ── repos ────────────────────────────────────────────────────────────────
  app.get("/api/repos", (c) => listReposResponse(c, cfg));

  // "Point to Folder" (register existing) + "Create New" (git init).
  app.post("/api/repos/register", repoFromPath(registerRepo));
  app.post("/api/repos/create", repoFromPath(createRepo));

  // Clone a remote into a folder under a scan root. Validated hard (URL scheme, target name,
  // and parent-under-root) before any git runs; the SSH key is injected per-op in cloneRepo.
  app.post("/api/repos/clone", (c) => handleClone(c, cfg));

  // Persist a drag-to-reorder of the repo list. Body: { order: string[] } (repo ids).
  app.post("/api/repos/reorder", async (c) => {
    const p = await parseBody(c, ReorderSchema);
    if (!p.ok) return p.res;
    reorderRepos(p.data.order);
    return c.json({ ok: true });
  });

  // ── fetch-all, as a job ───────────────────────────────────────────────────────
  app.post("/api/repos/fetch-all", (c) => startFetchAllResponse(c));
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

  app.post("/api/repos/ignored/restore", (c) => restoreIgnoredPathResponse(c));
}
