/**
 * Shared route helpers extracted from the old monolithic daemon.ts. These were closures or
 * module-level functions inside createApp(); they're hoisted here so every route module can
 * reuse them without re-deriving the same id-parse / repo-guard / remote-editing-gate patterns.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jsonError, statusForCode } from "../contract.ts";
import { parseBody, RepoPathSchema } from "../schemas.ts";
import { getRepo } from "../db.ts";
import { isRemoteRequest } from "../auth.ts";
import type { RepoYetiConfig } from "../config.ts";
import type { ActionOutcome } from "../service/index.ts";

/** Parse the `:id` route param once, 400 if absent. Collapses the id-parse/guard pattern that
 * was repeated at ~20 route heads. Usage:  const id = requireId(c); if (id instanceof Response) return id; */
export const requireId = (c: Context): string | Response =>
  c.req.param("id") || jsonError(c, "BAD_REQUEST", "missing repo id");

/**
 * Read-route guard: resolve `:id`, 404 if the repo is unknown, else run `fn` with the id.
 * De-dupes the `const id = c.req.param("id"); if (!getRepo(id)) return jsonError(...NOT_FOUND...)`
 * pattern that headed every read route (branches/log/stashes/tags/changes…).
 */
export const withRepo = async (
  c: Context,
  fn: (id: string) => Promise<Response> | Response,
): Promise<Response> => {
  const id = c.req.param("id") ?? "";
  if (!getRepo(id)) return jsonError(c, "NOT_FOUND", "repo not found");
  return fn(id);
};

/** Safe git action wrapper: parse the id, run `fn(id)`, map the outcome's ok/code to a status. */
export const action = (fn: (id: string) => Promise<ActionOutcome>) => async (c: Context) => {
  const id = requireId(c);
  if (id instanceof Response) return id;
  const r = await fn(id);
  return c.json(r, r.ok ? 200 : statusForCode(r.code));
};

/** "Point to Folder" (register existing) + "Create New" (git init) body wrapper. */
export const repoFromPath =
  (handler: (path: string) => Promise<{ ok: boolean; code: string; message: string }>) =>
  async (c: Context) => {
    const p = await parseBody(c, RepoPathSchema);
    if (!p.ok) return p.res;
    const r = await handler(p.data.path);
    const status: ContentfulStatusCode = r.ok
      ? 201
      : r.code === "NOT_FOUND" || r.code === "NOT_A_REPO"
        ? 400
        : 409;
    return c.json(r, status);
  };

/**
 * The remote-editing 403 gate used by file-write + discard. Returns a 403 Response when the
 * request is remote AND the owner has turned remote editing off; otherwise null (proceed).
 */
export const remoteEditingBlocked = (c: Context, cfg: RepoYetiConfig): Response | null =>
  isRemoteRequest(c) && cfg.remoteEditing === false
    ? c.json(
        { ok: false, code: "EDIT_REMOTE_DISABLED", message: "editing over remote access is turned off" },
        403,
      )
    : null;

/** A conservative git-URL check: a known scheme, or the scp-like `user@host:path` form. Rejects
 *  a leading dash (flag injection) and bare local paths (which would dodge the root confinement). */
export function looksLikeGitUrl(u: string): boolean {
  if (!u || u.startsWith("-")) return false;
  if (/^(https?|ssh|git|file):\/\/.+/i.test(u)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/.test(u)) return true; // git@github.com:org/repo.git
  return false;
}

/** A Lore server/repo URL: a lore:// or http(s):// URL. Rejects a leading dash (flag injection). */
export function looksLikeLoreUrl(u: string): boolean {
  if (!u || u.startsWith("-")) return false;
  return /^(lore|https?):\/\/.+/i.test(u);
}

/** Derive a target folder name from a clone URL: last path segment, sans a trailing `.git`. */
export function deriveCloneName(url: string): string {
  const cleaned = url.replace(/[/\\]+$/, "");
  const seg = cleaned.split(/[/\\:]/).pop() ?? "repo";
  return seg.replace(/\.git$/i, "") || "repo";
}
