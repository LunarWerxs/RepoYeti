import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "../../contract.ts";
import { parseBody, DiscardSchema } from "../../schemas.ts";
import {
  discardFile,
  getChanges,
  searchChangedContent,
  readFileContent,
  readFileDiff,
  readCommitFile,
  writeFileContent,
  moveFile,
  forceRefresh,
} from "../../service/index.ts";
import { requireId, remoteEditingBlocked } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  app.get("/api/repos/:id/changes", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const result = await getChanges(id);
    if (result.ok)
      return c.json({ files: result.files ?? [], total: result.total, truncated: result.truncated });
    return jsonError(c, result.code as ApiErrorCode, result.message ?? "could not read changes");
  });

  // Read one changed file's contents for the read-only viewer drawer. Path is a query
  // param (?path=…); it's normalised + confined to the repo in readFileContent.
  app.get("/api/repos/:id/file", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const path = c.req.query("path") ?? "";
    const ref = c.req.query("ref") === "head" ? "head" : "work";
    const result = await readFileContent(id, path, ref);
    if (result.ok) return c.json(result);
    // A bad/escaping path is a client error (400), not a 500; a missing repo/file is 404.
    return c.json(result, result.code === "NOT_FOUND" ? 404 : 400);
  });

  // Content search across the repo's CHANGED files (the changes tree only shows those).
  // Drives the "Search content" toggle; returns the matching repo-relative paths.
  app.get("/api/repos/:id/search", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const result = await searchChangedContent(id, c.req.query("q") ?? "");
    if (result.ok) return c.json({ paths: result.paths ?? [] });
    return jsonError(c, result.code as ApiErrorCode, result.message ?? "search failed");
  });

  // Both sides (HEAD + working tree) of a changed file, for the viewer's Diff tab.
  app.get("/api/repos/:id/diff", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const path = c.req.query("path") ?? "";
    const result = await readFileDiff(id, path);
    if (result.ok) return c.json(result);
    return c.json(result, result.code === "NOT_FOUND" ? 404 : 400);
  });

  // A file's two sides AT ONE COMMIT (first-parent ↔ commit), for opening a history file in the
  // Monaco viewer. `:hash` is a path param, the file path is ?path=… (confined in readCommitFile).
  app.get("/api/repos/:id/commit/:hash/file", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const result = await readCommitFile(id, c.req.param("hash"), c.req.query("path") ?? "");
    if (result.ok) return c.json(result);
    return c.json(result, result.code === "NOT_FOUND" ? 404 : 400);
  });

  // Save an edited file back to the working tree (the viewer's Edit mode). Same /api/* auth
  // gate as every other mutation; the path is confined to the repo inside writeFileContent.
  app.put("/api/repos/:id/file", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing repo id" }, 400);
    const blocked = remoteEditingBlocked(c, cfg);
    if (blocked) return blocked;
    const path = c.req.query("path") ?? "";
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.content !== "string") {
      return c.json({ ok: false, code: "NO_CONTENT", message: "content (string) is required" }, 400);
    }
    const result = await writeFileContent(id, path, b.content);
    if (!result.ok) {
      const status: ContentfulStatusCode =
        result.code === "NOT_FOUND" ? 404 : result.code === "TOO_LARGE" ? 413 : 400;
      return c.json(result, status);
    }
    await forceRefresh(id); // re-stat the repo so the change list + badges update right away
    return c.json(result);
  });

  // Discard one changed file's working-tree changes (the changes-tree "Discard" action).
  // Destructive → gated behind the same remote-editing toggle as file writes (loopback always allowed).
  app.post("/api/repos/:id/discard", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const blocked = remoteEditingBlocked(c, cfg);
    if (blocked) return blocked;
    const p = await parseBody(c, DiscardSchema);
    if (!p.ok) return p.res;
    const result = await discardFile(id, p.data.path);
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode = result.code === "NOT_FOUND" ? 404 : statusForCode(result.code as ApiErrorCode);
    return c.json(result, status);
  });

  // Move a changed file into another folder (the changes-tree drag-and-drop). Mutating (renames
  // on disk / stages a git rename) → same remote-editing gate as file writes/discard. Both the
  // source and the computed destination are normalised + confined to the repo inside moveFile.
  app.post("/api/repos/:id/move", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const blocked = remoteEditingBlocked(c, cfg);
    if (blocked) return blocked;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.from !== "string" || typeof b.toDir !== "string") {
      return c.json({ ok: false, code: "ERROR", message: "from and toDir (strings) are required" }, 400);
    }
    const result = await moveFile(id, b.from, b.toDir);
    if (!result.ok) {
      const status: ContentfulStatusCode =
        result.code === "NOT_FOUND" ? 404 : result.code === "EXISTS" ? 409 : 400;
      return c.json(result, status);
    }
    await forceRefresh(id); // re-stat so the change list reflects the move right away
    return c.json(result);
  });
}
