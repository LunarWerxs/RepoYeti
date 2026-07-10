import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.ts";
import { isRemoteRequest } from "../../auth.ts";
import { detectEditors, effectiveDefaultEditor, openInEditor } from "../../service/index.ts";
import { requireId } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // The "Open with…" editor catalogue for this machine: every known editor with an `available`
  // flag (detected via PATH + known install paths), the platform, and the currently-effective
  // default. Read-only + cheap — the file viewer loads it to populate its dropdown + Settings.
  app.get("/api/editors", (c) => {
    const editors = detectEditors();
    return c.json({
      ok: true,
      platform: process.platform,
      // The stored preference (may be undefined / unavailable) AND the resolved effective id, so
      // the UI can show the picker's value and the button's real target without re-deriving it.
      defaultEditor: cfg.defaultEditor ?? null,
      effectiveDefault: effectiveDefaultEditor(cfg.defaultEditor, editors),
      editors,
    });
  });

  // Launch a repo folder (and optionally one changed file) in an external editor. The editor runs
  // on the DAEMON'S machine, so this is loopback-only — a request over the tunnel can't pop a
  // window on the desktop and shouldn't be able to spawn a process there. `editor` omitted ⇒ the
  // owner's default; `path` omitted ⇒ open the folder alone. Path is confined to the repo inside
  // openInEditor.
  app.post("/api/repos/:id/open", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    if (isRemoteRequest(c)) {
      return c.json(
        { ok: false, code: "REMOTE_FORBIDDEN", message: "opening an editor is only available locally" },
        403,
      );
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const editor = typeof b.editor === "string" ? b.editor : undefined;
    const path = typeof b.path === "string" ? b.path : undefined;
    const result = await openInEditor(id, editor, path, { defaultEditor: cfg.defaultEditor });
    if (result.ok) return c.json(result);
    const status: ContentfulStatusCode =
      result.code === "NOT_FOUND"
        ? 404
        : result.code === "BAD_PATH" || result.code === "NO_EDITOR"
          ? 400
          : 500;
    return c.json(result, status);
  });
}
