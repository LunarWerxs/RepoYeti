import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "../../contract.ts";
import { parseBody, DiscardSchema, DeleteFileSchema, StageSchema, GitignoreAddSchema } from "../../schemas.ts";
import {
  discardFile,
  deleteFile,
  stageFile,
  addToGitignore,
  getChanges,
  searchChangedContent,
  readFileContent,
  readImagePreview,
  readBinaryPreview,
  readFileDiff,
  readCommitFile,
  readCommitImagePreview,
  readCommitBinaryPreview,
  writeFileContent,
  moveFile,
  forceRefresh,
} from "../../service/index.ts";
import { requireId, remoteEditingBlocked } from "../respond.ts";

type ImageResult = Awaited<ReturnType<typeof readImagePreview>>;

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(value: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size === 0) return "invalid";
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw) return "invalid";
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  )
    return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function previewResponse(result: ImageResult, rangeHeader?: string): Response {
  if (!result.ok || !result.bytes || !result.contentType) {
    let status = 400;
    if (result.code === "NOT_FOUND") status = 404;
    else if (result.code === "TOO_LARGE") status = 413;
    else if (result.code === "UNSUPPORTED") status = 415;
    return Response.json(result, { status });
  }
  const { bytes } = result;
  const range = parseRange(rangeHeader, bytes.byteLength);
  const baseHeaders: Record<string, string> = {
    "content-type": result.contentType,
    "cache-control": "private, no-store",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  if (result.contentType === "image/svg+xml") {
    Object.assign(baseHeaders, {
      // SVGs often rely on inline <style>, but stay inert: image context disables scripting and
      // external loads, while this response policy also protects a direct navigation to the URL.
      "content-security-policy":
        "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox",
    });
  }
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${bytes.byteLength}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? bytes.byteLength - 1;
  const body = bytes.buffer.slice(
    bytes.byteOffset + start,
    bytes.byteOffset + end + 1,
  ) as ArrayBuffer;
  const headers: Record<string, string> = {
    ...baseHeaders,
    "content-length": String(body.byteLength),
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${bytes.byteLength}`;
  return new Response(body, {
    status: range ? 206 : 200,
    headers,
  });
}

type DocumentMediaKind = "pdf" | "audio" | "video";
function documentMediaKind(value: string | undefined): DocumentMediaKind | null {
  return value === "pdf" || value === "audio" || value === "video" ? value : null;
}

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
    const preview = c.req.query("preview");
    if (preview === "image") {
      return previewResponse(await readImagePreview(id, path, ref), c.req.header("range"));
    }
    const mediaKind = documentMediaKind(preview);
    if (mediaKind) {
      return previewResponse(
        await readBinaryPreview(id, path, mediaKind, ref),
        c.req.header("range"),
      );
    }
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
    const preview = c.req.query("preview");
    if (preview === "image") {
      return previewResponse(
        await readCommitImagePreview(id, c.req.param("hash"), c.req.query("path") ?? ""),
        c.req.header("range"),
      );
    }
    const mediaKind = documentMediaKind(preview);
    if (mediaKind) {
      return previewResponse(
        await readCommitBinaryPreview(
          id,
          c.req.param("hash"),
          c.req.query("path") ?? "",
          mediaKind,
        ),
        c.req.header("range"),
      );
    }
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

  // Delete one file from disk outright (the changes-tree "Delete" action). Supersedes discard
  // for the "I just wanna delete it" case — no restore semantics, and a tracked file's removal
  // is staged too. Destructive → same remote-editing gate as discard.
  // `recursive: true` extends this to a whole FOLDER (opt-in — see DeleteFileSchema); the
  // response gains `deleted` (files actually removed) so the UI can toast a real count instead
  // of a vague "deleted the folder".
  app.post("/api/repos/:id/delete-file", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const blocked = remoteEditingBlocked(c, cfg);
    if (blocked) return blocked;
    const p = await parseBody(c, DeleteFileSchema);
    if (!p.ok) return p.res;
    const result = await deleteFile(id, p.data.path, p.data.recursive);
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode = result.code === "NOT_FOUND" ? 404 : statusForCode(result.code as ApiErrorCode);
    return c.json(result, status);
  });

  // Stage one changed file's working-tree change into the index (the changes-tree per-file
  // "Stage" action, GitHub-Desktop-style). Non-destructive — no remote-editing gate needed
  // (unlike discard/write/move, it can't lose data), but still local-mutation so it goes
  // through the same op-queue + refresh as every other mutating route.
  app.post("/api/repos/:id/stage", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, StageSchema);
    if (!p.ok) return p.res;
    const result = await stageFile(id, p.data.path);
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode = result.code === "NOT_FOUND" ? 404 : statusForCode(result.code as ApiErrorCode);
    return c.json(result, status);
  });

  // Append a path to the repo's .gitignore (the changes-tree "Add to .gitignore" action). Mutating
  // (writes .gitignore) → same remote-editing gate as file writes/discard/move. The path is
  // normalised + confined to the repo inside addToGitignore.
  app.post("/api/repos/:id/gitignore", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const blocked = remoteEditingBlocked(c, cfg);
    if (blocked) return blocked;
    const p = await parseBody(c, GitignoreAddSchema);
    if (!p.ok) return p.res;
    const result = await addToGitignore(id, p.data.path);
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode =
      result.code === "NOT_FOUND" ? 404 : result.code === "UNSUPPORTED" ? 400 : statusForCode(result.code as ApiErrorCode);
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
