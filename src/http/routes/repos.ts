import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { pathWithin } from "../../paths.ts";
import { getRepos } from "../../db.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "../../contract.ts";
import { parseBody, CloneSchema, ReorderSchema } from "../../schemas.ts";
import {
  registerRepo,
  createRepo,
  cloneRepo,
  reorderRepos,
  fetchAllRepos,
} from "../../service/index.ts";
import { repoFromPath, looksLikeGitUrl, deriveCloneName } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // ── repos ────────────────────────────────────────────────────────────────
  app.get("/api/repos", (c) => c.json({ repos: getRepos() }));

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

  // Fetch every repo that has a remote (bounded by the network gate). Returns a summary.
  app.post("/api/repos/fetch-all", async (c) => c.json(await fetchAllRepos()));
}
