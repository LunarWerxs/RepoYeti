import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError, statusForCode } from "../../contract.ts";
import { parseBody, RemoteSetSchema, RemoteDeleteSchema } from "../../schemas.ts";
import { setRemoteRepo, removeRemoteRepo } from "../../service/index.ts";
import { requireId, looksLikeGitUrl } from "../respond.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── remote (set-url / add-or-update origin, remove) — local config, no network ──
  app.post("/api/repos/:id/remote", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, RemoteSetSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeGitUrl(url)) return jsonError(c, "BAD_REQUEST", "not a recognizable git URL");
    const r = await setRemoteRepo(id, (p.data.name || "origin").trim(), url);
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
  app.delete("/api/repos/:id/remote", async (c) => {
    const id = requireId(c);
    if (id instanceof Response) return id;
    const p = await parseBody(c, RemoteDeleteSchema);
    if (!p.ok) return p.res;
    const r = await removeRemoteRepo(id, (p.data.name || "origin").trim());
    return c.json(r, r.ok ? 200 : statusForCode(r.code));
  });
}
