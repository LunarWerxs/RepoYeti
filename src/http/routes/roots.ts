import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { saveConfig } from "../../config.ts";
import { jsonError } from "../../contract.ts";
import { parseBody, RootPathSchema } from "../../schemas.ts";
import { discoverRoot, forgetReposUnder } from "../../service/index.ts";

export function register(app: Hono, { cfg }: Deps): void {
  // ── scan roots (list / add / remove a discovery root from the dashboard) ─────
  app.get("/api/roots", (c) => c.json({ roots: cfg.roots }));
  app.post("/api/roots", async (c) => {
    const p = await parseBody(c, RootPathSchema);
    if (!p.ok) return p.res;
    const abs = resolve(p.data.path);
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return jsonError(c, "BAD_REQUEST", "path does not exist or is not a directory");
      }
    } catch {
      return jsonError(c, "BAD_REQUEST", "path is not accessible");
    }
    if (!cfg.roots.includes(abs)) {
      cfg.roots.push(abs);
      saveConfig(cfg);
    }
    // Discover in the background (a big root can take a while); repos stream in over SSE.
    void discoverRoot(abs, cfg.maxDepth, cfg.maxRepos).catch(() => {});
    return c.json({ ok: true, roots: cfg.roots });
  });
  app.delete("/api/roots", async (c) => {
    const p = await parseBody(c, RootPathSchema);
    if (!p.ok) return p.res;
    const abs = resolve(p.data.path);
    cfg.roots = cfg.roots.filter((r) => resolve(r) !== abs);
    saveConfig(cfg);
    const removed = forgetReposUnder(abs); // drop auto-discovered repos under it (live, over SSE)
    return c.json({ ok: true, roots: cfg.roots, removed });
  });
}
