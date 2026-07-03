import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { jsonError } from "../../contract.ts";
import { rescanMachine, rescanFolder, cancelScan, isScanning } from "../../service/index.ts";

export function register(app: Hono, _deps: Deps): void {
  // ── on-demand project scan (cancellable) ──────────────────────────────────────────
  // Body `{ path }` → scan just that folder; otherwise sweep the whole machine (every drive).
  // Fire-and-forget: repos + progress stream in over SSE (scan_started → scan_progress /
  // repo_added → scan_done | scan_cancelled). A second start while one runs is a no-op.
  app.post("/api/scan", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    if (rawPath) {
      const abs = resolve(rawPath);
      try {
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          return jsonError(c, "BAD_REQUEST", "folder does not exist or is not a directory");
        }
      } catch {
        return jsonError(c, "BAD_REQUEST", "folder is not accessible");
      }
      if (!isScanning()) void rescanFolder(abs).catch(() => {});
      return c.json({ ok: true, running: true, scope: "folder" });
    }
    if (!isScanning()) void rescanMachine().catch(() => {});
    return c.json({ ok: true, running: true, scope: "machine" });
  });
  // Stop the in-flight scan (the modal's X). Repos found so far stay indexed.
  app.post("/api/scan/cancel", (c) => c.json({ ok: true, cancelled: cancelScan() }));
}
