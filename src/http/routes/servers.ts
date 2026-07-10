import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { pathWithin } from "../../paths.ts";
import { saveConfig } from "../../config.ts";
import { jsonError, statusForCode, type ApiErrorCode } from "../../contract.ts";
import { parseBody, ServerAddSchema, ServerCloneSchema } from "../../schemas.ts";
import { cloneLoreRepo } from "../../service/index.ts";
import { looksLikeLoreUrl, deriveCloneName } from "../respond.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // ── lore servers (registry + clone-from-server) ──────────────────────────────
  // A registered Lore server is just a server-of-record URL + display name; auth is delegated
  // to the Lore CLI's own session (`lore login`), so NO credentials are stored here.
  app.get("/api/servers", (c) => c.json({ servers: cfg.servers ?? [] }));
  app.post("/api/servers", async (c) => {
    const p = await parseBody(c, ServerAddSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeLoreUrl(url)) return jsonError(c, "BAD_REQUEST", "expected a lore:// or https:// server URL");
    const server = { id: crypto.randomUUID(), name: p.data.name?.trim() || url, url };
    cfg.servers = [...(cfg.servers ?? []), server];
    saveConfig(cfg);
    return c.json({ ok: true, server, servers: cfg.servers }, 201);
  });
  app.delete("/api/servers/:id", (c) => {
    const id = c.req.param("id");
    cfg.servers = (cfg.servers ?? []).filter((s) => s.id !== id);
    saveConfig(cfg);
    return c.json({ ok: true, servers: cfg.servers });
  });
  // Clone a Lore repo from a server URL into a folder under a scan root (mirrors /api/repos/clone).
  app.post("/api/servers/clone", async (c) => {
    const p = await parseBody(c, ServerCloneSchema);
    if (!p.ok) return p.res;
    const url = p.data.url.trim();
    if (!looksLikeLoreUrl(url)) return jsonError(c, "BAD_REQUEST", "expected a lore:// or https:// server URL");
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
    const name = p.data.name?.trim() || deriveCloneName(url);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      return jsonError(c, "BAD_REQUEST", "invalid target folder name");
    }
    if (existsSync(join(parentAbs, name))) return jsonError(c, "EXISTS", "a folder with that name already exists");
    const result = await cloneLoreRepo(parentAbs, name, url);
    return result.ok ? c.json(result, 201) : c.json(result, statusForCode(result.code as ApiErrorCode));
  });
}
